// QuadPlanet for one Earth, as the game sees it (what `Entropy.QuadPlanet` was, ported from
// QuadPlanet's mod.rs and quadplanet_ops.rs): terrain chunks streamed around the viewer, the
// OpenStreetMap city on top, the ground queries the simulation needs, and place search.
//
// Streaming runs in the Earth worker (earth_worker.ts), as it ran on the engine's threads: this
// side sends it the viewer each frame and hands the renderer (engine/terrain.ts) the chunks and
// city tiles it made, in order, so a stale chunk only goes once its replacements are in. Ground
// queries (sample, normal, landing sites) answer from this thread's own elevation pyramid, which
// never waits on the network; building and road queries from a copy of the live city tiles.

import { type V3, distance, dirToLatLon, normalize } from "./math";
import { DEFAULT_MAX_ZOOM, ElevationSource, Lookup, TERRARIUM_URL, type ElevationStats, type Tile, type TileId, decodeTerrarium, httpTerrarium } from "./elevation";
import { Planet } from "./planet";
import type { ChunkNode } from "./quadtree";
import type { StreamStats } from "./streamer";
import type { ChunkMesh } from "./chunk_mesh";
import type { BuiltTile, CityConfig, CityStats, LiveTile, Placement, RoadLine } from "./city";
import type { OsmSettlement } from "./osm";
import { Geocoder, type Place } from "./geo";
import { fetchCached } from "./net";
import type { EarthWorkerIn, EarthWorkerOut, WorkerChunk } from "./earth_worker";
import type { PlanetDef } from "../qp_planet";
import type { CityBuilding } from "../qp_city";

/** The shader's texture noise repeats every this many meters (qp_shader.ts TEX_PERIOD). */
export const TEX_PERIOD = 1024;

export interface EarthConfig {
    planet: PlanetDef;
    /** The zoom-0 elevation tile (decoded); see loadBaseTile. */
    baseTile: Tile;
    splitFactor?: number;
    minLevel?: number;
    triangleBudget?: number;
    geocoderUrl?: string;
    city?: CityConfig;
}

export interface EarthSample {
    terrain: number; surface: number; sea: boolean; rock: number; patch: number;
    /** Distance from the planet's center to the drawn surface. */
    radius: number;
    lat: number; lon: number;
}

export interface EarthStats extends StreamStats {
    city: CityStats | null;
    settlements: OsmSettlement[];
}

/** A chunk made: its mesh, and its texture origin. */
export interface CreatedChunk { key: string; node: ChunkNode; mesh: ChunkMesh; texOrigin: V3 }

export interface EarthUpdate {
    stats: EarthStats;
    chunks: { created: CreatedChunk[]; destroyed: string[] };
    city: { created: [TileId, BuiltTile][]; destroyed: [TileId, LiveTile][] };
}

/** Loads and decodes the bundled zoom-0 elevation tile. */
export async function loadBaseTile(url: string): Promise<Tile> {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    return decodeTerrarium(await res.blob());
}

const tileName = (id: TileId) => `${id.z}/${id.x}/${id.y}`;

export class EarthSystem {
    readonly planet: Planet;
    readonly elevation: ElevationSource;
    readonly geocoder: Geocoder;
    readonly hasCity: boolean;
    private worker: Worker;
    /** Worker results not yet handed out, in order. */
    private inbox: Extract<EarthWorkerOut, { type: "update" }>[] = [];
    /** The live city tiles, as the worker last reported them. */
    private liveTiles = new Map<string, [TileId, LiveTile]>();
    private stats: StreamStats = { live: 0, wanted: 0, pending: 1, waitingForData: 0, hidden: 0, balanced: 0, stitched: 0, built: 0, destroyed: 0, deepest: [0], perPlanet: [0], triangles: 0, splitFactor: 0, buildMs: 0 };
    private cityStats: CityStats | null = null;
    private cityBusy = true;
    workerElevation: ElevationStats | null = null;
    cityErrors: string[] = [];
    lastError: string | null = null;
    private epoch = 0;
    private lastViewer: V3 | null = null;
    private lastUnlimited = false;
    private settlements: OsmSettlement[] = [];
    /** Chunks handed out per call at most (GPU uploads per frame), unless the budget is unlimited. */
    private readonly cityEnabled: boolean;

