// The Earth streamer (src/quadplanet/earth/), ported from QuadPlanet's Rust: these are its tests,
// carried over with it - noise against the TypeScript the planets were designed with, the built-in
// elevation tile, gated sampling, the cube-sphere quadtree, OpenStreetMap tiles and the city layer.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { Mulberry32, Simplex3 } from "../../src/quadplanet/earth/noise";
import { decodePng } from "../../src/quadplanet/earth/png";
import { ElevationSource, Lookup, TILE, terrariumHeights, type Tile, type TileId } from "../../src/quadplanet/earth/elevation";
import { Planet, chunkResolutions } from "../../src/quadplanet/earth/planet";
import { cubeToSphere, faceDirection, wrapFace, selectChunks, DEFAULT_LOD } from "../../src/quadplanet/earth/quadtree";
import { buildChunk } from "../../src/quadplanet/earth/chunk_mesh";
import { PlanetStreamer } from "../../src/quadplanet/earth/streamer";
import { decodeTile, ringArea2, GEOM_POLYGON, GEOM_LINE, type Value } from "../../src/quadplanet/earth/mvt";
import { tileOf, tilePointToLatLon, metersPerUnit, parseColour, clipPolyline, parseTile, templateFromTileJson, CITY_ZOOM, type OsmTile } from "../../src/quadplanet/earth/osm";
import { buildTile, minAreaRect, tileFrame, DEFAULT_HOUSE_RULE, MATERIAL_BUILDING_BOX, type CityEnv } from "../../src/quadplanet/earth/city";
import { add, cross, dirToLatLon, distance, dot, latLonToDir, length, normalize, scale, sub, type V3 } from "../../src/quadplanet/earth/math";
import { PLANETS, isEarth } from "../../src/quadplanet/qp_planet";

const R = 6_371_000;
const EARTH = { ...PLANETS.find(isEarth)!, center: [0, 0, 0] as V3 };

function baseTile(): Tile {
    const img = decodePng(new Uint8Array(readFileSync("public/terrarium_z0.png")), b => new Uint8Array(inflateSync(b)));
    expect(img.width).toBe(TILE);
    return { heights: terrariumHeights(img.data, img.channels) };
}

/** Every tile's heights encode its own pixel coordinates, smoothly: a plane in Mercator pixel space. */
function synthetic(delayMs = 0) {
    return async (id: TileId): Promise<Tile> => {
        if (delayMs) await new Promise(r => setTimeout(r, delayMs));
        const heights = new Float32Array(TILE * TILE);
        for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) {
            const gx = (id.x * TILE + x) / 2 ** id.z, gy = (id.y * TILE + y) / 2 ** id.z;
            heights[y * TILE + x] = gx * 0.5 - gy * 0.25;
        }
        return { heights };
    };
}

const flat = (h: number) => async (): Promise<Tile> => ({ heights: new Float32Array(TILE * TILE).fill(h) });

describe("noise", () => {
    it("matches the TypeScript generator the planets were seeded with", () => {
        const r = new Mulberry32(1337);
        expect(r.next()).toBe(0.1844118325971067);
        expect(r.next()).toBe(0.18998925131745636);
        expect(r.next()).toBe(0.8104719922412187);
    });
    it("matches the TypeScript noise layers", () => {
        const n = new Simplex3(1337);
        expect(n.noise(0.3, -1.7, 2.9)).toBeCloseTo(0.06678585599999995, 12);
        expect(n.fbm(0.3, 0.5, 0.7, 5, 2, 0.5, 5)).toBeCloseTo(0.2176894296816669, 12);
        expect(n.ridged(1.3, 0.5, -0.7, 9, 9)).toBeCloseTo(0.37377976156463405, 12);
    });
});

