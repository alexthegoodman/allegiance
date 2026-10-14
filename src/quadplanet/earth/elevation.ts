// Real-world elevation for Earth: a streamed, cached pyramid of elevation tiles (ported from
// QuadPlanet's elevation.rs).
//
// The source is the Terrarium encoding of the open "Terrain Tiles" dataset (AWS Open Data,
// originally Mapzen): 256x256 PNG tiles in the Web Mercator XYZ scheme, zoom 0-15, where each
// pixel's elevation in meters is `R * 256 + G + B / 256 - 32768`. On land it is mostly SRTM (with
// GMTED, NED, ETOPO1 and others filling gaps); the oceans carry bathymetry. A chunk samples the
// zoom whose pixels match its own vertex spacing, so a coarse chunk seen from orbit reads a
// handful of low-zoom tiles and the ground under your feet reads zoom 13 (~19 m pixels).
//
// Zoom 0 (one tile for the whole world, built from the zoom-1 tiles) ships with the game
// (public/terrarium_z0.png), so Earth always has continents and oceans, even offline. Everything
// else is fetched in the background and kept in the browser's Cache Storage, so a second visit
// reads from the cache.
//
// Crack-free streaming needs every chunk that samples a point to get the same value there. A
// value depends only on (point, band limit) and on which tiles are *final*: ready, or failed for
// good (then the next coarser zoom is used). Chunk building uses "gate" access: a sample that
// touches a tile still in flight marks the build incomplete, and the streamer retries that chunk
// once the tile has landed - so no chunk is ever built from data a neighbour won't also see.

export const TILE = 256;
/** Web Mercator stops here; the caps beyond it are blended toward a pole value. */
export const MERCATOR_MAX_LAT = 85.05112878;
export const TERRARIUM_URL = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png";
/** Zoom 13 is ~19 m per pixel at the equator: SRTM's own resolution. */
export const DEFAULT_MAX_ZOOM = 13;
const MAX_ZOOM_LIMIT = 15;
/** Downloads at once (the Rust side ran six loader threads). */
const WORKERS = 6;
const MAX_QUEUE = 2048;

export interface TileId { z: number; x: number; y: number }
export const tileKey = (id: TileId): number => id.z * 2 ** 34 + id.x * 2 ** 17 + id.y;

/** Elevations in meters, row-major, row 0 at the tile's north edge. */
export interface Tile { heights: Float32Array }

/** Terrarium RGB(A) pixels to heights. */
export function terrariumHeights(rgba: Uint8Array | Uint8ClampedArray, channels: number): Float32Array {
    const out = new Float32Array(TILE * TILE);
    for (let i = 0; i < TILE * TILE; i++) {
        const o = i * channels;
        out[i] = rgba[o] * 256 + rgba[o + 1] + rgba[o + 2] / 256 - 32768;
    }
    return out;
}

/** Decodes a Terrarium PNG with the browser's image decoder (off the main thread). */
export async function decodeTerrarium(blob: Blob): Promise<Tile> {
    const bmp = await createImageBitmap(blob, { colorSpaceConversion: "none", premultiplyAlpha: "none" });
    if (bmp.width !== TILE || bmp.height !== TILE) { bmp.close(); throw new Error(`expected a ${TILE}x${TILE} tile, got ${bmp.width}x${bmp.height}`); }
    const canvas = new OffscreenCanvas(TILE, TILE);
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
    ctx.drawImage(bmp, 0, 0);
    bmp.close();
    return { heights: terrariumHeights(ctx.getImageData(0, 0, TILE, TILE).data, 4) };
}

/** Where tiles come from: a tile, or null when the source says it doesn't exist (final). Throws on network trouble. */
export type TileLoader = (id: TileId) => Promise<Tile | null>;

/** How a lookup treats a tile that isn't loaded yet. */
export type Access =
    /** Request it and use coarser data meanwhile, flagging the lookup `missing` (chunk building). */
    | "gate"
    /** Request it and use coarser data meanwhile (footing, LOD distances, landing site search). */
    | "fallback";

/** Per-caller lookup state: the access mode, whether anything was missing, and the last few tiles touched. */
export class Lookup {
    missing = false;
    recent: [number, Tile][] = [];
    constructor(public access: Access) {}
}

