// Level-of-detail simplification for meshes in the packed vertex layout (position 3, normal 3,
// uv 2, color 4: 12 floats a vertex), ported from the engine's mesh_simplify.rs.
//
// Procedural models are built from many small closed parts (a window is a frame, sashes, bars and
// a sill; a house has dozens of windows), and every part has its own vertices along its hard
// edges. A distant copy doesn't need most of them. Simplification here:
//
// 1. Groups triangles by surface: the vertex color and the material id in uv.x's integer part.
// 2. Welds each group's vertices by position, so the parts become connected meshes.
// 3. Drops connected parts smaller than `minFeature` (a door knob, a glazing bar seen end-on).
// 4. Simplifies what is left with meshoptimizer, to an absolute error in meters.
// 5. Writes the result flat shaded: three vertices per triangle with the face normal.

import { MeshoptSimplifier } from "meshoptimizer";

export const VERTEX_FLOATS = 12;

export interface SimplifyParams {
    /** Largest deviation allowed, in mesh units (meters). */
    maxError: number;
    /** Connected parts whose bounding box diagonal is under this are dropped (0 keeps all). */
    minFeature?: number;
    /** Stop once this share of the triangles is left (0..1); the error bound usually stops it first. */
    targetRatio?: number;
}

export interface SimplifyStats { trianglesIn: number; trianglesOut: number; partsDropped: number }

/** Resolves once the meshoptimizer module is ready (WebAssembly). */
export const simplifierReady: Promise<void> = MeshoptSimplifier.ready;

/** Simplifies a packed mesh. Returns flat-shaded packed vertices and their indices. */
export function simplifyPacked(vertices: Float32Array, indices: Uint32Array, params: SimplifyParams): { vertexData: Float32Array; indexData: Uint32Array; stats: SimplifyStats } {
    const stats: SimplifyStats = { trianglesIn: Math.floor(indices.length / 3), trianglesOut: 0, partsDropped: 0 };
    const bits = new Uint32Array(vertices.buffer, vertices.byteOffset, vertices.length);
    const vertexCount = Math.floor(vertices.length / VERTEX_FLOATS);
    // Triangles by surface (the material id and the color's bits), in first-seen order.
    const order: string[] = [];
    const groups = new Map<string, number[]>();
    for (let t = 0; t + 2 < indices.length; t += 3) {
        const a = indices[t], b = indices[t + 1], c = indices[t + 2];
        if (a >= vertexCount || b >= vertexCount || c >= vertexCount) continue;
        const o = a * VERTEX_FLOATS;
        const key = `${Math.floor(vertices[o + 6] + 0.0005)}:${bits[o + 8]}:${bits[o + 9]}:${bits[o + 10]}:${bits[o + 11]}`;
        let g = groups.get(key);
        if (!g) { groups.set(key, g = []); order.push(key); }
        g.push(a, b, c);
    }
    const outV: number[] = [];
    const outI: number[] = [];
    const minFeature = Math.max(0, params.minFeature ?? 0);
    const targetRatio = Math.max(0, Math.min(1, params.targetRatio ?? 0));
    for (const key of order) {
        const tris = groups.get(key)!;
        // Weld by position (to a tenth of a millimeter).
        const welded: number[] = [];
        const lookup = new Map<string, number>();
        const idx = new Uint32Array(tris.length);
        for (let k = 0; k < tris.length; k++) {
            const o = tris[k] * VERTEX_FLOATS;
            const x = vertices[o], y = vertices[o + 1], z = vertices[o + 2];
            const q = `${Math.round(x * 1e4)},${Math.round(y * 1e4)},${Math.round(z * 1e4)}`;
            let w = lookup.get(q);
            if (w === undefined) { w = welded.length / 3; welded.push(x, y, z); lookup.set(q, w); }
            idx[k] = w;
        }
        // Degenerate after welding.
        let clean: number[] = [];
        for (let k = 0; k < idx.length; k += 3) {
            const a = idx[k], b = idx[k + 1], c = idx[k + 2];
            if (a !== b && b !== c && a !== c) clean.push(a, b, c);
        }
        // Drop small connected parts.
        if (minFeature > 0 && clean.length) {
            const n = welded.length / 3;
            const parent = new Uint32Array(n);
            for (let i = 0; i < n; i++) parent[i] = i;
            const find = (x: number) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
            const union = (a: number, b: number) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; };
            for (let k = 0; k < clean.length; k += 3) { union(clean[k], clean[k + 1]); union(clean[k + 1], clean[k + 2]); }
            const boxes = new Map<number, number[]>();
            for (const i of clean) {
                const r = find(i);
                const x = welded[i * 3], y = welded[i * 3 + 1], z = welded[i * 3 + 2];
                const b = boxes.get(r);
                if (!b) boxes.set(r, [x, y, z, x, y, z]);
                else { b[0] = Math.min(b[0], x); b[1] = Math.min(b[1], y); b[2] = Math.min(b[2], z); b[3] = Math.max(b[3], x); b[4] = Math.max(b[4], y); b[5] = Math.max(b[5], z); }
            }
            const small = new Set<number>();
            for (const [r, b] of boxes) if (Math.hypot(b[3] - b[0], b[4] - b[1], b[5] - b[2]) < minFeature) small.add(r);
            stats.partsDropped += small.size;
            if (small.size) {
                const kept: number[] = [];
                for (let k = 0; k < clean.length; k += 3) if (!small.has(find(clean[k]))) kept.push(clean[k], clean[k + 1], clean[k + 2]);
                clean = kept;
            }
        }
        if (!clean.length) continue;
        const positions = new Float32Array(welded);
        let simplified: Uint32Array;
        try {
            const target = Math.floor(Math.floor(clean.length / 3) * targetRatio) * 3;
            [simplified] = MeshoptSimplifier.simplify(new Uint32Array(clean), positions, 3, target, params.maxError, ["ErrorAbsolute"]);
        } catch {
            simplified = new Uint32Array(clean);
        }
        const so = tris[0] * VERTEX_FLOATS;
        const m6 = vertices[so + 6], m7 = vertices[so + 7], c0 = vertices[so + 8], c1 = vertices[so + 9], c2 = vertices[so + 10], c3 = vertices[so + 11];
        for (let k = 0; k + 2 < simplified.length; k += 3) {
            const a = simplified[k] * 3, b = simplified[k + 1] * 3, c = simplified[k + 2] * 3;
            const ax = positions[a], ay = positions[a + 1], az = positions[a + 2];
            const bx = positions[b], by = positions[b + 1], bz = positions[b + 2];
            const cx = positions[c], cy = positions[c + 1], cz = positions[c + 2];
            const e1x = bx - ax, e1y = by - ay, e1z = bz - az, e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
            let nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
            const len = Math.hypot(nx, ny, nz);
            if (len < 1e-12) continue;
            nx /= len; ny /= len; nz /= len;
            const base = outV.length / VERTEX_FLOATS;
            outV.push(ax, ay, az, nx, ny, nz, m6, m7, c0, c1, c2, c3,
                bx, by, bz, nx, ny, nz, m6, m7, c0, c1, c2, c3,
                cx, cy, cz, nx, ny, nz, m6, m7, c0, c1, c2, c3);
            outI.push(base, base + 1, base + 2);
        }
    }
    stats.trianglesOut = outI.length / 3;
    return { vertexData: new Float32Array(outV), indexData: new Uint32Array(outI), stats };
}
