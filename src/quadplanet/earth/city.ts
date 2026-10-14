// Earth's cities: OpenStreetMap buildings and roads (osm.ts) placed on the real ground, streamed in
// zoom-14 tiles (~2.4 km) around the viewer. Ported from QuadPlanet's city.rs.
//
// Each tile, once its map data and the elevation under it are in, becomes:
// - **Placements**: every building's footprint fitted with a rectangle (the minimum-area oriented
//   rectangle around it), the ground under it (lowest and highest point, from the same height
//   function the terrain is drawn from), its height and color, and a seed from its position, so it
//   is the same building on every visit. Buildings that fit the house rule (a size range matching
//   the house model) are `house`s, turned to face the nearest street; the game draws those itself
//   (qp_city.ts: Mesha houses).
// - **One mesh**: a box per building (level of detail 2, out to the edge of the city radius), and
//   the roads as ribbons draped on the ground. Each box vertex carries the offset to its
//   building's anchor (uv and alpha), so the shader can fold away the boxes of buildings near the
//   camera where their models have taken over.
//
// Tiles are fetched in the background; building a tile (sampling the ground, making the mesh) runs
// in slices within a per-frame budget. A tile whose ground needs elevation tiles still downloading
// is retried once they land, like a terrain chunk, so placements never depend on what happened to
// be loaded.

import { type V3, add, clamp, cross, dirToLatLon, distance, dot, latLonToDir, length, normalize, scale, stableHash64, sub } from "./math";
import { type ElevationSource, Lookup, type TileId } from "./elevation";
import { CITY_ZOOM, ROAD_WIDTH, type OsmLoader, type OsmSettlement, type OsmTile, type RoadClass, emptyOsmTile, isStreet, parseTile, roadColor, tileOf, tilePointToLatLon } from "./osm";
import { earthSurface } from "./planet";

/** Material ids (uv.x's integer part) the shader knows. */
export const MATERIAL_BUILDING_BOX = 8;
export const MATERIAL_ROAD = 10;
/** Box bottoms reach this far below the lowest ground under them, so slopes don't show a gap. */
const FOUNDATION_DEPTH = 1;
/** Roads float this far above the ground. */
const ROAD_LIFT = 0.12;
/** Road center lines are resampled at least this often (meters) to follow the ground. */
const ROAD_STEP = 6;

/** The size range of the house model; footprints in it become `house` placements. */
export interface HouseRule {
    minWidth: number; maxWidth: number; minDepth: number; maxDepth: number;
    /** Taller buildings (OSM render_height, meters) are not houses. */
    maxHeight: number;
    /** Smaller footprints (sheds, garages; square meters) are not houses. */
    minArea: number;
    /** A footprint this far outside the range (a share) still fits; the house is clamped to the range. */
    tolerance: number;
}

export const DEFAULT_HOUSE_RULE: HouseRule = { minWidth: 7.8, maxWidth: 18, minDepth: 6, maxDepth: 16, maxHeight: 13.5, minArea: 40, tolerance: 0.08 };

export interface CityConfig { enabled?: boolean; tileUrl?: string; radius?: number; maxAltitude?: number; house?: HouseRule }

/** One building, as the game sees it. */
export interface Placement {
    /** Stable id: a hash of the footprint's position and size. */
    key: string;
    seed: number;
    kind: "house" | "box";
    /** World position of the footprint's center at the lowest ground under it. */
    anchor: V3;
    /** World unit vectors: across the front, up (the planet's radial), and out of the front. */
    right: V3; up: V3; forward: V3;
    width: number; depth: number;
    height: number; minHeight: number;
    /** Lowest and highest ground under the footprint, meters above sea level. */
    groundMin: number; groundMax: number;
    /** Footprint area (m²) and how much of its rectangle it fills (1: a rectangle). */
    area: number; fill: number;
    colour: [number, number, number] | null;
    lat: number; lon: number;
}

/** A road's center line in (latitude, longitude) degrees, its paved width, and the bounding box of its points. */
export interface RoadLine { points: [number, number][]; width: number; street: boolean; bounds: [number, number, number, number] }

