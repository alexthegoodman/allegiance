// Earth and the one height function everything agrees on: the chunk builder samples it for
// vertices, the walker for footing, the flying car for landing, the city layer for where
// buildings and roads stand. The surface is a function of the unit direction from the planet's
// center (ported from QuadPlanet's planet.rs, Earth's half: Allegiance has no procedural planets).
//
// Earth is real elevation (elevation.ts: SRTM-derived tiles with ocean bathymetry) and nothing
// else, so buildings and roads placed from OpenStreetMap (city.ts) sit exactly on the ground.
// Rocky ground is only textured (from the data's own slope), not raised.

import { type V3, add, addScaled, anyPerpendicular, clamp, cross, dirToLatLon, dot, normalize, rotateAround, scale, smoothstep, sub } from "./math";
import { ElevationSource, type Lookup, slopeOf } from "./elevation";
import { Simplex3 } from "./noise";
import type { PlanetDef } from "../qp_planet";
import type { ChunkDetail } from "../qp_config";

export type Rgb = [number, number, number];
export type Rgba = [number, number, number, number];

/** Deepest quadtree a planet may use, counting the root: enough for sub-meter cells on Earth. */
export const MAX_CHUNK_LEVELS = 21;
/** Existing border grid and default interior: N quads, N+1 vertices per side. */
export const CHUNK_SEGMENTS = 16;
/** Target size of a leaf cell (world units): the deepest level is the first at least this fine. */
export const LEAF_CELL = 0.8;

/** Resolves and validates a detail setting into per-level vertex counts, leaf first. */
export function chunkResolutions(detail: ChunkDetail): number[] {
    let sizes: number[];
    if (detail.mode === "half") {
        const { leafVertices, levels } = detail;
        if (!Number.isInteger(levels) || levels < 1 || levels > MAX_CHUNK_LEVELS) throw new Error(`Chunk levels must be an integer from 1 to ${MAX_CHUNK_LEVELS} (including the root).`);
        sizes = Array.from({ length: levels }, (_, i) => Math.max(3, Math.floor(leafVertices / 2 ** i)));
        sizes[0] = leafVertices;
    } else sizes = [...detail.verticesPerLevel];
    if (!sizes.length || sizes.length > MAX_CHUNK_LEVELS || sizes.some(v => !Number.isFinite(v) || !Number.isInteger(v) || v < 3 || v > 257)) {
        throw new Error(`Specify 1-${MAX_CHUNK_LEVELS} levels, each with 3-257 vertices per side.`);
    }
    return sizes;
}

/** What the ground is at one spot. */
export interface SurfaceSample {
    /** Terrain height above the mean radius (can be negative under the sea). */
    terrain: number;
    /** Where you stand / what is drawn: max(terrain, 0) on a planet with a sea. */
    surface: number;
    /** True where the drawn surface is sea, not land. */
    sea: boolean;
    /** 0..1: how much of this spot is rocky outcrop (for coloring). */
    rock: number;
    /** -1..1: slow patchiness. */
    patch: number;
}

export const NO_SAMPLE: SurfaceSample = { terrain: 0, surface: 0, sea: false, rock: 0, patch: 0 };

/** Earth's ground from an elevation (meters above sea level): what Planet.sample draws and what
 * the city layer stands buildings and roads on, so both agree exactly. */
export function earthSurface(height: number, hasSea: boolean): SurfaceSample {
    if (hasSea && height <= 0) return { terrain: Math.min(height, -0.01), surface: 0, sea: true, rock: 0, patch: 0 };
    return { terrain: height, surface: height, sea: false, rock: 0, patch: 0 };
}

/** Highest mountain on Earth (Everest, 8,849 m) with a little headroom. */
const EARTH_RELIEF = 8900;

/** Noise shared by every planet for vertex color variation. */
const JITTER = new Simplex3(77);
const COLOR_NOISE = new Simplex3(4711);

/** How many octaves of a noise layer a mesh with this sample spacing can show. */
function octavesFor(period: number, lacunarity: number, spacing: number): number {
    return Math.log(period / (3 * spacing)) / Math.log(lacunarity) + 1;
}

function mix(a: Rgb, b: Rgb, t: number): Rgb {
    const k = clamp(t, 0, 1);
    return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
}

export class Planet {
    readonly sizes: number[] | null;
    private noise: Simplex3;
    private finest: number;

    constructor(readonly def: PlanetDef, readonly elevation: ElevationSource, defaultDetail?: ChunkDetail) {
        const detail = def.chunkDetail ?? defaultDetail;
        this.sizes = detail ? chunkResolutions(detail) : null;
        this.noise = new Simplex3(def.seed);
        this.finest = this.computeFinest();
    }

    /** Edge length of a quadtree node of this level on the planet's surface (world units). */
    levelWorldSize(level: number): number { return (2 / 2 ** level) * this.def.radius * (Math.PI / 4); }

    /** Existing border/default grid spacing at this level (world units). */
    levelSpacing(level: number): number { return this.levelWorldSize(level) / CHUNK_SEGMENTS; }