describe("elevation", () => {
    it("has oceans, mountains and ice sheets in the built-in tile", () => {
        const src = new ElevationSource(baseTile(), null, 13, R);
        const lk = new Lookup("fallback");
        expect(src.sample(0, -150, 1e5, lk).height).toBeLessThan(-3000);
        expect(src.sample(33, 88, 1e5, lk).height).toBeGreaterThan(3000);
        expect(src.sample(23, 12, 1e5, lk).height).toBeGreaterThan(0);
        expect(src.poleNorth).toBeLessThan(-1000);
        expect(src.poleSouth).toBeGreaterThan(1500);
        expect(src.sample(-80, 90, 1e5, lk).height).toBeGreaterThan(3000);
        expect(src.sample(72, -40, 1e5, lk).height).toBeGreaterThan(2500);
    });
    it("picks the zoom matching the mesh", () => {
        const src = new ElevationSource(baseTile(), null, 13, R);
        expect(src.zoomFor(0, 200_000)).toBe(0);
        expect(src.zoomFor(0, 20)).toBe(13);
        expect(src.zoomFor(0, 1000)).toBeGreaterThanOrEqual(7);
        expect(src.zoomFor(0, 1000)).toBeLessThanOrEqual(8);
        expect(src.zoomFor(60, 1000)).toBeLessThan(src.zoomFor(0, 1000));
    });
    it("gates on tiles in flight, then agrees with a source that has them", async () => {
        const src = new ElevationSource(baseTile(), synthetic(), 12, R);
        const gate = new Lookup("gate");
        src.sample(10, 20, 30, gate);
        expect(gate.missing).toBe(true);
        expect(await src.waitIdle(10000)).toBe(true);
        const again = new Lookup("gate");
        const a = src.sample(10, 20, 30, again);
        expect(again.missing).toBe(false);
        const other = new ElevationSource(baseTile(), synthetic(), 12, R);
        other.sample(10, 20, 30, new Lookup("fallback"));
        await other.waitIdle(10000);
        expect(other.sample(10, 20, 30, new Lookup("fallback")).height).toBe(a.height);
    });
    it("interpolates smoothly across tile seams", async () => {
        const src = new ElevationSource(baseTile(), synthetic(), 6, R);
        const n = TILE * 64;
        // Each lookup stops at the first tile it lacks: sample until nothing more is asked for.
        for (let round = 0; round < 8; round++) {
            for (let k = -20; k < 20; k++) src.sample(0, 5.625 + k * 0.001, 1, new Lookup("fallback"));
            await src.waitIdle(10000);
        }
        for (let k = -20; k < 20; k++) {
            const lon = 5.625 + k * 0.001;
            const e = src.sample(0, lon, 1, new Lookup("fallback"));
            const x = ((lon + 180) / 360) * n - 0.5, y = n / 2 - 0.5;
            expect(Math.abs(e.height - (x * 0.5 - y * 0.25) / 64)).toBeLessThan(1e-3);
        }
    });
});

describe("planet", () => {
    it("resolves chunk detail like the config", () => {
        expect(chunkResolutions({ mode: "half", leafVertices: 64, levels: 8 })).toEqual([64, 32, 16, 8, 4, 3, 3, 3]);
        for (const bad of [0, 2, 3.5, 258, NaN, Infinity]) expect(() => chunkResolutions({ mode: "half", leafVertices: bad, levels: 8 })).toThrow();
        expect(() => chunkResolutions({ mode: "explicit", verticesPerLevel: [] })).toThrow();
    });
    it("is walkable at its finest level", () => {
        const p = new Planet(EARTH, new ElevationSource(baseTile(), null, 13, R));
        const l = p.maxLevel();
        const chunk = p.levelWorldSize(l);
        const cell = chunk / (p.chunkVertices(l) - 1);
        expect(chunk).toBeGreaterThan(8);
        expect(chunk).toBeLessThan(40);
        expect(cell).toBeLessThan(0.5);
        expect(p.finestSpacing()).toBe(cell);
    });
    it("has real continents offline, and a sandy Sahara", () => {
        const p = new Planet(EARTH, new ElevationSource(baseTile(), null, 13, R));
        const lk = new Lookup("fallback");
        const at = (lat: number, lon: number) => p.sample(latLonToDir(lat, lon), 50_000, lk);
        expect(at(0, -150).sea).toBe(true);
        expect(at(-15, -30).sea).toBe(true);
        expect(at(23, 12).sea).toBe(false);
        expect(at(-25, 135).sea).toBe(false);
        expect(at(33, 88).terrain).toBeGreaterThan(3000);
        const c = p.color(at(23, 12), 1, latLonToDir(23, 12), 50_000);
        expect(c[0]).toBeGreaterThan(c[2] + 0.2);
    });
    it("finds flat dry landing sites", () => {
        const p = new Planet(EARTH, new ElevationSource(baseTile(), null, 13, R));
        const d = p.findLandingSite(normalize([0.55, 0.42, 0.72]), new Lookup("fallback"));
        const lk = new Lookup("fallback");
        expect(p.sample(d, 0, lk).sea).toBe(false);
        expect(dot(p.surfaceNormal(d, 1.5, 0, lk), d)).toBeGreaterThan(0.9);
    });
});

