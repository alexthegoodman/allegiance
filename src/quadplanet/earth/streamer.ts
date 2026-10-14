// QuadScape's update for a planet (ported from QuadPlanet's streamer.rs): every frame, diff the
// wanted chunk set against the live one, build the missing chunks that matter most within a
// budget, and drop stale chunks once their ground is covered by live replacements - so streaming
// never opens a hole.
//
// The wanted set also respects a triangle budget: if the selection would draw more than
// `triangleBudget` triangles, the split distance is tightened until it fits, so detail follows
// you from orbit to the ground without ever passing the budget (2M by default).
//
// The Rust streamer built chunks on worker threads; here they are built within the call, nearest-
// looking first, bounded by `maxBuilds` and `maxMs`. A chunk whose elevation is still downloading
// is retried a quarter of a second later.

import { type V3, distance } from "./math";
import { buildChunk, estimatedTriangles, type ChunkMesh } from "./chunk_mesh";
import type { Planet } from "./planet";
import { type ChunkNode, type LodSettings, nodeKey, nodesOverlap, selectChunks } from "./quadtree";

export interface StreamStats {
    live: number;
    wanted: number;
    pending: number;
    /** Wanted chunks waiting on elevation tiles still downloading. */
    waitingForData: number;
    hidden: number;
    balanced: number;
    /** Live chunks with at least one stitched border. */
    stitched: number;
    built: number;
    destroyed: number;
    deepest: number[];
    perPlanet: number[];
    triangles: number;
    /** The split factor the triangle budget left. */
    splitFactor: number;
    buildMs: number;
}

/** A chunk whose elevation was not there yet is tried again after this long (ms). */
const RETRY_AFTER = 250;

interface LiveChunk { node: ChunkNode; triangles: number }
interface Wanted { nodes: Map<string, [ChunkNode, V3]>; hidden: number; balanced: number; splitFactor: number }

export interface StreamUpdate {
    created: [string, ChunkNode, ChunkMesh][];
    destroyed: string[];
    stats: StreamStats;
}

const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

export class PlanetStreamer {
    private live = new Map<string, LiveChunk>();
    private builtTotal = 0;
    private destroyedTotal = 0;
    private cache: { viewer: V3; wanted: Wanted } | null = null;
    private waiting = new Map<string, number>();
    lastStats: StreamStats = emptyStats();

    constructor(public lod: LodSettings, public triangleBudget: number) {}

    liveKeys(): IterableIterator<string> { return this.live.keys(); }
    /** Forgets the cached selection (after a configuration change). */
    invalidate(): void { this.cache = null; }

    private select(planets: readonly Planet[], viewer: V3): Wanted {
        // Selection (with balancing) takes milliseconds; a meter of movement can't change it much.
        if (this.cache && distance(this.cache.viewer, viewer) < 1) return this.cache.wanted;
        const lod = { ...this.lod };
        let wanted: Wanted;
        for (;;) {
            wanted = { nodes: new Map(), hidden: 0, balanced: 0, splitFactor: lod.splitFactor };
            let triangles = 0;
            planets.forEach((p, i) => {
                const sel = selectChunks(p, i, viewer, lod);
                wanted.hidden += sel.hidden;
                wanted.balanced += sel.balanced;
                for (const [n, c] of sel.leaves) {
                    triangles += estimatedTriangles(p, n.level);
                    wanted.nodes.set(nodeKey(n), [n, c]);
                }
            });
            if (triangles <= this.triangleBudget || lod.splitFactor < 0.3) break;
            lod.splitFactor *= 0.85;
        }
        this.cache = { viewer, wanted };
        return wanted;
    }