    /** Configured deepest level, or the first whose default cells are at most LEAF_CELL across. */
    maxLevel(): number {
        if (this.sizes) return this.sizes.length - 1;
        return Math.max(1, Math.ceil(Math.log2(this.levelWorldSize(0) / (CHUNK_SEGMENTS * LEAF_CELL))));
    }

    /** Nominal grid width at a level, including endpoints. */
    chunkVertices(level: number): number {
        const s = this.sizes;
        if (!s) return CHUNK_SEGMENTS + 1;
        return s[clamp(s.length - 1 - level, 0, s.length - 1)];
    }

    /** Per-level vertex counts, leaf first (for the tools). */
    verticesPerLevel(): number[] {
        const m = this.maxLevel();
        return Array.from({ length: m + 1 }, (_, j) => this.chunkVertices(m - j));
    }

    private computeFinest(): number {
        const level = this.maxLevel();
        return Math.min(this.levelSpacing(level), this.levelWorldSize(level) / (this.chunkVertices(level) - 1));
    }

    /** The finest spacing anything samples at: the deepest chunks' grid. */
    finestSpacing(): number { return this.finest; }

    /** Largest height above sea level the terrain can reach (for horizon culling). */
    maxRelief(): number { return EARTH_RELIEF; }

    /** The lowest ground that can block a view (a sea is flat at the mean radius). */
    lowestBlockingRadius(): number { return this.def.hasSea ? this.def.radius : this.def.radius - this.def.continentHeight; }

    /** Noise coordinates for a layer whose largest features are `period` world units across. */
    private layer(d: V3, period: number, offset: number): V3 {
        const f = this.def.radius / period;
        return [d[0] * f + offset, d[1] * f - offset * 0.7, d[2] * f + offset * 0.3];
    }

    /**
     * Terrain at the unit direction `d`. `spacing` is the distance between the samples being
     * taken (a chunk's grid step): coarse chunks get a smoother, band-limited version.
     */
    sample(d: V3, spacing: number, lk: Lookup): SurfaceSample {
        const sp = Math.max(spacing, this.finest);
        const [lat, lon] = dirToLatLon(d);
        const e = this.elevation.sample(lat, lon, sp, lk);
        const m = this.layer(d, 900, 57.1);
        const patch = this.noise.fbm(m[0], m[1], m[2], 3, 2, 0.5, octavesFor(900, 2, sp));
        const s = earthSurface(e.height, this.def.hasSea);
        s.patch = patch;
        if (!s.sea) {
            const steep = smoothstep(0.35, 0.9, slopeOf(e));
            s.rock = clamp(Math.max(steep, smoothstep(0.1, 0.45, patch) * 0.35) * 0.8, 0, 1);
        }
        return s;
    }

    /** Distance from the planet's center to the drawn surface along the unit direction `d`. */
    surfaceRadius(d: V3, spacing: number, lk: Lookup): number {
        return this.def.radius + this.sample(d, spacing, lk).surface;
    }

    /**
     * Surface normal at direction `d` by central differences on the sphere (`step` in world
     * units) of the surface band-limited to `spacing`. The tangent frame depends only on `d`, so
     * any two chunks asking about the same point get exactly the same normal.
     */
    surfaceNormal(d: V3, step: number, spacing: number, lk: Lookup): V3 {
        const up = normalize(d);
        const t1 = anyPerpendicular(up);
        const t2 = cross(up, t1);
        const a = this.def.radius;
        const at = (o1: number, o2: number): V3 => {
            const dd = normalize(add(up, add(scale(t1, o1 / a), scale(t2, o2 / a))));
            return scale(dd, this.surfaceRadius(dd, spacing, lk));
        };
        const px = at(step, 0), nx = at(-step, 0), pz = at(0, step), nz = at(0, -step);
        const n = normalize(cross(sub(px, nx), sub(pz, nz)));
        return dot(n, up) < 0 ? scale(n, -1) : n;
    }

    /**
     * Biome color from height, slope (`upDot` = dot(surface normal, radial up)), latitude and a
     * little noise, plus in alpha the rock weight for the shader's textures. `spacing` is the
     * mesh's sample spacing: a thin band like the beach can only be drawn where the mesh is fine
     * enough to resolve it.
     */
    color(s: SurfaceSample, upDot: number, d: V3, spacing: number): Rgba {
        const jf = this.def.radius / 9;
        const jitter = JITTER.noise(d[0] * jf, d[1] * jf, d[2] * jf);
        return this.earthColor(s, upDot, d, jitter, spacing);
    }

    /** Bare earth showing through in patches tens of meters across, on meshes fine enough to hold them. */
    private bareEarth(c: Rgb, d: V3, spacing: number): Rgb {
        const fine = 1 - smoothstep(8, 30, spacing);
        if (fine <= 0) return c;
        const k = this.def.radius / 25;
        const m = COLOR_NOISE.noise(d[0] * k, d[1] * k, d[2] * k);
        return mix(c, this.def.palette.beach, smoothstep(0.35, 0.75, m) * fine * 0.4);
    }