describe("quadtree", () => {
    it("maps every face onto the unit sphere", () => {
        for (let face = 0; face < 6; face++) for (const [a, b] of [[-1, -1], [0, 0], [1, 0.3], [-0.7, 1]]) {
            expect(Math.abs(length(faceDirection(face, a, b)) - 1)).toBeLessThan(1e-12);
        }
        expect(distance(cubeToSphere(1, 1, 1), normalize([1, 1, 1]))).toBeLessThan(1e-15);
    });
    it("joins neighbouring faces without a seam", () => {
        for (const b of [-1, -0.5, 0, 0.8, 1]) expect(distance(faceDirection(0, 1, b), faceDirection(5, -1, b))).toBeLessThan(1e-12);
    });
    it("carries neighbour lookups across cube edges", () => {
        const [f, a, b] = wrapFace(0, 1.001, 0.25);
        expect(f).toBe(5);
        expect(Math.abs(a - (-1 + 0.001))).toBeLessThan(1e-2);
        expect(Math.abs(b - 0.25)).toBeLessThan(1e-2);
    });
    it("streams down to the finest level at the viewer's feet, within the triangle budget, with matching borders", () => {
        const p = new Planet(EARTH, new ElevationSource(baseTile(), null, 13, R));
        const d = latLonToDir(51.5, -0.12);
        const viewer = scale(d, R + p.sample(d, 0, new Lookup("fallback")).surface + 2);
        const sel = selectChunks(p, 0, viewer, DEFAULT_LOD);
        expect(Math.max(...sel.leaves.map(([n]) => n.level))).toBe(p.maxLevel());
        const s = new PlanetStreamer({ ...DEFAULT_LOD }, 2_000_000);
        const u = s.update([p], viewer, Infinity, Infinity);
        expect(u.stats.pending).toBe(0);
        expect(u.stats.triangles).toBeLessThanOrEqual(2_200_000);
        expect(u.stats.hidden).toBeGreaterThan(0);
        // Neighbours share border vertices exactly: every border vertex of every chunk is matched
        // by a vertex of some other chunk, in world space (render-origin relative here).
        const keyOf = (x: number, y: number, z: number) => `${x.toFixed(3)},${y.toFixed(3)},${z.toFixed(3)}`;
        const all = new Map<string, number>();
        const nearMeshes = u.created.filter(([, n]) => n.level >= p.maxLevel() - 2);
        for (const [, , m] of nearMeshes) {
            for (let i = 0; i < m.vertexCount; i++) {
                const k = keyOf(m.origin[0] + m.vertexData[i * 12], m.origin[1] + m.vertexData[i * 12 + 1], m.origin[2] + m.vertexData[i * 12 + 2]);
                all.set(k, (all.get(k) ?? 0) + 1);
            }
        }
        const shared = [...all.values()].filter(c => c >= 2).length;
        expect(shared).toBeGreaterThan(100);
    });
    it("builds chunks whose triangles face outward", () => {
        const p = new Planet(EARTH, new ElevationSource(baseTile(), null, 13, R));
        const d = latLonToDir(46, 7.6);
        const sel = selectChunks(p, 0, scale(d, R + 5000), DEFAULT_LOD);
        const [n] = sel.leaves.sort((a, b) => distance(a[1], scale(d, R)) - distance(b[1], scale(d, R)))[0];
        const m = buildChunk(p, n)!;
        expect(m).not.toBeNull();
        let outward = 0;
        for (let t = 0; t < m.indexData.length; t += 3) {
            const v = (i: number): V3 => [m.vertexData[i * 12], m.vertexData[i * 12 + 1], m.vertexData[i * 12 + 2]];
            const a = v(m.indexData[t]), b = v(m.indexData[t + 1]), c = v(m.indexData[t + 2]);
            if (dot(cross(sub(b, a), sub(c, a)), normalize(m.origin)) > 0) outward++;
        }
        expect(outward).toBe(m.triangles);
    });
});

