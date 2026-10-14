// Chunk meshes: a grid on the sphere displaced by the terrain, with biome vertex colors, in the
// game's vertex layout (position 3, normal 3, uv 2, color 4). Ported from QuadPlanet's mesh.rs;
// see quadtree.ts for the crack-prevention rules the borders follow.

import { type V3, add, addScaled, cross, dot, normalize, scale, sub } from "./math";
import { Lookup } from "./elevation";
import { CHUNK_SEGMENTS, type Planet, type SurfaceSample, NO_SAMPLE } from "./planet";
import { type ChunkNode, EDGE_A_MAX, EDGE_A_MIN, EDGE_B_MAX, EDGE_B_MIN, faceDirection, nodeParamSize } from "./quadtree";

export const VERTEX_FLOATS = 12;

/** Material ids carried in uv.x, read by the shader. */
export const MATERIAL_LAND = 0;
export const MATERIAL_WATER = 1;
export const MATERIAL_ICE = 2;

/** An integer id plus a [0, 1] fraction in one float: id + 0.001 + 0.99 x fraction. */
export function packChunkUv(id: number, fraction: number): number {
    return Math.fround(id + 0.001 + 0.99 * Math.max(0, Math.min(1, fraction)));
}

/**
 * Positions are snapped to this grid (1/1024 m) before being made relative to a chunk's origin,
 * and origins (and the renderer's origin) lie on it too, so two chunks sharing a border vertex put
 * it at bit-identical render positions.
 */
export const POSITION_QUANTUM = 1 / 1024;
export const quantize = (x: number): number => Math.round(x / POSITION_QUANTUM) * POSITION_QUANTUM;
export const quantize3 = (v: V3): V3 => [quantize(v[0]), quantize(v[1]), quantize(v[2])];

export interface ChunkMesh {
    /** Vertex positions are relative to `origin`. */
    vertexData: Float32Array;
    indexData: Uint32Array;
    vertexCount: number;
    triangles: number;
    /** World-space center of the chunk's surface. */
    center: V3;
    /** World-space anchor the vertex positions are relative to (on the position grid). */
    origin: V3;
}

const materialOf = (p: Planet, s: SurfaceSample): number => s.sea ? (p.def.frozenSea ? MATERIAL_ICE : MATERIAL_WATER) : MATERIAL_LAND;

class Out {
    v: number[] = [];
    i: number[] = [];
    push(world: V3, origin: V3, normal: V3, u: number, v: number, c: readonly number[]): number {
        const k = this.v.length / VERTEX_FLOATS;
        this.v.push(quantize(world[0]) - origin[0], quantize(world[1]) - origin[1], quantize(world[2]) - origin[2], normal[0], normal[1], normal[2], u, v, c[0], c[1], c[2], c[3]);
        return k;
    }
}

/**
 * Builds one chunk. Interior vertices are sampled at the chunk's own band limit with normals from
 * their grid neighbours; border vertices at the coarsest band limit of the chunks meeting there,
 * with normals computed from the surface itself. Returns null when elevation it needs is still
 * loading (the streamer retries).
 */
export function buildChunk(p: Planet, n: ChunkNode): ChunkMesh | null {
    const lk = new Lookup("gate");
    const vertices = p.chunkVertices(n.level);
    const mesh = vertices === CHUNK_SEGMENTS + 1 ? buildUniform(p, n, CHUNK_SEGMENTS, lk) : buildVariable(p, n, CHUNK_SEGMENTS, vertices, lk);
    return lk.missing ? null : mesh;
}

/** Band limit at a border vertex, shared by the uniform and variable grid builders. */
function borderBand(i: number, j: number, n: number, stitch: number, spacing: number): number {
    let bit: number;
    if (i === 0 && j === 0) bit = 4;
    else if (i === n && j === 0) bit = 5;
    else if (i === 0 && j === n) bit = 6;
    else if (i === n && j === n) bit = 7;
    else if (j === 0) bit = EDGE_B_MIN;
    else if (j === n) bit = EDGE_B_MAX;
    else if (i === 0) bit = EDGE_A_MIN;
    else if (i === n) bit = EDGE_A_MAX;
    else return spacing;
    return (stitch >> bit) & 1 ? spacing * 2 : spacing;
}

function finish(out: Out, center: V3, origin: V3): ChunkMesh {
    const vertexData = new Float32Array(out.v);
    return { vertexData, indexData: new Uint32Array(out.i), vertexCount: out.v.length / VERTEX_FLOATS, triangles: out.i.length / 3, center, origin };
}