    constructor(readonly config: EarthConfig) {
        const def = config.planet;
        const t = def.terrain?.kind === "earth" ? def.terrain : null;
        const offline = !!t?.offline;
        this.elevation = new ElevationSource(config.baseTile, offline ? null : httpTerrarium(t?.tileUrl ?? TERRARIUM_URL, fetchCached), t?.maxZoom ?? DEFAULT_MAX_ZOOM, def.radius, 256);
        this.planet = new Planet(def, this.elevation);
        this.geocoder = new Geocoder(config.geocoderUrl);
        this.cityEnabled = config.city?.enabled !== false && !offline;
        this.hasCity = this.cityEnabled;
        this.worker = new Worker(new URL("./earth_worker.ts", import.meta.url), { type: "module", name: "earth" });
        this.worker.onmessage = (e: MessageEvent<EarthWorkerOut>) => {
            const m = e.data;
            if (m.type === "error") { this.lastError = m.message; return; }
            if (m.epoch !== this.epoch) return;
            this.inbox.push(m);
        };
        this.worker.onerror = e => { this.lastError = e.message; };
        const base = config.baseTile.heights.slice();
        this.post({ type: "init", base, config: { planet: def, splitFactor: config.splitFactor, minLevel: config.minLevel, triangleBudget: config.triangleBudget, city: config.city } }, [base.buffer]);
    }

    private post(m: EarthWorkerIn, transfer: Transferable[] = []): void { this.worker.postMessage(m, transfer); }

    /** The chunk's origin relative to its planet, wrapped into the texture noise's period. */
    texOrigin(origin: V3): V3 {
        const c = this.planet.def.center;
        const w = (k: number) => { const x = origin[k] - c[k]; return x - TEX_PERIOD * Math.floor(x / TEX_PERIOD); };
        return [w(0), w(1), w(2)];
    }

    /**
     * Tells the worker where the viewer is and hands out what it has made since: at most
     * `maxBuilds` chunks (a frame's GPU uploads; Infinity hands out everything, as loading screens
     * and fixed-step runs want). A stale chunk is only dropped once every chunk made before it is
     * handed out, so streaming never opens a hole.
     */
    update(viewer: V3, options: { maxBuilds?: number; unlimited?: boolean } = {}): EarthUpdate {
        const unlimited = !!options.unlimited;
        if (!this.lastViewer || distance(this.lastViewer, viewer) > 0.05 || unlimited !== this.lastUnlimited) {
            this.post({ type: "viewer", viewer, unlimited });
            this.lastViewer = viewer;
            this.lastUnlimited = unlimited;
        }
        let budget = options.maxBuilds ?? 10;
        const out: EarthUpdate = { stats: this.currentStats(), chunks: { created: [], destroyed: [] }, city: { created: [], destroyed: [] } };
        while (this.inbox.length) {
            const m = this.inbox[0];
            while (m.created.length && budget > 0) {
                const c = m.created.shift() as WorkerChunk;
                out.chunks.created.push({ ...c, texOrigin: this.texOrigin(c.mesh.origin) });
                budget--;
            }
            for (const t of m.tilesCreated) {
                const k = tileName(t[0]);
                const b = t[1];
                this.liveTiles.set(k, [t[0], { origin: b.origin, basis: b.basis, placements: b.placements, settlements: b.settlements, triangles: b.indices.length / 3, roads: b.roads, roadLines: b.roadLines }]);
                out.city.created.push(t);
            }
            m.tilesCreated = [];
            for (const id of m.tilesDestroyed) {
                const k = tileName(id);
                const live = this.liveTiles.get(k);
                if (live) { this.liveTiles.delete(k); out.city.destroyed.push(live); }
            }
            m.tilesDestroyed = [];
            if (m.created.length) break;
            out.chunks.destroyed.push(...m.destroyed);
            this.stats = m.stats;
            this.cityStats = m.city;
            this.cityBusy = m.cityBusy;
            this.workerElevation = m.elevation;
            this.cityErrors = m.cityErrors;
            this.inbox.shift();
        }
        if (out.city.created.length || out.city.destroyed.length) {
            this.settlements = [];
            for (const [, t] of this.liveTiles.values()) this.settlements.push(...t.settlements);
        }
        out.stats = this.currentStats();
        return out;
    }