    /** `maxBuilds` and `maxMs` bound the work per call (chunk building is the expensive part). */
    update(planets: readonly Planet[], viewer: V3, maxBuilds: number, maxMs: number): StreamUpdate {
        const started = now();
        const wanted = this.select(planets, viewer);
        // Build the missing chunks that look biggest first: distance relative to size, so the
        // ground under your feet comes first, but a distant range's coarse chunk is not left as a
        // hole in the horizon while dozens of small nearby ones stream in.
        const t = now();
        for (const [k, at] of this.waiting) if (!wanted.nodes.has(k) || t - at >= RETRY_AFTER) this.waiting.delete(k);
        const missing: [number, string, ChunkNode][] = [];
        for (const [k, [n, c]] of wanted.nodes) {
            if (this.live.has(k) || this.waiting.has(k)) continue;
            missing.push([distance(viewer, c) / planets[n.planet].levelWorldSize(n.level), k, n]);
        }
        missing.sort((a, b) => a[0] - b[0]);
        const created: [string, ChunkNode, ChunkMesh][] = [];
        let attempts = 0;
        for (const [, key, node] of missing) {
            if (created.length >= maxBuilds) break;
            // The budget bounds attempts, not only finished chunks: while elevation is downloading
            // most attempts come back empty, and trying every one of them held the thread for seconds.
            if (attempts++ && now() - started >= maxMs) break;
            const mesh = buildChunk(planets[node.planet], node);
            if (mesh) created.push([key, node, mesh]);
            else this.waiting.set(key, now());
        }
        return this.finish(planets, wanted, created, now() - started);
    }

    private finish(planets: readonly Planet[], wanted: Wanted, created: [string, ChunkNode, ChunkMesh][], buildMs: number): StreamUpdate {
        for (const [key, node, mesh] of created) this.live.set(key, { node, triangles: mesh.triangles });
        // Drop stale chunks whose ground is fully covered by live wanted chunks.
        const byFace = new Map<number, ChunkNode[]>();
        for (const [n] of wanted.nodes.values()) {
            const k = n.planet * 8 + n.face;
            let list = byFace.get(k);
            if (!list) byFace.set(k, list = []);
            list.push(n);
        }
        const destroyed: string[] = [];
        for (const [key, chunk] of this.live) {
            if (wanted.nodes.has(key)) continue;
            const ws = byFace.get(chunk.node.planet * 8 + chunk.node.face);
            const covered = !ws || ws.filter(w => nodesOverlap(w, chunk.node)).every(w => this.live.has(nodeKey(w)));
            if (covered) destroyed.push(key);
        }
        for (const key of destroyed) this.live.delete(key);
        this.builtTotal += created.length;
        this.destroyedTotal += destroyed.length;
        const stats = emptyStats();
        stats.wanted = wanted.nodes.size;
        stats.hidden = wanted.hidden;
        stats.balanced = wanted.balanced;
        stats.splitFactor = wanted.splitFactor;
        for (const k of wanted.nodes.keys()) if (!this.live.has(k)) stats.pending++;
        stats.waitingForData = this.waiting.size;
        stats.built = this.builtTotal;
        stats.destroyed = this.destroyedTotal;
        stats.deepest = planets.map(() => 0);
        stats.perPlanet = planets.map(() => 0);
        stats.buildMs = buildMs;
        for (const c of this.live.values()) {
            stats.live++;
            stats.perPlanet[c.node.planet]++;
            stats.deepest[c.node.planet] = Math.max(stats.deepest[c.node.planet], c.node.level);
            stats.triangles += c.triangles;
            if (c.node.stitch !== 0) stats.stitched++;
        }
        this.lastStats = stats;
        return { created, destroyed, stats };
    }

    /** Removes everything; returns the keys that were live. */
    clear(): string[] {
        this.cache = null;
        this.waiting.clear();
        const keys = [...this.live.keys()];
        this.live.clear();
        return keys;
    }
}

function emptyStats(): StreamStats {
    return { live: 0, wanted: 0, pending: 0, waitingForData: 0, hidden: 0, balanced: 0, stitched: 0, built: 0, destroyed: 0, deepest: [], perPlanet: [], triangles: 0, splitFactor: 0, buildMs: 0 };
}