/** The mesh when interior and border resolutions match: an (N+1)^2 grid. */
function buildUniform(p: Planet, n: ChunkNode, segments: number, lk: Lookup): ChunkMesh {
    const nn = segments, v = nn + 1;
    const size = nodeParamSize(n.level);
    const a0 = -1 + n.ia * size, b0 = -1 + n.ib * size;
    const step = size / nn;
    const stitch = n.stitch;
    const bit = (k: number) => ((stitch >> k) & 1) === 1;
    const spacing = p.levelSpacing(n.level);
    // An odd vertex on a stitched edge isn't part of the mesh: the coarse neighbour has none there.
    const skipped = (i: number, j: number) =>
        (j === 0 && i % 2 === 1 && bit(EDGE_B_MIN)) || (j === nn && i % 2 === 1 && bit(EDGE_B_MAX))
        || (i === 0 && j % 2 === 1 && bit(EDGE_A_MIN)) || (i === nn && j % 2 === 1 && bit(EDGE_A_MAX));
    const count = v * v;
    const pos: (V3 | null)[] = new Array(count).fill(null);
    const dirs: V3[] = new Array(count);
    const bands = new Float64Array(count);
    const samples: SurfaceSample[] = new Array(count).fill(NO_SAMPLE);
    for (let j = 0; j <= nn; j++) {
        // A tile is still downloading: the chunk will be thrown away and retried, so stop here.
        if (lk.missing) return finish(new Out(), [0, 0, 0], [0, 0, 0]);
        for (let i = 0; i <= nn; i++) {
            const k = j * v + i;
            const d = faceDirection(n.face, a0 + i * step, b0 + j * step);
            dirs[k] = d;
            if (skipped(i, j)) continue;
            const band = borderBand(i, j, nn, stitch, spacing);
            const s = p.sample(d, band, lk);
            bands[k] = band;
            samples[k] = s;
            pos[k] = addScaled(p.def.center, d, p.def.radius + s.surface);
        }
    }
    // Skipped vertices sit on the straight coarse edge (they only feed their neighbours' normals).
    for (let j = 0; j <= nn; j++) {
        for (let i = 0; i <= nn; i++) {
            const k = j * v + i;
            if (pos[k]) continue;
            const [ka, kb] = j === 0 || j === nn ? [k - 1, k + 1] : [k - v, k + v];
            pos[k] = scale(add(pos[ka]!, pos[kb]!), 0.5);
            samples[k] = samples[ka];
            bands[k] = bands[ka];
        }
    }
    const P = pos as V3[];
    const out = new Out();
    const mid = Math.floor(v / 2) * v + Math.floor(v / 2);
    const origin = quantize3(P[mid]);
    for (let j = 0; j <= nn; j++) {
        for (let i = 0; i <= nn; i++) {
            const k = j * v + i;
            const d = dirs[k];
            const s = samples[k];
            const border = i === 0 || j === 0 || i === nn || j === nn;
            let normal: V3;
            if (s.sea) normal = d; // the sea is flat: shade it with the sphere's normal
            else if (border) normal = p.surfaceNormal(d, bands[k], bands[k], lk);
            else {
                const m = normalize(cross(sub(P[k + 1], P[k - 1]), sub(P[k + v], P[k - v])));
                normal = dot(m, d) < 0 ? scale(m, -1) : m;
            }
            const c = p.color(s, dot(normal, d), d, bands[k]);
            // uv carries (material + u, level + v).
            out.push(P[k], origin, normal, packChunkUv(materialOf(p, s), i / nn), packChunkUv(n.level, j / nn), c);
        }
    }
    // Triangulate each 2x2 block of quads as a fan around its (odd, odd) center vertex, walking the
    // block's rim counter-clockwise. A rim midpoint on a stitched edge is left out, so that side
    // becomes one triangle spanning exactly the coarse neighbour's edge.
    const RIM: [number, number][] = [[-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0]];
    const ring: number[] = [];
    for (let cj = 1; cj < nn; cj += 2) {
        for (let ci = 1; ci < nn; ci += 2) {
            ring.length = 0;
            for (const [di, dj] of RIM) {
                const i = ci + di, j = cj + dj;
                if (skipped(i, j)) continue;
                ring.push(j * v + i);
            }
            const c = cj * v + ci;
            for (let r = 0; r < ring.length; r++) out.i.push(c, ring[r], ring[(r + 1) % ring.length]);
        }
    }
    return finish(out, P[mid], origin);
}