type Slot = { state: "pending" } | { state: "ready"; tile: Tile; used: number } | { state: "failed" };

export interface ElevationStats { resident: number; pending: number; loaded: number; failed: number; maxZoom: number; inFlight: number; loadMs: number }

/** One elevation sample: meters above sea level and the slope (meters per meter, east / north). */
export interface Elevation { height: number; east: number; north: number }
export const slopeOf = (e: Elevation): number => Math.hypot(e.east, e.north);

export class ElevationSource {
    private slots = new Map<number, Slot>();
    private queue: TileId[] = [];
    private inFlight = 0;
    private tick = 0;
    loaded = 0;
    failed = 0;
    /** Total time tiles took to load (ms), for the average in stats. */
    private loadMs = 0;
    readonly maxZoom: number;
    readonly poleNorth: number;
    readonly poleSouth: number;
    /** Called whenever a tile lands or fails (the streamers retry what waited on it). */
    onTile: (() => void) | null = null;

    /**
     * `base` is the zoom-0 tile; `loader` null means offline (nothing beyond it). `capacity`:
     * decoded tiles kept (256 KB each); least recently used go first.
     */
    constructor(private base: Tile, private loader: TileLoader | null, maxZoom: number, private radius: number, private capacity = 512) {
        this.maxZoom = Math.min(maxZoom, MAX_ZOOM_LIMIT);
        const rowMean = (y: number) => { let s = 0; for (let x = 0; x < TILE; x++) s += base.heights[y * TILE + x]; return s / TILE; };
        this.poleNorth = rowMean(0);
        this.poleSouth = rowMean(TILE - 1);
    }

    stats(): ElevationStats {
        const s: ElevationStats = { resident: 0, pending: 0, loaded: this.loaded, failed: this.failed, maxZoom: this.maxZoom, inFlight: this.inFlight, loadMs: Math.round(this.loadMs / Math.max(1, this.loaded + this.failed)) };
        for (const slot of this.slots.values()) { if (slot.state === "ready") s.resident++; else if (slot.state === "pending") s.pending++; }
        return s;
    }

    /** True while any requested tile is still in flight. */
    busy(): boolean {
        for (const s of this.slots.values()) if (s.state === "pending") return true;
        return false;
    }

    /** Resolves once nothing is in flight (or after `timeoutMs`); for tests and tools. */
    async waitIdle(timeoutMs = 30000): Promise<boolean> {
        const start = Date.now();
        while (this.busy()) {
            if (Date.now() - start > timeoutMs) return false;
            await new Promise(r => setTimeout(r, 5));
        }
        return true;
    }

    private circumference(): number { return 2 * Math.PI * this.radius; }

    /** Mercator zoom whose pixels are about `spacing` meters at this latitude. */
    zoomFor(lat: number, spacing: number): number {
        const la = Math.max(-MERCATOR_MAX_LAT, Math.min(MERCATOR_MAX_LAT, lat)) * Math.PI / 180;
        const metersZ0 = this.circumference() * Math.cos(la) / TILE;
        const z = Math.ceil(Math.log2(metersZ0 / Math.max(spacing, 1e-3)));
        if (Number.isNaN(z) || z <= 0) return 0;
        return Math.min(z, this.maxZoom);
    }

    /** Elevation at a latitude/longitude (degrees), band-limited to a mesh with vertices `spacing` meters apart. */
    sample(lat: number, lon: number, spacing: number, lk: Lookup): Elevation {
        const cap = Math.min(Math.abs(lat), 90);
        const e = this.sampleMercator(Math.max(-MERCATOR_MAX_LAT, Math.min(MERCATOR_MAX_LAT, lat)), lon, spacing, lk);
        if (cap > MERCATOR_MAX_LAT - 0.5) {
            // Mercator has no poles: fade the last row into one pole height so the cap is smooth.
            const pole = lat > 0 ? this.poleNorth : this.poleSouth;
            const x = Math.max(0, Math.min(1, (cap - (MERCATOR_MAX_LAT - 0.5)) / (90 - (MERCATOR_MAX_LAT - 0.5))));
            const t = x * x * (3 - 2 * x);
            e.height += (pole - e.height) * t;
            e.east *= 1 - t;
            e.north *= 1 - t;
        }
        return e;
    }

