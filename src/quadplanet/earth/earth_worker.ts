// The Earth worker: QuadPlanet's streaming threads in one Web Worker. It owns a copy of the
// elevation pyramid, the chunk streamer (selection, balancing, chunk building) and the city layer
// (OpenStreetMap tiles: fetching, decoding, placing buildings and roads on the ground), works
// continuously on the newest viewer position it was sent, and posts back what it made. The main
// thread (system.ts) turns the results into meshes and answers the game's ground and building
// queries from its own copies, so nothing here ever holds a frame.

import { ElevationSource, TERRARIUM_URL, DEFAULT_MAX_ZOOM, httpTerrarium, type ElevationStats, type TileId } from "./elevation";
import { Planet } from "./planet";
import { DEFAULT_LOD, type ChunkNode } from "./quadtree";
import { PlanetStreamer, type StreamStats } from "./streamer";
import { CityLayer, DEFAULT_HOUSE_RULE, type BuiltTile, type CityConfig, type CityStats } from "./city";
import { OsmLoader } from "./osm";
import { fetchCached } from "./net";
import type { ChunkMesh } from "./chunk_mesh";
import type { V3 } from "./math";
import type { PlanetDef } from "../qp_planet";

export interface EarthWorkerConfig {
    planet: PlanetDef;
    splitFactor?: number;
    minLevel?: number;
    triangleBudget?: number;
    city?: CityConfig;
    tileCapacity?: number;
}

export type EarthWorkerIn =
    | { type: "init"; config: EarthWorkerConfig; base: Float32Array }
    /** Where the viewer is now. `unlimited`: build everything wanted at once (loading screens, fixed-step runs). */
    | { type: "viewer"; viewer: V3; unlimited: boolean }
    | { type: "clear"; epoch: number }
    | { type: "configure"; splitFactor?: number; minLevel?: number; triangleBudget?: number };

export interface WorkerChunk { key: string; node: ChunkNode; mesh: ChunkMesh }

export type EarthWorkerOut =
    | { type: "update"; epoch: number; created: WorkerChunk[]; destroyed: string[]; tilesCreated: [TileId, BuiltTile][]; tilesDestroyed: TileId[];
        stats: StreamStats; city: CityStats | null; cityBusy: boolean; elevation: ElevationStats; cityErrors: string[] }
    | { type: "error"; message: string };

/** How long one work slice runs before the worker checks its messages again (ms). */
const SLICE_MS = 24;

let planet: Planet | null = null;
let streamer: PlanetStreamer | null = null;
let city: CityLayer | null = null;
let elevation: ElevationSource | null = null;
let viewer: V3 | null = null;
let unlimited = false;
let epoch = 0;
let scheduled = false;
let lastPosted = "";

const scope = self as unknown as { onmessage: ((e: MessageEvent<EarthWorkerIn>) => void) | null; postMessage: (m: EarthWorkerOut, transfer?: Transferable[]) => void };

let timer: ReturnType<typeof setTimeout> | null = null;
function schedule(delay = 0): void {
    if (!planet) return;
    if (scheduled && delay > 0) return;
    if (timer !== null) clearTimeout(timer);
    scheduled = true;
    timer = setTimeout(() => { timer = null; work(); }, delay);
}

function work(): void {
    scheduled = false;
    if (!planet || !streamer || !viewer || !elevation) return;
    const v = viewer;
    // Unlimited (a loading screen) works in longer slices, but still slices: downloads land and new
    // viewer positions arrive between them.
    const budget = unlimited ? SLICE_MS * 8 : SLICE_MS;
    const u = streamer.update([planet], v, Infinity, budget);
    const c = city ? city.update(v, budget / 2) : { created: [], destroyed: [] };
    const stats = u.stats;
    const cityStats = city?.stats() ?? null;
    const transfer: Transferable[] = [];
    const created = u.created.map(([key, node, mesh]) => { transfer.push(mesh.vertexData.buffer, mesh.indexData.buffer); return { key, node, mesh }; });
    for (const [, t] of c.created) transfer.push(t.vertices.buffer, t.indices.buffer);
    const summary = `${stats.live}/${stats.pending}/${stats.waitingForData}/${cityStats?.live}/${cityStats?.pending}/${elevation.stats().pending}`;
    if (created.length || u.destroyed.length || c.created.length || c.destroyed.length || summary !== lastPosted) {
        lastPosted = summary;
        scope.postMessage({
            type: "update", epoch, created, destroyed: u.destroyed, tilesCreated: c.created, tilesDestroyed: c.destroyed.map(([id]) => id),
            stats, city: cityStats, cityBusy: city?.busy() ?? false, elevation: elevation.stats(), cityErrors: city?.lastErrors.slice() ?? [],
        }, transfer);
    }
    // More to build that isn't only waiting on downloads: go on at once. Waiting on downloads only:
    // look again shortly (a tile landing schedules us too).
    if (stats.pending > stats.waitingForData || city?.hasWork()) schedule();
    else if (stats.waitingForData || (cityStats?.pending ?? 0) > 0) schedule(120);
}

scope.onmessage = (e: MessageEvent<EarthWorkerIn>) => {
    const m = e.data;
    try {
        if (m.type === "init") {
            const def = m.config.planet;
            const t = def.terrain?.kind === "earth" ? def.terrain : null;
            const offline = !!t?.offline;
            elevation = new ElevationSource({ heights: m.base }, offline ? null : httpTerrarium(t?.tileUrl ?? TERRARIUM_URL, fetchCached),
                t?.maxZoom ?? DEFAULT_MAX_ZOOM, def.radius, m.config.tileCapacity ?? 384);
            elevation.onTile = () => schedule();
            planet = new Planet(def, elevation);
            const lod = { ...DEFAULT_LOD };
            if (m.config.splitFactor !== undefined) lod.splitFactor = Math.max(0.25, Math.min(8, m.config.splitFactor));
            if (m.config.minLevel !== undefined) lod.minLevel = m.config.minLevel;
            streamer = new PlanetStreamer(lod, Math.max(10_000, m.config.triangleBudget ?? 2_000_000));
            const cc = m.config.city ?? { enabled: true };
            city = cc.enabled === false || offline ? null : new CityLayer(0, cc, {
                center: def.center, radius: def.radius, hasSea: def.hasSea, spacing: planet.finestSpacing(), elevation, rule: { ...DEFAULT_HOUSE_RULE },
            }, new OsmLoader(cc.tileUrl));
            if (city) city.onLoaded = () => schedule();
        } else if (m.type === "viewer") {
            viewer = m.viewer;
            unlimited = m.unlimited;
            schedule();
        } else if (m.type === "clear") {
            epoch = m.epoch;
            streamer?.clear();
            city?.clear();
            lastPosted = "";
            schedule();
        } else if (m.type === "configure" && streamer) {
            if (m.splitFactor !== undefined) streamer.lod.splitFactor = Math.max(0.25, Math.min(8, m.splitFactor));
            if (m.minLevel !== undefined) streamer.lod.minLevel = m.minLevel;
            if (m.triangleBudget !== undefined) streamer.triangleBudget = Math.max(10_000, m.triangleBudget);
            streamer.invalidate();
            schedule();
        }
    } catch (err) {
        scope.postMessage({ type: "error", message: (err as Error).message });
    }
};
