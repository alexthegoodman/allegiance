// The QuadScape idea wrapped around a sphere (ported from QuadPlanet's quadtree.rs).
//
// A planet is six quadtrees, one per face of a cube, with every grid point pushed out onto the
// sphere (the "spherified cube" mapping keeps cells close to equal-area) and then out again by the
// terrain height. A node splits while the viewer is closer than `splitFactor` times the node's
// own size, so the rings of detail follow the viewer continuously from orbit down to the ground.
//
// Crack prevention. Neighbouring chunks must agree exactly on their shared border:
//   1. The tree is kept 2:1 balanced: no chunk touches (by an edge or a corner) a chunk more than
//      one level finer or coarser. `balance` splits chunks until that holds.
//   2. Where a chunk borders a coarser neighbour, that edge is "stitched": the finer chunk uses
//      only every other vertex on it - exactly the coarse chunk's vertices.
//   3. Every vertex on a chunk border is sampled at the band limit of the coarsest chunk touching
//      that point, so neighbours agree on its position and shading. All grid coordinates are
//      exact binary fractions, so "the same point" is the same number on both sides.
// The stitch pattern is part of a chunk's key: when a neighbour changes level, the chunk is
// rebuilt to match.

import { type V3, addScaled, distance, dot, length, normalize, scale, sub } from "./math";
import { Lookup } from "./elevation";
import type { Planet } from "./planet";

/** Cube faces: `n` is the face normal, `a`/`b` span the face so that a x b = n (counter-clockwise seen from outside). */
export interface Face { n: V3; a: V3; b: V3 }

export const FACES: Face[] = [
    { n: [1, 0, 0], a: [0, 0, -1], b: [0, 1, 0] },
    { n: [-1, 0, 0], a: [0, 0, 1], b: [0, 1, 0] },
    { n: [0, 1, 0], a: [1, 0, 0], b: [0, 0, -1] },
    { n: [0, -1, 0], a: [1, 0, 0], b: [0, 0, 1] },
    { n: [0, 0, 1], a: [1, 0, 0], b: [0, 1, 0] },
    { n: [0, 0, -1], a: [-1, 0, 0], b: [0, 1, 0] },
];

/** Edges of a chunk, in stitch-bit order. */
export const EDGE_B_MIN = 0;
export const EDGE_B_MAX = 1;
export const EDGE_A_MIN = 2;
export const EDGE_A_MAX = 3;

export interface ChunkNode {
    planet: number;
    face: number;
    level: number;
    /** Integer cell index along a / b at this level (0 .. 2^level - 1). */
    ia: number;
    ib: number;
    /** Which borders meet a coarser chunk: bits 0-3 the edges (EDGE_*), bits 4-7 the corners. */
    stitch: number;
}

export const rootNode = (planet: number, face: number): ChunkNode => ({ planet, face, level: 0, ia: 0, ib: 0, stitch: 0 });
export const nodeKey = (n: ChunkNode): string => `qp-${n.planet}-${n.face}-${n.level}-${n.ia}-${n.ib}-${n.stitch}`;

export function children(n: ChunkNode): ChunkNode[] {
    const c = (i: number, j: number): ChunkNode => ({ planet: n.planet, face: n.face, level: n.level + 1, ia: n.ia * 2 + i, ib: n.ib * 2 + j, stitch: 0 });
    return [c(0, 0), c(1, 0), c(0, 1), c(1, 1)];
}

/** Size of the node in face parameter units (a root face spans [-1, 1], size 2). */
export const nodeParamSize = (level: number): number => 2 / 2 ** level;

/** Unit direction of the node's center. */
export function centerDirection(n: ChunkNode): V3 {
    const size = nodeParamSize(n.level);
    return faceDirection(n.face, -1 + (n.ia + 0.5) * size, -1 + (n.ib + 0.5) * size);
}

/** World-space center of the node's ground, band-limited to its level. */
export function groundCenter(n: ChunkNode, p: Planet, lk: Lookup): V3 {
    const dir = centerDirection(n);
    return addScaled(p.def.center, dir, p.def.radius + p.sample(dir, p.levelSpacing(n.level), lk).surface);
}

/** Maps a point on the cube's surface ([-1,1]^3, one coordinate +-1) to the unit sphere. */
export function cubeToSphere(x: number, y: number, z: number): V3 {
    const x2 = x * x, y2 = y * y, z2 = z * z;
    return normalize([
        x * Math.sqrt(Math.max(0, 1 - y2 / 2 - z2 / 2 + (y2 * z2) / 3)),
        y * Math.sqrt(Math.max(0, 1 - z2 / 2 - x2 / 2 + (z2 * x2) / 3)),
        z * Math.sqrt(Math.max(0, 1 - x2 / 2 - y2 / 2 + (x2 * y2) / 3)),
    ]);
}