    /**
     * Samples the zoom matching `spacing`, or failing that the finest coarser zoom that is resident.
     * Only the wanted zoom's tiles are requested: coarser ones on the way down are used if they
     * are already in, never fetched (fetching every zoom of the chain for every lookup flooded the
     * browser's few connections per host). A tile that has failed for good hands the request on to
     * the next coarser zoom, deterministically, as before.
     */
    private sampleMercator(lat: number, lon: number, spacing: number, lk: Lookup): Elevation {
        let request = true;
        for (let z = this.zoomFor(lat, spacing); ; z--) {
            this.lastFinal = false;
            const e = this.sampleZoom(z, lat, lon, lk, request);
            if (e) return e;
            if (z === 0) throw new Error("zoom 0 is built in");
            // The wanted tiles are on their way (or not resident): only peek below; a final failure
            // at this zoom makes the next one the wanted one.
            request = request && this.lastFinal;
        }
    }
    /** Set by `tile` when the last missing tile was final (failed for good), not just absent. */
    private lastFinal = false;

    /** Catmull-Rom (bicubic) interpolation of the pixel centers at zoom `z`, with its analytic gradient. */
    private sampleZoom(z: number, lat: number, lon: number, lk: Lookup, request = true): Elevation | null {
        const n = TILE * 2 ** z;
        const la = lat * Math.PI / 180;
        const fx = (lon + 180) / 360;
        const x = (fx - Math.floor(fx)) * n - 0.5;
        const y = (1 - Math.log(Math.tan(la) + 1 / Math.cos(la)) / Math.PI) / 2 * n - 0.5;
        const x0 = Math.floor(x), y0 = Math.floor(y);
        const tx = x - x0, ty = y - y0;
        const g = GRID;
        for (let j = 0; j < 4; j++) {
            const py = Math.max(0, Math.min(n - 1, y0 + j - 1));
            for (let i = 0; i < 4; i++) {
                const px = (((x0 + i - 1) % n) + n) % n;
                const v = this.pixel(z, px, py, lk, request);
                if (v === null) return null;
                g[j * 4 + i] = v;
            }
        }
        catmullRom(tx, WX, DX);
        catmullRom(ty, WY, DY);
        let h = 0, gx = 0, gy = 0;
        for (let j = 0; j < 4; j++) {
            for (let i = 0; i < 4; i++) {
                const v = g[j * 4 + i];
                h += v * WX[i] * WY[j];
                gx += v * DX[i] * WY[j];
                gy += v * WX[i] * DY[j];
            }
        }
        // Mercator is conformal: a pixel spans the same ground both ways.
        const meters = this.circumference() * Math.cos(la) / n;
        return { height: h, east: gx / meters, north: -gy / meters };
    }

    private pixel(z: number, px: number, py: number, lk: Lookup, request: boolean): number | null {
        if (z === 0) return this.base.heights[py * TILE + px];
        const tx = Math.floor(px / TILE), ty = Math.floor(py / TILE);
        const t = this.tile({ z, x: tx, y: ty }, lk, request);
        if (!t) return null;
        return t.heights[(py - ty * TILE) * TILE + (px - tx * TILE)];
    }

    private tile(id: TileId, lk: Lookup, request: boolean): Tile | null {
        const key = tileKey(id);
        for (const [k, t] of lk.recent) if (k === key) return t;
        const slot = request ? this.lookupOrRequest(id, key) : this.peek(key);
        if (slot === "waiting") { if (lk.access === "gate" && request) lk.missing = true; return null; }
        if (slot === "final") { this.lastFinal = true; return null; }
        if (lk.recent.length === 8) lk.recent.shift();
        lk.recent.push([key, slot]);
        return slot;
    }

    /** A tile if it is resident; "final" if it failed for good; otherwise "waiting" (nothing is requested). */
    private peek(key: number): Tile | "final" | "waiting" {
        const s = this.slots.get(key);
        if (s?.state === "ready") { s.used = ++this.tick; return s.tile; }
        return s?.state === "failed" ? "final" : "waiting";
    }

