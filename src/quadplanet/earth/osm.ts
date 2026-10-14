// OpenStreetMap buildings, roads and places for Earth, from hosted vector tiles (ported from
// QuadPlanet's osm.rs).
//
// The default source is OpenFreeMap (https://openfreemap.org): free OpenMapTiles-schema vector
// tiles of the whole planet, no API key, commercial use allowed with attribution ("© OpenStreetMap
// contributors"). Its TileJSON names the current weekly build's `{z}/{x}/{y}` URL; any other
// OpenMapTiles-schema source works too (a TileJSON URL or a `{z}/{x}/{y}` template).
//
// Tiles are Web Mercator XYZ, like the elevation tiles; the city layer reads zoom 14, the schema's
// most detailed (about 2.4 km a side at the equator, 4096 units across). They are kept in Cache
// Storage for good: a place you've been looks the same next time.
//
// What is read:
// - `building`: footprint polygons with `render_height` / `render_min_height` and sometimes
//   `colour`. At zoom 14 equal buildings are merged into one multipolygon, so each exterior ring is
//   one building. Outlines with `hide_3d` (drawn by their parts instead) are skipped. A building
//   that crosses a tile edge belongs to the tile its centroid is in.
// - `transportation`: road and path center lines with a `class`; tunnels are skipped. Lines are
//   clipped to the tile so neighbours don't draw the same stretch twice.
// - `place`: populated places (city ... isolated dwelling) for the campaign's settlements.

import type { TileId } from "./elevation";
import { GEOM_LINE, GEOM_POINT, GEOM_POLYGON, decodeTile, featureNumber, featureString, ringArea2, truthy } from "./mvt";
import { cacheMissing } from "./net";

export const OPENFREEMAP_TILEJSON = "https://tiles.openfreemap.org/planet";
/** The OpenMapTiles schema's most detailed zoom (buildings appear from 13; 14 has them all). */
export const CITY_ZOOM = 14;

export type RoadClass = "motorway" | "trunk" | "primary" | "secondary" | "tertiary" | "minor" | "service" | "track" | "path" | "rail";

export function roadClassFromOmt(c: string): RoadClass | null {
    switch (c) {
        case "motorway": case "trunk": case "primary": case "secondary": case "tertiary": case "service": case "track": case "path": return c;
        case "minor": case "busway": case "raceway": return "minor";
        case "rail": case "transit": return "rail";
        default: return null;
    }
}

/** Paved width in meters. */
export const ROAD_WIDTH: Record<RoadClass, number> = {
    motorway: 15, trunk: 12, primary: 10, secondary: 8.5, tertiary: 7.5, minor: 6, service: 4, track: 3, path: 1.8, rail: 3.2,
};

/** Roads a house would face (not footpaths or rail). */
export const isStreet = (c: RoadClass): boolean => c !== "path" && c !== "track" && c !== "rail";

/** sRGB surface color. */
export function roadColor(c: RoadClass): [number, number, number] {
    switch (c) {
        case "motorway": case "trunk": return [0.2, 0.2, 0.21];
        case "primary": case "secondary": case "tertiary": return [0.24, 0.24, 0.25];
        case "minor": case "service": return [0.29, 0.29, 0.3];
        case "track": return [0.47, 0.41, 0.33];
        case "path": return [0.62, 0.58, 0.52];
        case "rail": return [0.36, 0.33, 0.3];
    }
}

export interface OsmBuilding {
    /** Exterior ring as (latitude, longitude) in degrees. */
    ring: [number, number][];
    /** Ring area in square meters (on the ground). */
    area: number;
    height: number;
    minHeight: number;
    /** sRGB, when the map gives one. */
    colour: [number, number, number] | null;
}

export interface OsmRoad { points: [number, number][]; class: RoadClass; bridge: boolean }
export interface OsmSettlement { name: string; kind: string; lat: number; lon: number }
export interface OsmTile { settlements: OsmSettlement[]; buildings: OsmBuilding[]; roads: OsmRoad[] }