// --- MVT: a test encoder -------------------------------------------------------------------------

function varint(out: number[], v: number): void {
    for (;;) {
        const b = v % 128;
        v = Math.floor(v / 128);
        if (v === 0) { out.push(b); return; }
        out.push(b | 0x80);
    }
}
function fieldBytes(out: number[], field: number, bytes: ArrayLike<number>): void {
    varint(out, field * 8 + 2);
    varint(out, bytes.length);
    for (let i = 0; i < bytes.length; i++) out.push(bytes[i]);
}
const zz = (v: number) => ((v << 1) ^ (v >> 31)) >>> 0;
const enc = new TextEncoder();

/** Encodes a layer of features for tests: (geometry type, properties, rings). */
function encodeLayer(name: string, features: [number, [string, Value][], [number, number][][]][]): number[] {
    const keys: string[] = [], values: Value[] = [], body: number[] = [];
    fieldBytes(body, 1, enc.encode(name));
    for (const [kind, props, rings] of features) {
        const f: number[] = [], tags: number[] = [];
        for (const [k, v] of props) {
            let ki = keys.indexOf(k); if (ki < 0) { keys.push(k); ki = keys.length - 1; }
            let vi = values.indexOf(v); if (vi < 0) { values.push(v); vi = values.length - 1; }
            tags.push(ki, vi);
        }
        const t: number[] = [];
        for (const v of tags) varint(t, v);
        fieldBytes(f, 2, t);
        varint(f, 3 * 8);
        varint(f, kind);
        const g: number[] = [];
        let x = 0, y = 0;
        for (const ring of rings) {
            varint(g, 1 | (1 << 3));
            varint(g, zz(ring[0][0] - x)); varint(g, zz(ring[0][1] - y));
            [x, y] = ring[0];
            varint(g, 2 | ((ring.length - 1) << 3));
            for (const p of ring.slice(1)) { varint(g, zz(p[0] - x)); varint(g, zz(p[1] - y)); [x, y] = p; }
            if (kind === 3) varint(g, 7 | (1 << 3));
        }
        fieldBytes(f, 4, g);
        fieldBytes(body, 2, f);
    }
    for (const k of keys) fieldBytes(body, 3, enc.encode(k));
    for (const v of values) {
        const vb: number[] = [];
        if (typeof v === "string") fieldBytes(vb, 1, enc.encode(v));
        else if (typeof v === "boolean") { varint(vb, 7 * 8); varint(vb, v ? 1 : 0); }
        else if (Number.isInteger(v)) { varint(vb, 4 * 8); varint(vb, v); }
        else { varint(vb, 3 * 8 + 1); const b = new Uint8Array(8); new DataView(b.buffer).setFloat64(0, v, true); vb.push(...b); }
        fieldBytes(body, 4, vb);
    }
    varint(body, 5 * 8);
    varint(body, 4096);
    const tile: number[] = [];
    fieldBytes(tile, 3, body);
    return tile;
}