    private lookupOrRequest(id: TileId, key: number): Tile | "final" | "waiting" {
        const tick = ++this.tick;
        const s = this.slots.get(key);
        if (s) {
            if (s.state === "ready") { s.used = tick; return s.tile; }
            return s.state === "failed" ? "final" : "waiting";
        }
        if (!this.loader) { this.slots.set(key, { state: "failed" }); return "final"; }
        this.slots.set(key, { state: "pending" });
        this.queue.push(id);
        if (this.queue.length > MAX_QUEUE) {
            // The oldest requests are for where the viewer was long ago; forget them (they are
            // re-requested if they are ever wanted again).
            for (const stale of this.queue.splice(0, this.queue.length - MAX_QUEUE)) {
                const k = tileKey(stale);
                if (this.slots.get(k)?.state === "pending") this.slots.delete(k);
            }
        }
        this.pump();
        return "waiting";
    }

    /** Starts downloads, newest request first: the viewer's latest needs. */
    private pump(): void {
        while (this.inFlight < WORKERS && this.queue.length) {
            const id = this.queue.pop()!;
            const key = tileKey(id);
            if (this.slots.get(key)?.state !== "pending") continue;
            this.inFlight++;
            this.load(id).then(tile => this.finish(key, tile), () => this.finish(key, null)).finally(() => { this.inFlight--; this.pump(); });
        }
    }

    private async load(id: TileId): Promise<Tile | null> {
        const t0 = Date.now();
        try { return await this.loadOnce(id); } finally { this.loadMs += Date.now() - t0; }
    }

    private async loadOnce(id: TileId): Promise<Tile | null> {
        for (let attempt = 0; attempt < 2; attempt++) {
            try {
                return await this.loader!(id);
            } catch (e) {
                if (attempt === 0) await new Promise(r => setTimeout(r, 400));
            }
        }
        return null;
    }

    private finish(key: number, tile: Tile | null): void {
        if (this.slots.get(key)?.state !== "pending") return;
        if (tile) {
            this.slots.set(key, { state: "ready", tile, used: this.tick });
            this.loaded++;
        } else {
            this.slots.set(key, { state: "failed" });
            this.failed++;
        }
        // Least recently used tiles go once over capacity; they reload from the cache.
        let ready = 0;
        for (const s of this.slots.values()) if (s.state === "ready") ready++;
        if (ready > this.capacity) {
            const byAge: [number, number][] = [];
            for (const [k, s] of this.slots) if (s.state === "ready" && k !== key) byAge.push([s.used, k]);
            byAge.sort((a, b) => a[0] - b[0]);
            for (const [, k] of byAge.slice(0, ready - Math.floor(this.capacity * 7 / 8))) this.slots.delete(k);
        }
        this.onTile?.();
    }
}

const GRID = new Float64Array(16);
const WX = new Float64Array(4), WY = new Float64Array(4), DX = new Float64Array(4), DY = new Float64Array(4);

/** Catmull-Rom weights for the four samples around fraction `t`, and their derivatives. */
function catmullRom(t: number, w: Float64Array, d: Float64Array): void {
    const t2 = t * t, t3 = t2 * t;
    w[0] = 0.5 * (-t3 + 2 * t2 - t);
    w[1] = 0.5 * (3 * t3 - 5 * t2 + 2);
    w[2] = 0.5 * (-3 * t3 + 4 * t2 + t);
    w[3] = 0.5 * (t3 - t2);
    d[0] = 0.5 * (-3 * t2 + 4 * t - 1);
    d[1] = 0.5 * (9 * t2 - 10 * t);
    d[2] = 0.5 * (-9 * t2 + 8 * t + 1);
    d[3] = 0.5 * (3 * t2 - 2 * t);
}

/** An HTTP Terrarium loader: Cache Storage first, then the network (a 404 means no such tile). */
export function httpTerrarium(url = TERRARIUM_URL, fetchCached: (url: string) => Promise<Response | null>): TileLoader {
    return async id => {
        const res = await fetchCached(url.replace("{z}", String(id.z)).replace("{x}", String(id.x)).replace("{y}", String(id.y)));
        if (!res) return null;
        return decodeTerrarium(await res.blob());
    };
}