function cubePoint(face: number, a: number, b: number): V3 {
    const f = FACES[face];
    return [f.n[0] + f.a[0] * a + f.b[0] * b, f.n[1] + f.a[1] * a + f.b[1] * b, f.n[2] + f.a[2] * a + f.b[2] * b];
}

/** Unit direction for face parameters (a, b). */
export function faceDirection(face: number, a: number, b: number): V3 {
    const p = cubePoint(face, a, b);
    return cubeToSphere(p[0], p[1], p[2]);
}

/** Face parameters of a point given on `face` but possibly just past its border (carried over the cube's edge). */
export function wrapFace(face: number, a: number, b: number): [number, number, number] {
    if (Math.abs(a) <= 1 && Math.abs(b) <= 1) return [face, a, b];
    const p = cubePoint(face, a, b);
    let m = 0;
    for (let k = 1; k < 3; k++) if (Math.abs(p[k]) > Math.abs(p[m])) m = k;
    const q = scale(p, 1 / Math.abs(p[m]));
    const sign = Math.sign(p[m]);
    const nf = FACES.findIndex(f => f.n[m] === sign);
    return [nf, dot(q, FACES[nf].a), dot(q, FACES[nf].b)];
}

/** True when the two nodes (same planet and face) cover overlapping ground. */
export function nodesOverlap(a: ChunkNode, b: ChunkNode): boolean {
    if (a.planet !== b.planet || a.face !== b.face) return false;
    const [hi, lo] = a.level >= b.level ? [a, b] : [b, a];
    const shift = hi.level - lo.level;
    return Math.floor(hi.ia / 2 ** shift) === lo.ia && Math.floor(hi.ib / 2 ** shift) === lo.ib;
}

export interface LodSettings {
    /** A node splits while the viewer is closer than splitFactor x its size. */
    splitFactor: number;
    /** Never coarser than this (a whole face as one chunk looks faceted from orbit). */
    minLevel: number;
}

export const DEFAULT_LOD: LodSettings = { splitFactor: 1.1, minLevel: 1 };

export interface Selection {
    /** Leaves with their ground centers. */
    leaves: [ChunkNode, V3][];
    /** Nodes skipped because they are below the viewer's horizon. */
    hidden: number;
    /** Chunks split to keep the tree 2:1 balanced. */
    balanced: number;
}

// --- The leaf set --------------------------------------------------------------------------------

const leafId = (face: number, level: number, ia: number, ib: number): number => ((level * 6 + face) * 2 ** 21 + ia) * 2 ** 21 + ib;

/** One planet's leaves, findable by any point on the cube. */
export class LeafIndex {
    private map = new Map<number, ChunkNode>();
    constructor(private maxLevel: number) {}

    add(n: ChunkNode): void { this.map.set(leafId(n.face, n.level, n.ia, n.ib), n); }
    remove(n: ChunkNode): void { this.map.delete(leafId(n.face, n.level, n.ia, n.ib)); }
    has(n: ChunkNode): boolean { return this.map.has(leafId(n.face, n.level, n.ia, n.ib)); }
    get size(): number { return this.map.size; }
    values(): ChunkNode[] { return [...this.map.values()]; }

    /** The leaf covering face point (a, b), which may lie just past the face's border. */
    find(face: number, a: number, b: number): ChunkNode | undefined {
        const [f, u, v] = wrapFace(face, a, b);
        for (let level = 0; level <= this.maxLevel; level++) {
            const cells = 2 ** level;
            const ia = Math.max(0, Math.min(cells - 1, Math.floor(((u + 1) / 2) * cells)));
            const ib = Math.max(0, Math.min(cells - 1, Math.floor(((v + 1) / 2) * cells)));
            const hit = this.map.get(leafId(f, level, ia, ib));
            if (hit) return hit;
        }
        return undefined;
    }
}

/** How far outside a node its neighbour probes land, as a fraction of its size. */
const PROBE = 1e-4;

/** Points just outside the node: `perEdge` along each edge, plus the four diagonal corners. */
function probePoints(n: ChunkNode, perEdge: number): [number, number][] {
    const s = nodeParamSize(n.level);
    const a0 = -1 + n.ia * s, b0 = -1 + n.ib * s, e = s * PROBE;
    const out: [number, number][] = [];
    for (let k = 0; k < perEdge; k++) {
        const t = ((k + 0.5) / perEdge) * s;
        out.push([a0 + t, b0 - e], [a0 + t, b0 + s + e], [a0 - e, b0 + t], [a0 + s + e, b0 + t]);
    }
    out.push([a0 - e, b0 - e], [a0 + s + e, b0 - e], [a0 - e, b0 + s + e], [a0 + s + e, b0 + s + e]);
    return out;
}