describe("vector tiles", () => {
    it("decodes polygons, lines and properties", () => {
        const square: [number, number][][] = [[[100, 100], [200, 100], [200, 200], [100, 200]]];
        const tile = [...encodeLayer("building", [[3, [["render_height", 9], ["colour", "#aa8844"]], square]]),
            ...encodeLayer("transportation", [[2, [["class", "minor"]], [[[0, 0], [10, -5], [20, 7]]]]])];
        const layers = decodeTile(new Uint8Array(tile), []);
        expect(layers.length).toBe(2);
        expect([layers[0].name, layers[0].extent]).toEqual(["building", 4096]);
        expect(layers[0].features[0].geomType).toBe(GEOM_POLYGON);
        expect(layers[0].features[0].geometry).toEqual(square);
        expect(layers[0].features[0].properties.get("render_height")).toBe(9);
        expect(ringArea2(layers[0].features[0].geometry[0])).toBeGreaterThan(0);
        expect(layers[1].features[0].geomType).toBe(GEOM_LINE);
        expect(layers[1].features[0].geometry).toEqual([[[0, 0], [10, -5], [20, 7]]]);
        expect(decodeTile(new Uint8Array(tile), ["transportation"]).length).toBe(1);
    });
    it("rejects truncated tiles", () => {
        const tile = encodeLayer("building", [[3, [], [[[0, 0], [5, 0], [5, 5]]]]]);
        expect(() => decodeTile(new Uint8Array(tile.slice(0, tile.length - 3)), [])).toThrow();
    });
    it("round-trips tile coordinates", () => {
        const id = tileOf(46.0207, 7.7491, 14);
        expect([id.x, id.y]).toEqual([8544, 5827]);
        const nw = tilePointToLatLon(id, 4096, 0, 0), se = tilePointToLatLon(id, 4096, 4096, 4096);
        expect(nw[0] > 46.0207 && se[0] < 46.0207 && nw[1] < 7.7491 && se[1] > 7.7491).toBe(true);
        expect(Math.abs(metersPerUnit(14, 4096, 0, R) - 0.5966)).toBeLessThan(1e-3);
    });
    it("parses colours", () => {
        expect(parseColour("#ff0000")).toEqual([1, 0, 0]);
        expect(parseColour("#0f0")).toEqual([0, 1, 0]);
        expect(parseColour("Brown")).not.toBeNull();
        expect(parseColour("#12")).toBeNull();
        expect(parseColour("plaid")).toBeNull();
    });
    it("clips lines to the tile and splits them", () => {
        const pieces = clipPolyline([[-10, 5], [5, 5], [5, 20], [5, -5]], 0, 10);
        expect(pieces).toEqual([[[0, 5], [5, 5], [5, 10]], [[5, 10], [5, 0]]]);
        expect(clipPolyline([[-5, -5], [-1, -1]], 0, 10)).toEqual([]);
    });
    it("reads buildings and roads, and keeps edge buildings in one tile", () => {
        const id = { z: 14, x: 8544, y: 5827 };
        const bytes = [...encodeLayer("building", [
            [3, [["render_height", 9], ["render_min_height", 0]], [[[100, 100], [140, 100], [140, 130], [100, 130]]]],
            [3, [["render_height", 9]], [[[-40, 100], [10, 100], [10, 130], [-40, 130]]]],
            [3, [["render_height", 6], ["colour", "#808080"]], [[[200, 200], [260, 200], [260, 260], [200, 260]], [[210, 210], [210, 220], [220, 220], [220, 210]], [[300, 300], [330, 300], [330, 320], [300, 320]]]],
            [3, [["render_height", 20], ["hide_3d", true]], [[[500, 500], [600, 500], [600, 600], [500, 600]]]],
        ]), ...encodeLayer("transportation", [
            [2, [["class", "minor"]], [[[-100, 50], [5000, 50]]]],
            [2, [["class", "primary"], ["brunnel", "tunnel"]], [[[0, 60], [100, 60]]]],
            [2, [["class", "ferry"]], [[[0, 70], [100, 70]]]],
        ])];
        const t = parseTile(id, new Uint8Array(bytes), R);
        expect(t.buildings.length).toBe(3);
        expect(t.buildings[0].height).toBe(9);
        expect(t.buildings[2].colour).not.toBeNull();
        const unit = metersPerUnit(14, 4096, 46.02, R);
        expect(Math.abs(t.buildings[0].area - 40 * 30 * unit * unit) / t.buildings[0].area).toBeLessThan(0.01);
        expect(t.roads.length).toBe(1);
        expect(t.roads[0].class).toBe("minor");
        const eastEdge = tilePointToLatLon(id, 4096, 4096, 0)[1];
        expect(Math.abs(t.roads[0].points[t.roads[0].points.length - 1][1] - eastEdge)).toBeLessThan(1e-9);
    });
    it("reads populated places, owning each tile edge once", () => {
        const id = { z: 14, x: 8544, y: 5827 };
        const points: [number, [string, Value][], [number, number][][]][] = [];
        for (const kind of ["city", "town", "village", "hamlet", "isolated_dwelling", "country"]) points.push([1, [["class", kind], ["name", `Place ${kind}`]], [[[100, 100]]]]);
        points.push([1, [["class", "village"], ["name", "Neighbor"]], [[[-1, 100]]]]);
        const tile = parseTile(id, new Uint8Array(encodeLayer("place", points)), R);
        expect(tile.settlements.length).toBe(5);
        expect(tile.settlements[2].kind).toBe("village");
        const [lat, lon] = tilePointToLatLon(id, 4096, 100, 100);
        expect([tile.settlements[2].lat, tile.settlements[2].lon]).toEqual([lat, lon]);
    });
    it("reads the tile URL from TileJSON", () => {
        const json = `{"tilejson":"3.0.0","tiles":["https://tiles.openfreemap.org/planet/20260927_080001_pt/{z}/{x}/{y}.pbf"]}`;
        expect(templateFromTileJson(json)).toBe("https://tiles.openfreemap.org/planet/20260927_080001_pt/{z}/{x}/{y}.pbf");
        expect(templateFromTileJson("{}")).toBeNull();
    });
});