function roadLine(points: [number, number][], cls: RoadClass): RoadLine {
    const b: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
    for (const p of points) { b[0] = Math.min(b[0], p[0]); b[1] = Math.min(b[1], p[1]); b[2] = Math.max(b[2], p[0]); b[3] = Math.max(b[3], p[1]); }
    return { points, width: ROAD_WIDTH[cls], street: isStreet(cls), bounds: b };
}

/** What building one tile made. */
export interface BuiltTile {
    id: TileId;
    /** World position of the tile's frame origin and its axes (east, up, south). */
    origin: V3;
    basis: [V3, V3, V3];
    vertices: Float32Array;
    indices: Uint32Array;
    placements: Placement[];
    settlements: OsmSettlement[];
    buildings: number;
    roads: number;
    roadLines: RoadLine[];
}

/** The planet facts the city needs. */
export interface CityEnv {
    center: V3;
    radius: number;
    hasSea: boolean;
    /** The finest terrain spacing: where the walker's feet meet the ground. */
    spacing: number;
    elevation: ElevationSource;
    rule: HouseRule;
}

/** Drawn ground height (meters above sea level) along a planet-relative direction. */
function ground(env: CityEnv, d: V3, lk: Lookup): number {
    const [lat, lon] = dirToLatLon(d);
    return earthSurface(env.elevation.sample(lat, lon, env.spacing, lk).height, env.hasSea).surface;
}

// --- Geometry helpers ------------------------------------------------------------------------

type P2 = [number, number];