/** Builds only the configured interior and the used border vertices, joined by four triangle strips. */
function buildVariable(p: Planet, n: ChunkNode, edgeSegments: number, vertices: number, lk: Lookup): ChunkMesh {
    const out = new Out();
    const nn = vertices - 1;
    const innerWidth = vertices - 2;
    const size = nodeParamSize(n.level);
    const spacing = p.levelWorldSize(n.level) / nn;
    const borderSpacing = p.levelSpacing(n.level);
    const a0 = -1 + n.ia * size, b0 = -1 + n.ib * size;
    const centerDir = faceDirection(n.face, a0 + size / 2, b0 + size / 2);
    const center = addScaled(p.def.center, centerDir, p.def.radius + p.sample(centerDir, borderSpacing, lk).surface);
    const origin = quantize3(center);
    // The interior-resolution grid including its outer ring: the ring is never drawn (the border
    // vertices are), it only gives the outermost interior vertices neighbours for their normals.
    const v = nn + 1;
    const gridPos: V3[] = new Array(v * v);
    const gridDir: V3[] = new Array(v * v);
    const gridSample: SurfaceSample[] = new Array(v * v);
    for (let j = 0; j < v; j++) {
        // A tile is still downloading: the chunk will be thrown away and retried, so stop here.
        if (lk.missing) return finish(new Out(), center, origin);
        for (let i = 0; i < v; i++) {
            const k = j * v + i;
            const d = faceDirection(n.face, -1 + (n.ia + i / nn) * size, -1 + (n.ib + j / nn) * size);
            const s = p.sample(d, spacing, lk);
            gridDir[k] = d;
            gridSample[k] = s;
            gridPos[k] = addScaled(p.def.center, d, p.def.radius + s.surface);
        }
    }
    const inner: number[][] = [];
    for (let j = 1; j < nn; j++) {
        const row: number[] = [];
        for (let i = 1; i < nn; i++) {
            const k = j * v + i;
            const d = gridDir[k], s = gridSample[k];
            let normal = d;
            if (!s.sea) {
                normal = normalize(cross(sub(gridPos[k + 1], gridPos[k - 1]), sub(gridPos[k + v], gridPos[k - v])));
                if (dot(normal, d) < 0) normal = scale(normal, -1);
            }
            const c = p.color(s, dot(normal, d), d, spacing);
            row.push(out.push(gridPos[k], origin, normal, packChunkUv(materialOf(p, s), i / nn), packChunkUv(n.level, j / nn), c));
        }
        inner.push(row);
    }
    for (let j = 0; j < innerWidth - 1; j++) {
        for (let i = 0; i < innerWidth - 1; i++) {
            const a = inner[j][i], b = inner[j][i + 1], c = inner[j + 1][i + 1], d = inner[j + 1][i];
            out.i.push(a, b, c, a, c, d);
        }
    }
    const edgeStep = size / edgeSegments;
    const es = edgeSegments;
    const borderIds = new Map<number, number>();
    const borderVertex = (i: number, j: number): number => {
        const key = j * (es + 1) + i;
        const known = borderIds.get(key);
        if (known !== undefined) return known;
        // The same arithmetic and band limit as the uniform grid, so shared borders stay bit-identical.
        const d = faceDirection(n.face, a0 + i * edgeStep, b0 + j * edgeStep);
        const band = borderBand(i, j, es, n.stitch, borderSpacing);
        const s = p.sample(d, band, lk);
        const pos = addScaled(p.def.center, d, p.def.radius + s.surface);
        const normal = s.sea ? d : p.surfaceNormal(d, band, band, lk);
        const c = p.color(s, dot(normal, d), d, band);
        const id = out.push(pos, origin, normal, packChunkUv(materialOf(p, s), i / es), packChunkUv(n.level, j / es), c);
        borderIds.set(key, id);
        return id;
    };
    const last = innerWidth - 1;
    const sides: [number, number[]][] = [
        [EDGE_B_MIN, inner[0].slice()],
        [EDGE_A_MAX, inner.map(r => r[last])],
        [EDGE_B_MAX, inner[last].slice().reverse()],
        [EDGE_A_MIN, inner.map(r => r[0]).reverse()],
    ];
    sides.forEach(([bitIndex, innerSide], side) => {
        const stride = (n.stitch >> bitIndex) & 1 ? 2 : 1;
        const outer: number[] = [];
        for (let q = 0; q <= Math.floor(es / stride); q++) {
            const k = q * stride;
            const [i, j] = side === 0 ? [k, 0] : side === 1 ? [es, k] : side === 2 ? [es - k, es] : [0, es - k];
            outer.push(borderVertex(i, j));
        }
        let a = 0, b = 0;
        while (a < outer.length - 1 || b < innerWidth - 1) {
            if (a < outer.length - 1 && (b === innerWidth - 1 || ((a + 1) * stride) / es <= (b + 2) / nn)) {
                out.i.push(outer[a], outer[a + 1], innerSide[b]);
                a++;
            } else {
                out.i.push(outer[a], innerSide[b + 1], innerSide[b]);
                b++;
            }
        }
    });
    return finish(out, center, origin);
}

/** Rough triangle count of a chunk at a level (for the triangle budget). */
export function estimatedTriangles(p: Planet, level: number): number {
    const v = p.chunkVertices(level);
    return v === CHUNK_SEGMENTS + 1 ? 2 * (v - 1) * (v - 1) : 2 * (v - 3) * (v - 3) + 4 * (v + CHUNK_SEGMENTS);
}