export const emptyOsmTile = (): OsmTile => ({ settlements: [], buildings: [], roads: [] });

/** Latitude/longitude (degrees) of a point in Mercator tile units (`extent` per tile side). */
export function tilePointToLatLon(id: TileId, extent: number, x: number, y: number): [number, number] {
    const n = 2 ** id.z;
    const gx = (id.x + x / extent) / n;
    const gy = (id.y + y / extent) / n;
    return [Math.atan(Math.sinh(Math.PI * (1 - 2 * gy))) * 180 / Math.PI, gx * 360 - 180];
}

/** The zoom-`z` tile containing a latitude/longitude. */
export function tileOf(lat: number, lon: number, z: number): TileId {
    const n = 2 ** z;
    const la = Math.max(-85.0511, Math.min(85.0511, lat)) * Math.PI / 180;
    const fx = (lon + 180) / 360;
    const x = Math.floor((fx - Math.floor(fx)) * n);
    const y = Math.max(0, Math.min(n - 1, Math.floor((1 - Math.log(Math.tan(la) + 1 / Math.cos(la)) / Math.PI) / 2 * n)));
    return { z, x: Math.min(x, n - 1), y };
}

/** Meters per tile unit at a latitude, on a sphere of `radius`. */
export function metersPerUnit(z: number, extent: number, lat: number, radius: number): number {
    return 2 * Math.PI * radius * Math.cos(lat * Math.PI / 180) / 2 ** z / extent;
}

/** "#rgb", "#rrggbb" or a common CSS color name, as sRGB. */
export function parseColour(raw: string): [number, number, number] | null {
    const s = raw.trim().toLowerCase();
    if (s.startsWith("#")) {
        const hex = s.slice(1);
        const v = (h: string) => /^[0-9a-f]{2}$/.test(h) ? parseInt(h, 16) / 255 : NaN;
        let c: number[] | null = null;
        if (hex.length === 6) c = [v(hex.slice(0, 2)), v(hex.slice(2, 4)), v(hex.slice(4, 6))];
        else if (hex.length === 3) c = [v(hex[0] + hex[0]), v(hex[1] + hex[1]), v(hex[2] + hex[2])];
        return c && c.every(Number.isFinite) ? [c[0], c[1], c[2]] : null;
    }
    const named: Record<string, [number, number, number]> = {
        white: [0.95, 0.94, 0.92], grey: [0.62, 0.62, 0.62], gray: [0.62, 0.62, 0.62], silver: [0.62, 0.62, 0.62],
        darkgrey: [0.4, 0.4, 0.4], darkgray: [0.4, 0.4, 0.4], lightgrey: [0.8, 0.8, 0.8], lightgray: [0.8, 0.8, 0.8],
        black: [0.12, 0.12, 0.12], brown: [0.5, 0.33, 0.22], red: [0.62, 0.25, 0.2], maroon: [0.62, 0.25, 0.2],
        yellow: [0.88, 0.8, 0.45], beige: [0.84, 0.76, 0.6], tan: [0.84, 0.76, 0.6], wheat: [0.84, 0.76, 0.6],
        orange: [0.85, 0.55, 0.3], pink: [0.88, 0.7, 0.7], blue: [0.4, 0.5, 0.65], green: [0.45, 0.58, 0.42],
        cream: [0.94, 0.91, 0.82], ivory: [0.94, 0.91, 0.82],
    };
    return named[s] ?? null;
}