function convexHull(points: readonly P2[]): P2[] {
    const pts = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const uniq: P2[] = [];
    for (const p of pts) { const l = uniq[uniq.length - 1]; if (!l || l[0] !== p[0] || l[1] !== p[1]) uniq.push(p); }
    if (uniq.length < 3) return uniq;
    const cr = (o: P2, a: P2, b: P2) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lower: P2[] = [];
    for (const p of uniq) {
        while (lower.length >= 2 && cr(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
        lower.push(p);
    }
    const upper: P2[] = [];
    for (let i = uniq.length - 1; i >= 0; i--) {
        const p = uniq[i];
        while (upper.length >= 2 && cr(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
        upper.push(p);
    }
    lower.pop();
    upper.pop();
    return lower.concat(upper);
}

/** The minimum-area rectangle around `points`: center, unit axis `u` (v is u turned +90°), half extents. */
export interface Rect2 { center: P2; u: P2; halfU: number; halfV: number }

export function minAreaRect(points: readonly P2[]): Rect2 | null {
    const hull = convexHull(points);
    if (hull.length < 3) return null;
    let best: [number, Rect2] | null = null;
    for (let i = 0; i < hull.length; i++) {
        const a = hull[i], b = hull[(i + 1) % hull.length];
        const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
        if (len < 1e-9) continue;
        const u: P2 = [(b[0] - a[0]) / len, (b[1] - a[1]) / len];
        let loU = Infinity, hiU = -Infinity, loV = Infinity, hiV = -Infinity;
        for (const p of hull) {
            const s = p[0] * u[0] + p[1] * u[1];
            const t = -p[0] * u[1] + p[1] * u[0];
            loU = Math.min(loU, s); hiU = Math.max(hiU, s); loV = Math.min(loV, t); hiV = Math.max(hiV, t);
        }
        const area = (hiU - loU) * (hiV - loV);
        if (!best || area < best[0] - 1e-9) {
            const cs = (loU + hiU) / 2, ct = (loV + hiV) / 2;
            best = [area, { center: [cs * u[0] - ct * u[1], cs * u[1] + ct * u[0]], u, halfU: (hiU - loU) / 2, halfV: (hiV - loV) / 2 }];
        }
    }
    return best ? best[1] : null;
}

function polygonArea(points: readonly P2[]): number {
    let a = 0;
    for (let i = 0; i < points.length; i++) {
        const p = points[i], q = points[(i + 1) % points.length];
        a += p[0] * q[1] - q[0] * p[1];
    }
    return Math.abs(a / 2);
}

/** A house's width (across the front) and depth, if the footprint fits the house rule. */
function houseFit(rule: HouseRule, width: number, depth: number): [number, number] | null {
    const t = Math.max(0, rule.tolerance);
    const ok = (x: number, lo: number, hi: number) => x >= lo * (1 - t) && x <= hi * (1 + t);
    if (ok(width, rule.minWidth, rule.maxWidth) && ok(depth, rule.minDepth, rule.maxDepth)) {
        return [clamp(width, rule.minWidth, rule.maxWidth), clamp(depth, rule.minDepth, rule.maxDepth)];
    }
    return null;
}

/** Street points of a tile in a grid, for "which way does this house face". */
class StreetIndex {
    private cells = new Map<string, P2[]>();
    constructor(private cell: number) {}
    add(p: P2): void {
        const k = `${Math.floor(p[0] / this.cell)},${Math.floor(p[1] / this.cell)}`;
        let list = this.cells.get(k);
        if (!list) this.cells.set(k, list = []);
        list.push(p);
    }
    nearest(p: P2, max: number): P2 | null {
        const r = Math.ceil(max / this.cell);
        const cx = Math.floor(p[0] / this.cell), cy = Math.floor(p[1] / this.cell);
        let best: [number, P2] | null = null;
        for (let dx = -r; dx <= r; dx++) {
            for (let dy = -r; dy <= r; dy++) {
                for (const q of this.cells.get(`${cx + dx},${cy + dy}`) ?? []) {
                    const d = (q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2;
                    if (d <= max * max && (!best || d < best[0])) best = [d, q];
                }
            }
        }
        return best ? best[1] : null;
    }
}

/** Facades for buildings OSM gives no color: plaster, stone, brick and concrete (sRGB). */
const FACADES: [number, number, number][] = [
    [0.86, 0.83, 0.76], [0.78, 0.74, 0.66], [0.72, 0.66, 0.58], [0.66, 0.42, 0.33],
    [0.82, 0.8, 0.78], [0.6, 0.6, 0.6], [0.9, 0.87, 0.8], [0.7, 0.62, 0.52],
];
const ROOF: [number, number, number] = [0.34, 0.33, 0.33];

/** A building's stable hash (key and seed) from where it stands and its size. */
export function buildingKey(lat: number, lon: number, area: number): [number, number] {
    return stableHash64(`${lat.toFixed(6)},${lon.toFixed(6)},${area.toFixed(0)}`);
}

// --- Building a tile -------------------------------------------------------------------------

/** The tile's frame: origin on the sea-level sphere under the tile's center, axes east, up, south. Planet-relative. */
export function tileFrame(id: TileId, radius: number): [V3, [V3, V3, V3]] {
    const c = tilePointToLatLon(id, 1, 0.5, 0.5);
    const up = latLonToDir(c[0], c[1]);
    const east = normalize(cross([0, 1, 0], up));
    const south = cross(east, up);
    return [scale(up, radius), [east, up, south]];
}

class MeshOut {
    v: number[] = [];
    i: number[] = [];
    vertex(p: V3, n: V3, u: number, w: number, c: readonly number[], a: number): number {
        const k = this.v.length / 12;
        this.v.push(p[0], p[1], p[2], n[0], n[1], n[2], u, w, c[0], c[1], c[2], a);
        return k;
    }
}

/**
 * Builds one tile, a slice at a time (the generator yields between buildings so a dense city tile
 * never holds a frame). Returns null (and sets `lk.missing`) while elevation it needs is in flight.
 */
export function* buildTile(id: TileId, data: OsmTile, env: CityEnv, lk: Lookup): Generator<void, BuiltTile | null> {
    const [origin, basis] = tileFrame(id, env.radius);
    const [east, upT, south] = basis;
    const north = scale(south, -1);
    const r = env.radius;
    const onSphere = (x: number, y: number): V3 => normalize(add(origin, add(scale(east, x), scale(north, y))));
    const plane = (lat: number, lon: number): P2 => {
        const p = sub(scale(latLonToDir(lat, lon), r), origin);
        return [dot(p, east), dot(p, north)];
    };
    const toLocal = (p: V3): V3 => { const q = sub(p, origin); return [dot(q, east), dot(q, upT), dot(q, south)]; };
    const dirLocal = (d: V3): V3 => [dot(d, east), dot(d, upT), dot(d, south)];
    const mesh = new MeshOut();

    // Streets, for house orientation.
    const streets = new StreetIndex(20);
    const roads2d: [P2[], RoadClass][] = data.roads.map(rd => [rd.points.map(p => plane(p[0], p[1])), rd.class]);
    for (const [pts, cls] of roads2d) {
        if (!isStreet(cls)) continue;
        for (let w = 0; w + 1 < pts.length; w++) {
            const len = Math.hypot(pts[w + 1][0] - pts[w][0], pts[w + 1][1] - pts[w][1]);
            const n = Math.max(1, Math.ceil(len / 8));
            for (let k = 0; k <= n; k++) {
                const t = k / n;
                streets.add([pts[w][0] + (pts[w + 1][0] - pts[w][0]) * t, pts[w][1] + (pts[w + 1][1] - pts[w][1]) * t]);
            }
        }
    }

    const placements: Placement[] = [];
    let sinceYield = 0;
    for (const b of data.buildings) {
        if (++sinceYield >= 40) { sinceYield = 0; yield; }
        const pts = b.ring.map(p => plane(p[0], p[1]));
        const rect = minAreaRect(pts);
        if (!rect) continue;
        const area = polygonArea(pts);
        const fill = Math.min(1, area / Math.max(4 * rect.halfU * rect.halfV, 1e-9));
        const upB = onSphere(rect.center[0], rect.center[1]);
        const lift = (v2: P2): V3 => {
            const w = add(scale(east, v2[0]), scale(north, v2[1]));
            return normalize(sub(w, scale(upB, dot(w, upB))));
        };
        const u3 = lift(rect.u);
        const v3 = cross(upB, u3);
        const at = (s: number, t: number): V3 => normalize(add(scale(upB, r), add(scale(u3, s), scale(v3, t))));

        // The ground under it: center, corners and edge midpoints.
        const hu = rect.halfU, hv = rect.halfV;
        let gmin = Infinity, gmax = -Infinity;
        for (const [s, t] of [[0, 0], [-hu, -hv], [hu, -hv], [hu, hv], [-hu, hv], [0, -hv], [hu, 0], [0, hv], [-hu, 0]]) {
            const g = ground(env, at(s, t), lk);
            gmin = Math.min(gmin, g);
            gmax = Math.max(gmax, g);
        }
        if (lk.missing) return null;

        const [lat, lon] = dirToLatLon(upB);
        const [hashHi, hashLo] = buildingKey(lat, lon, area);
        const colour = b.colour ?? FACADES[hashMod(hashHi, hashLo, FACADES.length)];

        // A house? Pick the front that fits the house rule and faces the nearest street.
        let kind: "house" | "box" = "box";
        let fwd2: P2 = [-rect.u[1], rect.u[0]], halfW = hu, halfD = hv;
        if (b.minHeight <= 0 && b.height <= env.rule.maxHeight && area >= env.rule.minArea) {
            const street = streets.nearest(rect.center, 60);
            const toward: P2 | null = street ? (() => {
                const d: P2 = [street[0] - rect.center[0], street[1] - rect.center[1]];
                const l = Math.max(Math.hypot(d[0], d[1]), 1e-9);
                return [d[0] / l, d[1] / l];
            })() : null;
            const v2: P2 = [-rect.u[1], rect.u[0]];
            const candidates: [P2, number, number][] = [
                [[v2[0], v2[1]], 2 * hu, 2 * hv], [[-v2[0], -v2[1]], 2 * hu, 2 * hv],
                [[rect.u[0], rect.u[1]], 2 * hv, 2 * hu], [[-rect.u[0], -rect.u[1]], 2 * hv, 2 * hu],
            ];
            let best: [number, P2, number, number] | null = null;
            candidates.forEach(([f, w0, d0], k) => {
                const fit = houseFit(env.rule, w0, d0);
                if (!fit) return;
                const [w, d] = fit;
                // Toward the street if there is one; else the long side to the front, and a fixed
                // preference so the choice is stable.
                const score = (toward ? f[0] * toward[0] + f[1] * toward[1] : (w >= d ? 1 : 0)) - k * 1e-6;
                if (!best || score > best[0]) best = [score, f, w, d];
            });
            if (best) {
                const [, f, w, d] = best as [number, P2, number, number];
                kind = "house";
                fwd2 = f;
                halfW = w / 2;
                halfD = d / 2;
            }
        }
        const forward = lift(fwd2);
        const right = cross(upB, forward);
        const anchorRel = scale(upB, r + gmin);

        // The box: a house's own footprint (so the model replaces it in place), else the rectangle.
        // uv.y's integer part says which models may replace it: 1 a house, 2 a building standing on
        // the ground, 0 neither (raised parts).
        const replaceable = kind === "house" ? 1 : b.minHeight <= 0 ? 2 : 0;
        const bottom = b.minHeight > 0 ? gmax + b.minHeight : gmin - FOUNDATION_DEPTH;
        const top = gmax + b.height;
        const anchorL = toLocal(anchorRel);
        const corner = (sx: number, sz: number, h: number): V3 => {
            const d = normalize(add(scale(upB, r), add(scale(right, sx * halfW), scale(forward, sz * halfD))));
            return toLocal(scale(d, r + h));
        };
        const boxVertex = (p: V3, n: V3, c: readonly number[]): number => {
            // The anchor is p minus (uv-encoded x/z offsets, alpha-encoded height): see the shader.
            const dx = clamp(p[0] - anchorL[0], -999, 999);
            const dz = clamp(p[2] - anchorL[2], -999, 999);
            return mesh.vertex(p, n, MATERIAL_BUILDING_BOX + 0.5 + dx / 4000, replaceable + 0.5 + dz / 4000, c, p[1] - anchorL[1]);
        };
        const ring: [number, number][] = [[-1, 1], [1, 1], [1, -1], [-1, -1]];
        const upL = dirLocal(upB);
        for (let k = 0; k < 4; k++) {
            const a = ring[k], c = ring[(k + 1) % 4];
            const a0 = corner(a[0], a[1], bottom), a1 = corner(a[0], a[1], top);
            const c0 = corner(c[0], c[1], bottom), c1 = corner(c[0], c[1], top);
            const n = normalize(cross(sub(c0, a0), sub(a1, a0)));
            const i0 = boxVertex(a0, n, colour), i1 = boxVertex(c0, n, colour), i2 = boxVertex(c1, n, colour), i3 = boxVertex(a1, n, colour);
            mesh.i.push(i0, i1, i2, i0, i2, i3);
        }
        const tops = ring.map(([sx, sz]) => boxVertex(corner(sx, sz, top), upL, ROOF));
        mesh.i.push(tops[0], tops[1], tops[2], tops[0], tops[2], tops[3]);

        placements.push({
            key: hashHi.toString(16).padStart(8, "0") + hashLo.toString(16).padStart(8, "0"),
            seed: hashHi,
            kind,
            anchor: add(env.center, anchorRel),
            right, up: upB, forward,
            width: 2 * halfW, depth: 2 * halfD,
            height: b.height, minHeight: b.minHeight,
            groundMin: gmin, groundMax: gmax,
            area, fill,
            colour: b.colour,
            lat, lon,
        });
    }

    // Roads: ribbons following the ground, a little above it.
    let roadCount = 0;
    for (const [pts, cls] of roads2d) {
        if (++sinceYield >= 40) { sinceYield = 0; yield; }
        // Resample so the ribbon follows the ground between map points.
        const line: P2[] = [];
        for (let w = 0; w + 1 < pts.length; w++) {
            const len = Math.hypot(pts[w + 1][0] - pts[w][0], pts[w + 1][1] - pts[w][1]);
            const n = Math.max(1, Math.ceil(len / ROAD_STEP));
            for (let k = 0; k < n; k++) { const t = k / n; line.push([pts[w][0] + (pts[w + 1][0] - pts[w][0]) * t, pts[w][1] + (pts[w + 1][1] - pts[w][1]) * t]); }
        }
        if (pts.length) line.push(pts[pts.length - 1]);
        const deduped: P2[] = [];
        for (const p of line) { const l = deduped[deduped.length - 1]; if (!l || Math.abs(l[0] - p[0]) >= 1e-6 || Math.abs(l[1] - p[1]) >= 1e-6) deduped.push(p); }
        if (deduped.length < 2) continue;
        const half = ROAD_WIDTH[cls] / 2;
        const color = roadColor(cls);
        let prev: [number, number] | null = null;
        for (let k = 0; k < deduped.length; k++) {
            // Direction along the line here (averaged at interior points), and its left normal.
            const a = deduped[Math.max(0, k - 1)], b = deduped[Math.min(deduped.length - 1, k + 1)];
            const d = [b[0] - a[0], b[1] - a[1]];
            const l = Math.max(Math.hypot(d[0], d[1]), 1e-9);
            const side = [-d[1] / l, d[0] / l];
            const p = deduped[k];
            const ends = [0, 0];
            [-1, 1].forEach((s, j) => {
                const q = [p[0] + side[0] * half * s, p[1] + side[1] * half * s];
                const dir = onSphere(q[0], q[1]);
                const g = ground(env, dir, lk);
                ends[j] = mesh.vertex(toLocal(scale(dir, r + g + ROAD_LIFT)), dirLocal(dir), MATERIAL_ROAD + 0.5, 0.5, color, 0);
            });
            if (prev) {
                // Counter-clockwise from above (ends[0] is the right edge, ends[1] the left).
                const [l0, r0] = prev;
                mesh.i.push(l0, r0, ends[1], r0, ends[0], ends[1]);
            }
            prev = [ends[1], ends[0]];
        }
        roadCount++;
    }
    if (lk.missing) return null;

    return {
        id,
        origin: add(env.center, origin),
        basis,
        vertices: new Float32Array(mesh.v),
        indices: new Uint32Array(mesh.i),
        settlements: data.settlements.slice(),
        buildings: placements.length,
        placements,
        roads: roadCount,
        roadLines: data.roads.filter(rd => rd.points.length >= 2 && rd.class !== "rail").map(rd => roadLine(rd.points.slice(), rd.class)),
    };
}

/** (hi * 2^32 + lo) mod m for a 64-bit hash in two halves. */
function hashMod(hi: number, lo: number, m: number): number {
    return ((hi % m) * (4294967296 % m) + (lo % m)) % m;
}

/** A tile's model matrix (its frame, relative to the render origin): column-major, like an Item's. */
export function tileMatrix(origin: V3, basis: [V3, V3, V3], renderOrigin: V3): number[] {
    const t = sub(origin, renderOrigin);
    const [e, u, s] = basis;
    return [e[0], e[1], e[2], 0, u[0], u[1], u[2], 0, s[0], s[1], s[2], 0, t[0], t[1], t[2], 1];
}

// --- Streaming -------------------------------------------------------------------------------

/** A city tile that is drawn. */
export interface LiveTile {
    origin: V3;
    basis: [V3, V3, V3];
    placements: Placement[];
    settlements: OsmSettlement[];
    triangles: number;
    roads: number;
    roadLines: RoadLine[];
}

export interface CityStats {
    enabled: boolean;
    live: number;
    wanted: number;
    /** Tiles queued, loading or being built. */
    pending: number;
    failed: number;
    buildings: number;
    houses: number;
    roads: number;
    triangles: number;
}

interface Job {
    id: TileId;
    data: OsmTile | null;
    loading: boolean;
    notBefore: number;
    attempts: number;
    build: Generator<void, BuiltTile | null> | null;
    lookup: Lookup | null;
}

const tileName = (id: TileId): string => `${id.z}/${id.x}/${id.y}`;
const nowMs = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

function tileCenterDir(id: TileId): V3 {
    const c = tilePointToLatLon(id, 1, 0.5, 0.5);
    return latLonToDir(c[0], c[1]);
}

/** What `update` hands the caller to turn into (or remove from) the scene. */
export interface CityUpdate { created: [TileId, BuiltTile][]; destroyed: [TileId, LiveTile][] }

/** Downloads at once (the Rust layer ran two tile workers; downloads overlap the building here). */
const LOADS = 3;

export class CityLayer {
    readonly radius: number;
    readonly maxAltitude: number;
    readonly env: CityEnv;
    live = new Map<string, [TileId, LiveTile]>();
    private wanted = new Map<string, TileId>();
    private failed = new Set<string>();
    private jobs = new Map<string, Job>();
    private loading = 0;
    private viewer: V3 = [0, 0, 0];
    lastErrors: string[] = [];
    /** Called when a tile's map data has arrived (there is building to do). */
    onLoaded: (() => void) | null = null;

    constructor(readonly planet: number, config: CityConfig, env: CityEnv, private loader: OsmLoader) {
        this.env = { ...env, rule: config.house ?? env.rule };
        this.radius = clamp(config.radius ?? 3000, 200, 20000);
        this.maxAltitude = config.maxAltitude ?? 8000;
    }

    /** Tiles within `radius` of the planet-relative viewer, when low enough for a city. */
    private wantedTiles(viewerRel: V3, radius: number): Map<string, TileId> {
        const env = this.env;
        const out = new Map<string, TileId>();
        if (length(viewerRel) - env.radius > this.maxAltitude) return out;
        const d = normalize(viewerRel);
        const [lat, lon] = dirToLatLon(d);
        if (Math.abs(lat) > 84) return out;
        const here = tileOf(lat, lon, CITY_ZOOM);
        const n = 2 ** CITY_ZOOM;
        const tileM = 2 * Math.PI * env.radius * Math.cos(lat * Math.PI / 180) / n;
        const k = Math.ceil(radius / Math.max(tileM, 1)) + 1;
        const halfDiag = tileM * Math.SQRT1_2;
        for (let dy = -k; dy <= k; dy++) {
            const y = here.y + dy;
            if (y < 0 || y >= n) continue;
            for (let dx = -k; dx <= k; dx++) {
                const x = (((here.x + dx) % n) + n) % n;
                const id = { z: CITY_ZOOM, x, y };
                const ang = Math.acos(Math.max(-1, Math.min(1, dot(tileCenterDir(id), d))));
                if (ang * env.radius - halfDiag <= radius) out.set(tileName(id), id);
            }
        }
        return out;
    }

    /**
     * Streams tiles around `viewer` (world): queues what is wanted, works on the nearest tiles for
     * up to `budgetMs`, and hands back tiles finished and dropped this call.
     */
    update(viewer: V3, budgetMs: number): CityUpdate {
        const env = this.env;
        const rel = sub(viewer, env.center);
        this.viewer = rel;
        const wanted = this.wantedTiles(rel, this.radius);
        // Keep what is drawn a little past the radius, so walking along the edge doesn't churn.
        const keep = this.wantedTiles(rel, this.radius * 1.3);
        const out: CityUpdate = { created: [], destroyed: [] };
        for (const [k, t] of [...this.live]) if (!keep.has(k)) { this.live.delete(k); out.destroyed.push(t); }
        for (const k of [...this.jobs.keys()]) if (!keep.has(k)) this.jobs.delete(k);
        for (const [k, id] of wanted) {
            if (this.live.has(k) || this.jobs.has(k) || this.failed.has(k)) continue;
            this.jobs.set(k, { id, data: null, loading: false, notBefore: 0, attempts: 0, build: null, lookup: null });
        }
        this.wanted = wanted;
        this.work(budgetMs, out);
        return out;
    }

    /** Nearest jobs first. */
    private ordered(): [string, Job][] {
        const v = normalize(this.viewer);
        return [...this.jobs].sort((a, b) => dot(tileCenterDir(b[1].id), v) - dot(tileCenterDir(a[1].id), v));
    }

    private work(budgetMs: number, out: CityUpdate): void {
        const start = nowMs();
        const t = start;
        const order = this.ordered();
        // Downloads, nearest first.
        for (const [k, job] of order) {
            if (this.loading >= LOADS) break;
            if (job.data || job.loading || job.notBefore > t) continue;
            job.loading = true;
            this.loading++;
            this.loader.load(job.id).then(res => {
                job.loading = false;
                this.onLoaded?.();
                if (this.jobs.get(k) !== job) return;
                if ("ok" in res) {
                    try { job.data = parseTile(job.id, res.ok, this.env.radius); }
                    catch (e) { this.fail(k, `unreadable: ${(e as Error).message}`); }
                } else if ("missing" in res) job.data = emptyOsmTile();
                else {
                    job.attempts++;
                    if (job.attempts >= 4) this.fail(k, res.error);
                    else job.notBefore = nowMs() + (500 << job.attempts);
                }
            }).finally(() => { this.loading--; });
        }
        // Building, nearest first, within the budget (one slice at least).
        let worked = false;
        for (const [k, job] of order) {
            if (!job.data || job.notBefore > t) continue;
            if (worked && nowMs() - start >= budgetMs) break;
            worked = true;
            if (!job.build) { job.lookup = new Lookup("gate"); job.build = buildTile(job.id, job.data, this.env, job.lookup); }
            for (;;) {
                const step = job.build.next();
                if (step.done) {
                    job.build = null;
                    const built = step.value;
                    if (built) {
                        this.jobs.delete(k);
                        this.live.set(k, [job.id, { origin: built.origin, basis: built.basis, placements: built.placements, settlements: built.settlements,
                            triangles: built.indices.length / 3, roads: built.roads, roadLines: built.roadLines }]);
                        out.created.push([job.id, built]);
                    } else {
                        // Elevation under it is still downloading: try again shortly.
                        job.notBefore = nowMs() + 120;
                    }
                    break;
                }
                if (nowMs() - start >= budgetMs) break;
            }
        }
    }

    private fail(k: string, e: string): void {
        this.jobs.delete(k);
        this.failed.add(k);
        this.lastErrors.push(`tile ${k}: ${e}`);
        if (this.lastErrors.length > 8) this.lastErrors.shift();
    }

    stats(): CityStats {
        const s: CityStats = { enabled: true, live: this.live.size, wanted: this.wanted.size, pending: this.jobs.size, failed: this.failed.size, buildings: 0, houses: 0, roads: 0, triangles: 0 };
        for (const [, t] of this.live.values()) {
            s.buildings += t.placements.length;
            for (const p of t.placements) if (p.kind === "house") s.houses++;
            s.roads += t.roads;
            s.triangles += t.triangles;
        }
        return s;
    }

    /** Whether `update` would have something to do right now (not only downloads to wait for). */
    hasWork(): boolean {
        const t = nowMs();
        for (const job of this.jobs.values()) {
            if (job.notBefore > t) continue;
            if (job.data || (!job.loading && this.loading < LOADS)) return true;
        }
        return false;
    }

    /** True while anything wanted is still loading or building. */
    busy(): boolean {
        for (const k of this.wanted.keys()) if (!this.live.has(k) && !this.failed.has(k)) return true;
        return false;
    }

    /** Placements within `radius` of `point` (world), nearest first, at most `limit`. */
    near(point: V3, radius: number, kind: "house" | "box" | undefined, limit: number): [number, Placement][] {
        const out: [number, Placement][] = [];
        for (const [, t] of this.live.values()) {
            for (const p of t.placements) {
                if (kind && p.kind !== kind) continue;
                const d = distance(p.anchor, point);
                if (d <= radius) out.push([d, p]);
            }
        }
        out.sort((a, b) => a[0] - b[0] || (a[1].key < b[1].key ? -1 : a[1].key > b[1].key ? 1 : 0));
        if (out.length > limit) out.length = limit;
        return out;
    }

    /** Roads (center lines) with a point's bounding box within `radius` meters of (lat, lon). */
    roadsNear(lat: number, lon: number, radius: number): RoadLine[] {
        const dlat = radius / 110540;
        const dlon = radius / (111320 * Math.max(Math.abs(Math.cos(lat * Math.PI / 180)), 1e-6));
        const out: RoadLine[] = [];
        for (const [, t] of this.live.values()) for (const r of t.roadLines) {
            if (lat >= r.bounds[0] - dlat && lat <= r.bounds[2] + dlat && lon >= r.bounds[1] - dlon && lon <= r.bounds[3] + dlon) out.push(r);
        }
        return out;
    }

    /** Forget tiles that failed so they are tried again. */
    retryFailed(): void { this.failed.clear(); }

    clear(): [TileId, LiveTile][] {
        const gone = [...this.live.values()];
        this.live.clear();
        this.jobs.clear();
        this.wanted.clear();
        return gone;
    }
}