/** Splits leaves until none touches a leaf two or more levels finer. Returns how many splits that took. */
export function balance(index: LeafIndex): number {
    let splits = 0;
    const queue = index.values();
    while (queue.length) {
        const n = queue.pop()!;
        if (!index.has(n)) continue;
        const neighbours: ChunkNode[] = [];
        let split = false;
        for (const [a, b] of probePoints(n, 4)) {
            const m = index.find(n.face, a, b);
            if (!m) continue;
            neighbours.push(m);
            if (m.level >= n.level + 2) split = true;
        }
        if (!split) continue;
        index.remove(n);
        for (const c of children(n)) { index.add(c); queue.push(c); }
        // The new, finer children may now be too fine for a coarse neighbour: check those again.
        queue.push(...neighbours);
        splits++;
    }
    return splits;
}

/** Sets every leaf's stitch bits from the (balanced) leaf set. */
export function assignStitches(index: LeafIndex): void {
    for (const n of index.values()) {
        const s = nodeParamSize(n.level);
        const a0 = -1 + n.ia * s, b0 = -1 + n.ib * s, e = s * PROBE;
        const coarser = (a: number, b: number) => { const m = index.find(n.face, a, b); return !!m && m.level < n.level; };
        let bits = 0;
        if (coarser(a0 + s / 2, b0 - e)) bits |= 1 << EDGE_B_MIN;
        if (coarser(a0 + s / 2, b0 + s + e)) bits |= 1 << EDGE_B_MAX;
        if (coarser(a0 - e, b0 + s / 2)) bits |= 1 << EDGE_A_MIN;
        if (coarser(a0 + s + e, b0 + s / 2)) bits |= 1 << EDGE_A_MAX;
        const corners: [number, number, number, number][] = [[a0, b0, -1, -1], [a0 + s, b0, 1, -1], [a0, b0 + s, -1, 1], [a0 + s, b0 + s, 1, 1]];
        corners.forEach(([ca, cb, da, db], k) => {
            if (coarser(ca + da * e, cb - db * e) || coarser(ca - da * e, cb + db * e) || coarser(ca + da * e, cb + db * e)) bits |= 1 << (4 + k);
        });
        index.add({ ...n, stitch: bits });
    }
}

/**
 * The chunks one planet should show for a viewer: a depth-first walk of the six face quadtrees,
 * splitting by distance and skipping whatever is hidden below the horizon, then balanced 2:1 and
 * stitched so neighbours share their edges exactly.
 */
export function selectChunks(p: Planet, planetIndex: number, viewer: V3, lod: LodSettings): Selection {
    const lk = new Lookup("fallback");
    let hidden = 0;
    const maxLevel = p.maxLevel();
    const index = new LeafIndex(maxLevel);
    const rel = sub(viewer, p.def.center);
    const rv = Math.max(length(rel), p.def.radius + 0.5);
    const viewDir = normalize(rel);
    const relief = p.maxRelief();
    // Angle past which the ground can't be seen: the viewer's horizon over the lowest ground that
    // can block the view, plus how far beyond it a peak of the maximum height still pokes up.
    const lowest = p.lowestBlockingRadius();
    const horizon = Math.acos(Math.min(1, lowest / rv)) + Math.acos(lowest / (lowest + relief));
    const centers = new Map<number, V3>();
    const stack: ChunkNode[] = [];
    for (let f = 5; f >= 0; f--) stack.push(rootNode(planetIndex, f));
    while (stack.length) {
        const n = stack.pop()!;
        const dir = centerDirection(n);
        const size = p.levelWorldSize(n.level);
        const angularRadius = (size * 0.75) / p.def.radius;
        const angle = Math.acos(Math.max(-1, Math.min(1, dot(dir, viewDir))));
        if (angle - angularRadius > horizon) { hidden++; continue; }
        const center = groundCenter(n, p, lk);
        const d = Math.max(0, distance(viewer, center) - size * 0.7);
        if (n.level < maxLevel && (n.level < lod.minLevel || d < lod.splitFactor * size)) {
            const kids = children(n);
            for (let i = 3; i >= 0; i--) stack.push(kids[i]);
        } else {
            centers.set(leafId(n.face, n.level, n.ia, n.ib), center);
            index.add(n);
        }
    }
    const balanced = balance(index);
    assignStitches(index);
    const leaves: [ChunkNode, V3][] = index.values().map(n => [n, centers.get(leafId(n.face, n.level, n.ia, n.ib)) ?? groundCenter(n, p, lk)]);
    return { leaves, hidden, balanced };
}