/** Clips a polyline (tile units) to the box [lo, hi]^2, splitting it where it leaves and re-enters (Liang-Barsky per segment). */
export function clipPolyline(line: readonly [number, number][], lo: number, hi: number): [number, number][][] {
    const out: [number, number][][] = [];
    let current: [number, number][] = [];
    for (let w = 0; w + 1 < line.length; w++) {
        const p = line[w], q = line[w + 1];
        const d = [q[0] - p[0], q[1] - p[1]];
        let t0 = 0, t1 = 1, inside = true;
        for (const [pp, qq] of [[-d[0], p[0] - lo], [d[0], hi - p[0]], [-d[1], p[1] - lo], [d[1], hi - p[1]]]) {
            if (pp === 0) {
                if (qq < 0) { inside = false; break; }
            } else {
                const r = qq / pp;
                if (pp < 0) { if (r > t1) { inside = false; break; } if (r > t0) t0 = r; }
                else { if (r < t0) { inside = false; break; } if (r < t1) t1 = r; }
            }
        }
        if (!inside) {
            if (current.length >= 2) out.push(current);
            current = [];
            continue;
        }
        const a: [number, number] = [p[0] + d[0] * t0, p[1] + d[1] * t0];
        const b: [number, number] = [p[0] + d[0] * t1, p[1] + d[1] * t1];
        const last = current[current.length - 1];
        if (!last || Math.abs(last[0] - a[0]) > 1e-9 || Math.abs(last[1] - a[1]) > 1e-9) {
            if (current.length >= 2) out.push(current);
            current = [a];
        }
        current.push(b);
        if (t1 < 1 && current.length >= 2) { out.push(current); current = []; }
    }
    if (current.length >= 2) out.push(current);
    return out;
}

/** Reads one tile's buildings, roads and places. `radius` is the planet's, for footprint areas. */
export function parseTile(id: TileId, bytes: Uint8Array, radius: number): OsmTile {
    const layers = decodeTile(bytes, ["building", "transportation", "place"]);
    const tile = emptyOsmTile();
    for (const layer of layers) {
        const ext = layer.extent, e = ext;
        const centerLat = tilePointToLatLon(id, ext, e / 2, e / 2)[0];
        const m = metersPerUnit(id.z, ext, centerLat, radius);
        if (layer.name === "building") {
            for (const f of layer.features) {
                if (f.geomType !== GEOM_POLYGON) continue;
                const hide = f.properties.get("hide_3d");
                if (hide !== undefined && truthy(hide)) continue;
                const height = Math.max(1, featureNumber(f, "render_height") ?? 5);
                const minHeight = Math.min(Math.max(0, featureNumber(f, "render_min_height") ?? 0), height - 0.5);
                const cs = featureString(f, "colour");
                const colour = cs ? parseColour(cs) : null;
                for (const ring of f.geometry) {
                    if (ring.length < 3) continue;
                    const a2 = ringArea2(ring);
                    if (a2 <= 0) continue; // a hole
                    // Area-weighted centroid decides which tile owns a building on an edge.
                    let cx = 0, cy = 0;
                    for (let i = 0; i < ring.length; i++) {
                        const p = ring[i], q = ring[(i + 1) % ring.length];
                        const c = p[0] * q[1] - q[0] * p[1];
                        cx += (p[0] + q[0]) * c;
                        cy += (p[1] + q[1]) * c;
                    }
                    cx /= 3 * a2;
                    cy /= 3 * a2;
                    if (!(cx >= 0 && cx < e && cy >= 0 && cy < e)) continue;
                    tile.buildings.push({ ring: ring.map(p => tilePointToLatLon(id, ext, p[0], p[1])), area: a2 / 2 * m * m, height, minHeight, colour });
                }
            }
        } else if (layer.name === "place") {
            for (const f of layer.features) {
                if (f.geomType !== GEOM_POINT) continue;
                const kind = featureString(f, "class") ?? "";
                if (!["city", "town", "village", "hamlet", "isolated_dwelling"].includes(kind)) continue;
                const name = featureString(f, "name") ?? featureString(f, "name:en");
                if (!name) continue;
                for (const g of f.geometry) for (const point of g) {
                    const x = point[0], y = point[1];
                    if (x < 0 || y < 0 || x >= e || y >= e) continue;
                    const [lat, lon] = tilePointToLatLon(id, ext, x, y);
                    tile.settlements.push({ name, kind, lat, lon });
                }
            }
        } else if (layer.name === "transportation") {
            for (const f of layer.features) {
                if (f.geomType !== GEOM_LINE) continue;
                const cls = roadClassFromOmt(featureString(f, "class") ?? "");
                if (!cls) continue;
                const brunnel = featureString(f, "brunnel") ?? "";
                if (brunnel === "tunnel") continue;
                const indoor = f.properties.get("indoor");
                if (indoor !== undefined && truthy(indoor)) continue;
                for (const line of f.geometry) {
                    for (const piece of clipPolyline(line, 0, e)) {
                        tile.roads.push({ points: piece.map(p => tilePointToLatLon(id, ext, p[0], p[1])), class: cls, bridge: brunnel === "bridge" });
                    }
                }
            }
        }
    }
    return tile;
}