    /**
     * Earth's biomes from latitude and real elevation: forest and grassland, the subtropical
     * desert belts, tundra toward the poles, and a snow line that drops from ~5 km in the tropics
     * to sea level in the Arctic and Antarctic.
     */
    private earthColor(s: SurfaceSample, upDot: number, d: V3, jitter: number, spacing: number): Rgba {
        const DESERT: Rgb = [0.80, 0.67, 0.46];
        const TUNDRA: Rgb = [0.46, 0.46, 0.37];
        const SEA_ICE: Rgb = [0.86, 0.9, 0.94];
        const pal = this.def.palette;
        const alat = Math.abs(dirToLatLon(d)[0]);
        if (s.sea) {
            const depth = clamp(-s.terrain / 4000, 0, 1);
            let c = mix(pal.shallowWater, pal.deepWater, Math.sqrt(depth));
            c = mix(c, SEA_ICE, smoothstep(76, 82, alat + jitter * 2));
            return [c[0], c[1], c[2], 0];
        }
        const h = s.terrain;
        let c = mix(pal.lowland, pal.highland, smoothstep(200, 2600, h + jitter * 150));
        const dry = smoothstep(0, 1, 1 - Math.abs((alat - 24) / 13)) * (0.55 + 0.45 * smoothstep(-0.4, 0.4, s.patch + jitter * 0.3));
        c = mix(c, DESERT, dry);
        c = mix(c, TUNDRA, smoothstep(52, 66, alat + jitter * 3) * 0.75);
        c = mix(c, pal.highland, smoothstep(-0.1, 0.35, s.patch) * 0.25);
        c = this.bareEarth(c, d, spacing);
        c = mix(c, pal.rock, s.rock * 0.8);
        if (h < 4) {
            const beach = (1 - smoothstep(1.5, 4, h)) * (1 - smoothstep(12, 40, spacing));
            c = mix(c, pal.beach, beach);
        }
        const steep = 1 - smoothstep(0.72, 0.9, upDot);
        c = mix(c, pal.rock, steep * 0.9);
        const snowLine = 5000 - 5400 * smoothstep(22, 78, alat) + jitter * 180;
        const snow = smoothstep(snowLine, snowLine + 300, h) * smoothstep(0.62, 0.8, upDot);
        c = mix(c, pal.snow, snow);
        const v = 1 + jitter * 0.07;
        const rock = clamp(Math.max(s.rock, steep), 0, 1) * (1 - snow);
        return [c[0] * v, c[1] * v, c[2] * v, rock];
    }

    /**
     * A walkable spot near the preferred direction: dry land with a flat patch around it. Searches
     * a spiral of directions around `preferred` on coarse data first (kilometers wide), then
     * verifies the picks on the ground the walker will stand on. Never waits on the network.
     */
    findLandingSite(preferred: V3, lk: Lookup): V3 {
        const up = normalize(preferred);
        const t1 = anyPerpendicular(up);
        const finest = this.finest;
        const stepAngle = 1500 / this.def.radius;
        const search = 300;
        const minHeight = this.def.hasSea ? 3 : -1e9;
        const check = (d: V3, spacing: number, reach: number): [number, number] | null => {
            const s = this.sample(d, spacing, lk);
            if (s.sea || s.surface < minHeight) return null;
            const n = this.surfaceNormal(d, Math.min(reach, Math.max(spacing, 1.5)), spacing, lk);
            const tilt = 1 - dot(n, d);
            const side = anyPerpendicular(d);
            let spread = 0;
            for (let k = 0; k < 6; k++) {
                const off = rotateAround(side, d, (k / 6) * Math.PI * 2);
                const dd = normalize(addScaled(d, off, reach / this.def.radius));
                const ss = this.sample(dd, spacing, lk);
                spread = Math.max(spread, ss.sea ? Infinity : Math.abs(ss.surface - s.surface));
            }
            return [tilt, spread];
        };
        let best: V3 | null = null;
        let bestScore = Infinity;
        const candidates: V3[] = [];
        for (let i = 0; i < 900; i++) {
            const ang = i * 2.39996;
            const radius = Math.sqrt(i) * stepAngle;
            const axis = rotateAround(t1, up, ang);
            const d = normalize(rotateAround(up, axis, radius));
            const r = check(d, search, search);
            if (!r) continue;
            const [tilt, spread] = r;
            if (tilt < 0.03 && spread < 12) {
                candidates.push(d);
                if (candidates.length >= 12) break;
            }
            const score = tilt * 40 + spread + radius * 2;
            if (score < bestScore) { bestScore = score; best = d; }
        }
        let fineBest: [number, V3] | null = null;
        for (const d of candidates.slice(0, 12)) {
            const r = check(d, finest, 8);
            if (!r) continue;
            const [tilt, spread] = r;
            if (tilt < 0.03 && spread < 1.6) return d;
            const score = tilt * 40 + spread;
            if (!fineBest || score < fineBest[0]) fineBest = [score, d];
        }
        if (fineBest) return fineBest[1];
        return best ?? up;
    }
}