    private currentStats(): EarthStats {
        // Chunks made but not yet handed out are still pending for the caller.
        const queued = this.inbox.reduce((n, m) => n + m.created.length, 0);
        return { ...this.stats, pending: this.stats.pending + queued, city: this.cityStats, settlements: this.settlements };
    }

    /** True once everything wanted around the viewer is built and handed out (terrain and city). */
    settled(): boolean {
        const s = this.currentStats();
        return s.pending === 0 && !this.inbox.length && (!this.cityEnabled || !this.cityBusy);
    }

    /** The ground along a direction from the planet's center, at the finest (walkable) detail unless `spacing` asks for a band-limited version. */
    sample(direction: V3, spacing = 0): EarthSample {
        const d = normalize(direction);
        const s = this.planet.sample(d, spacing, new Lookup("fallback"));
        const [lat, lon] = dirToLatLon(d);
        return { ...s, radius: this.planet.def.radius + s.surface, lat, lon };
    }

    normal(direction: V3, step: number): V3 {
        return this.planet.surfaceNormal(normalize(direction), Math.max(step, 1e-3), 0, new Lookup("fallback"));
    }

    /** A flat, dry spot near `preferred`; answers from whatever elevation is cached now. */
    findLandingSite(preferred: V3): V3 {
        return this.planet.findLandingSite(preferred, new Lookup("fallback"));
    }

    /** Earth's buildings within `radius` of `position` (world), nearest first. */
    buildings(position: V3, radius: number, options: { kind?: "house" | "box"; limit?: number } = {}): CityBuilding[] {
        const limit = options.limit !== undefined && Number.isFinite(options.limit) ? Math.max(0, Math.floor(options.limit)) : Infinity;
        const out: [number, Placement][] = [];
        for (const [, t] of this.liveTiles.values()) {
            for (const p of t.placements) {
                if (options.kind && p.kind !== options.kind) continue;
                const d = distance(p.anchor, position);
                if (d <= radius) out.push([d, p]);
            }
        }
        out.sort((a, b) => a[0] - b[0] || (a[1].key < b[1].key ? -1 : a[1].key > b[1].key ? 1 : 0));
        if (out.length > limit) out.length = limit;
        return out.map(([d, p]) => ({ ...p, distance: d }));
    }

    /** Earth's roads near (lat, lon): everything whose extent comes within `radius` meters. */
    roads(lat: number, lon: number, radius: number): RoadLine[] {
        const dlat = radius / 110540;
        const dlon = radius / (111320 * Math.max(Math.abs(Math.cos(lat * Math.PI / 180)), 1e-6));
        const out: RoadLine[] = [];
        for (const [, t] of this.liveTiles.values()) for (const r of t.roadLines) {
            if (lat >= r.bounds[0] - dlat && lat <= r.bounds[2] + dlat && lon >= r.bounds[1] - dlon && lon <= r.bounds[3] + dlon) out.push(r);
        }
        return out;
    }

    geocode(query: string): Promise<Place[]> { return this.geocoder.search(query); }
    placeName(lat: number, lon: number): string | null { return this.geocoder.reverse(lat, lon); }

    /** Drops everything streamed (travel). The renderer drops its meshes itself. */
    clear(): void {
        this.epoch++;
        this.inbox = [];
        this.liveTiles.clear();
        this.settlements = [];
        this.stats = { ...this.stats, live: 0, pending: 1 };
        this.cityBusy = true;
        this.lastViewer = null;
        this.post({ type: "clear", epoch: this.epoch });
    }

    configure(options: { splitFactor?: number; minLevel?: number; triangleBudget?: number }): void {
        this.post({ type: "configure", ...options });
    }

    /** Height of `p` above sea level. */
    altitude(viewer: V3): number { return distance(viewer, this.planet.def.center) - this.planet.def.radius; }
}