/** Why a tile isn't here: "missing" (none: treat as empty) or a transient error worth retrying. */
export type OsmLoad = { ok: Uint8Array } | { missing: true } | { error: string };

/** The `{z}/{x}/{y}` template a TileJSON document names. */
export function templateFromTileJson(json: string): string | null {
    try {
        const v = JSON.parse(json) as { tiles?: unknown };
        return Array.isArray(v.tiles) && typeof v.tiles[0] === "string" ? v.tiles[0] : null;
    } catch { return null; }
}

/** Loads OpenStreetMap tiles: from Cache Storage, else the network (a TileJSON is resolved once). */
export class OsmLoader {
    private template: string | null = null;
    private resolving: Promise<string> | null = null;
    constructor(readonly url: string = OPENFREEMAP_TILEJSON) {}

    private async resolve(): Promise<string> {
        if (this.url.includes("{z}")) return this.url;
        if (this.template) return this.template;
        this.resolving ??= (async () => {
            // The TileJSON names this week's build; it is looked up fresh each session.
            const res = await fetch(this.url, { mode: "cors" });
            if (!res.ok) throw new Error(`${this.url}: HTTP ${res.status}`);
            const t = templateFromTileJson(await res.text());
            if (!t) throw new Error(`${this.url} is not a TileJSON with tiles`);
            this.template = t;
            return t;
        })().finally(() => { this.resolving = null; });
        return this.resolving;
    }

    /** Tile URLs carry the weekly build's name; the cache keys a tile by z/x/y alone, so a place stays as first seen. */
    private static cacheKey(id: TileId): string { return `https://allegiance.cache/osm/${id.z}/${id.x}/${id.y}.pbf`; }

    async load(id: TileId): Promise<OsmLoad> {
        const key = OsmLoader.cacheKey(id);
        try {
            const cache = typeof caches === "undefined" ? null : await caches.open("allegiance-tiles-v1");
            const hit = cache ? await cache.match(key) : undefined;
            if (hit) return hit.status === 204 ? { missing: true } : { ok: new Uint8Array(await hit.arrayBuffer()) };
            const url = (await this.resolve()).replace("{z}", String(id.z)).replace("{x}", String(id.x)).replace("{y}", String(id.y));
            const res = await fetch(url, { mode: "cors", credentials: "omit" });
            if (res.status === 404 || res.status === 204) { await cacheMissing(key); return { missing: true }; }
            if (!res.ok) return { error: `${url}: HTTP ${res.status}` };
            let bytes = new Uint8Array(await res.arrayBuffer());
            // Some servers hand out the stored gzip without saying so.
            if (bytes[0] === 0x1f && bytes[1] === 0x8b) bytes = new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer());
            if (cache) await cache.put(key, new Response(bytes.slice(), { headers: { "content-type": "application/x-protobuf" } })).catch(() => undefined);
            return { ok: bytes };
        } catch (e) {
            return { error: (e as Error).message };
        }
    }
}