// --- The city layer --------------------------------------------------------------------------------

async function flatEnv(height: number): Promise<CityEnv> {
    const elevation = new ElevationSource(baseTile(), flat(height), 13, R);
    return { center: [0, 0, 0], radius: R, hasSea: true, spacing: 0.6, elevation, rule: { ...DEFAULT_HOUSE_RULE } };
}

function footprint(id: TileId, at: [number, number], w: number, d: number, deg: number): [number, number][] {
    const [origin, [east, , south]] = tileFrame(id, R);
    const north = scale(south, -1);
    const s = Math.sin(deg * Math.PI / 180), c = Math.cos(deg * Math.PI / 180);
    return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([x, y]) => {
        const px = x * w / 2, py = y * d / 2;
        const rx = px * c - py * s + at[0], ry = px * s + py * c + at[1];
        return dirToLatLon(normalize(add(origin, add(scale(east, rx), scale(north, ry)))));
    });
}

function line(id: TileId, a: [number, number], b: [number, number]): [number, number][] {
    const [origin, [east, , south]] = tileFrame(id, R);
    const north = scale(south, -1);
    return [a, b].map(p => dirToLatLon(normalize(add(origin, add(scale(east, p[0]), scale(north, p[1]))))));
}

/** Runs a tile build to the end, letting elevation land when it asks. */
async function build(id: TileId, data: OsmTile, env: CityEnv) {
    for (let attempt = 0; attempt < 20; attempt++) {
        const lk = new Lookup("gate");
        const gen = buildTile(id, data, env, lk);
        let step = gen.next();
        while (!step.done) step = gen.next();
        if (step.value) return step.value;
        await env.elevation.waitIdle(5000);
    }
    throw new Error("never built");
}

describe("city", () => {
    it("fits rotated rectangles", () => {
        const s = Math.sin(Math.PI / 6), c = Math.cos(Math.PI / 6);
        const pts = [[-6, -4], [6, -4], [6, 4], [-6, 4], [0, 4]].map(([x, y]) => [x * c - y * s + 10, x * s + y * c - 5] as [number, number]);
        const r = minAreaRect(pts)!;
        expect(Math.abs(Math.max(r.halfU, r.halfV) - 6)).toBeLessThan(1e-9);
        expect(Math.abs(Math.min(r.halfU, r.halfV) - 4)).toBeLessThan(1e-9);
        expect(Math.abs(r.center[0] - 10)).toBeLessThan(1e-9);
        expect(Math.abs(r.center[1] + 5)).toBeLessThan(1e-9);
    });
    it("makes houses face the street and sit on the ground", async () => {
        const id = tileOf(46.02, 7.75, CITY_ZOOM);
        const env = await flatEnv(1600);
        const b = (ring: [number, number][], height: number) => ({ ring, area: 0, height, minHeight: 0, colour: null });
        const data: OsmTile = {
            settlements: [],
            buildings: [b(footprint(id, [0, 0], 12, 9, 0), 7), b(footprint(id, [200, 0], 40, 25, 15), 30), b(footprint(id, [0, 100], 4, 3, 0), 3)],
            roads: [{ points: line(id, [-100, -20], [100, -20]), class: "minor", bridge: false }],
        };
        const t = await build(id, data, env);
        expect(t.placements.length).toBe(3);
        const house = t.placements[0];
        expect(house.kind).toBe("house");
        expect(Math.abs(house.width - 12)).toBeLessThan(0.05);
        expect(Math.abs(house.depth - 9)).toBeLessThan(0.05);
        const [, [east, up, south]] = tileFrame(id, R);
        expect(dot(house.forward, south)).toBeGreaterThan(0.99);
        expect(dot(house.right, east)).toBeGreaterThan(0.99);
        expect(dot(house.up, up)).toBeGreaterThan(0.9999);
        expect(Math.abs(house.groundMin - 1600)).toBeLessThan(1e-6);
        expect(Math.abs(length(house.anchor) - (R + 1600))).toBeLessThan(1e-3);
        expect(t.placements[1].kind).toBe("box");
        expect(t.placements[2].kind).toBe("box");
        const again = await build(id, data, env);
        expect(again.placements.map(p => p.key)).toEqual(t.placements.map(p => p.key));
        expect(t.roads).toBe(1);
        expect(t.roadLines.length).toBe(1);
        expect(t.roadLines[0].street).toBe(true);
        const flags = new Set<number>();
        for (let i = 0; i < t.vertices.length; i += 12) if (Math.floor(t.vertices[i + 6]) === MATERIAL_BUILDING_BOX) flags.add(Math.floor(t.vertices[i + 7]));
        expect([...flags].sort()).toEqual([1, 2]);
        // Every triangle faces the way its vertex normal says: roofs and roads up, walls out.
        const p = (i: number): [V3, V3] => { const o = i * 12; return [[t.vertices[o], t.vertices[o + 1], t.vertices[o + 2]], [t.vertices[o + 3], t.vertices[o + 4], t.vertices[o + 5]]]; };
        for (let k = 0; k < t.indices.length; k += 3) {
            const [a, n] = p(t.indices[k]), [bb] = p(t.indices[k + 1]), [c] = p(t.indices[k + 2]);
            expect(dot(cross(sub(bb, a), sub(c, a)), n)).toBeGreaterThan(0);
        }
    });
    it("encodes each box vertex's anchor", async () => {
        const id = tileOf(40, -74, CITY_ZOOM);
        const env = await flatEnv(12);
        const t = await build(id, { settlements: [], buildings: [{ ring: footprint(id, [300, -150], 10, 8, 20), area: 0, height: 6, minHeight: 0, colour: null }], roads: [] }, env);
        const p = t.placements[0];
        const [e, u, s] = t.basis;
        const rel = sub(p.anchor, t.origin);
        const anchorL = [dot(rel, e), dot(rel, u), dot(rel, s)];
        for (let i = 0; i < t.vertices.length; i += 12) {
            const v = t.vertices.subarray(i, i + 12);
            expect(Math.floor(v[6])).toBe(MATERIAL_BUILDING_BOX);
            expect(Math.floor(v[7])).toBe(1);
            const dx = (v[6] - MATERIAL_BUILDING_BOX - 0.5) * 4000, dz = (v[7] - 1 - 0.5) * 4000;
            const c = [v[0] - dx, v[1] - v[11], v[2] - dz];
            for (let k = 0; k < 3; k++) expect(Math.abs(c[k] - anchorL[k])).toBeLessThan(0.02);
        }
    });
    it("waits for elevation in flight", async () => {
        const id = tileOf(46.02, 7.75, CITY_ZOOM);
        const env = await flatEnv(5);
        const data: OsmTile = { settlements: [], buildings: [{ ring: footprint(id, [0, 0], 10, 8, 0), area: 0, height: 6, minHeight: 0, colour: null }], roads: [] };
        const lk = new Lookup("gate");
        const gen = buildTile(id, data, env, lk);
        let step = gen.next();
        while (!step.done) step = gen.next();
        expect(step.value).toBeNull();
        expect(lk.missing).toBe(true);
        expect(await build(id, data, env)).not.toBeNull();
    });
});
