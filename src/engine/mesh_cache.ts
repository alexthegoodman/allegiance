// Generated meshes kept in the browser (IndexedDB), like a shader cache: build a mesh the first time
// it is wanted and `put` it; from then on (this session or the next) it is a read. This is the
// engine's Entropy.MeshCache with the same synchronous face the game modules expect:
//
// - status: "ready" once the mesh is in memory; "pending" while a background put (simplify) is
//   working or while it is being read back from IndexedDB (asking starts the read); "missing".
// - put: stores a mesh. `simplify` makes a level of detail in a worker first (mesh_simplify.ts).
// - get / info / meta: the geometry (in memory) and what is known about it (from the index, which
//   is loaded once at startup, so `info` answers for meshes not yet read back).
//
// Everything that identifies the geometry is in the key (generator and version, parameters,
// level of detail). The cache is pruned least recently used first.

import { Idb } from "./idb";
import type { WorkerPool } from "./workers";
import type { SimplifyParams } from "./mesh_simplify";

interface IndexEntry { vertexCount: number; triangleCount: number; bytes: number; meta: unknown; used: number }
interface MemoryEntry { vertexData: Float32Array; indexData: Uint32Array; used: number }

const id = (ns: string, key: string) => `${ns}|${key}`;

export interface MeshCacheStats { files: number; bytes: number; memoryMeshes: number; memoryBytes: number; pending: number; hits: number; misses: number; writes: number }

export class MeshCache implements MeshCacheAPI {
    private index = new Map<string, IndexEntry>();
    private memory = new Map<string, MemoryEntry>();
    private memoryBytes = 0;
    private pendingPuts = new Set<string>();
    private reading = new Set<string>();
    /** In memory and in the index, but not yet written to IndexedDB: never evicted. */
    private unwritten = new Set<string>();
    private failures = new Map<string, string>();
    private counters = new Map<string, { hits: number; misses: number; writes: number }>();
    /** Called when a mesh becomes ready (loaded or made). */
    onReady: ((ns: string, key: string) => void) | null = null;

    private constructor(private db: Idb | null, private pool: WorkerPool | null, readonly memoryBudget: number) {}

    /** Opens the cache (reading its index). Without IndexedDB it works in memory only. */
    static async open(pool: WorkerPool | null, memoryBudget = 1.2e9): Promise<MeshCache> {
        let db: Idb | null = null;
        try { db = typeof indexedDB === "undefined" ? null : await Idb.open("allegiance-mesh-cache", ["meshes", "index"]); } catch { db = null; }
        const cache = new MeshCache(db, pool, memoryBudget);
        if (db) for (const [k, v] of await db.entries<IndexEntry>("index")) cache.index.set(k, v);
        return cache;
    }

    private count(ns: string) {
        let c = this.counters.get(ns);
        if (!c) this.counters.set(ns, c = { hits: 0, misses: 0, writes: 0 });
        return c;
    }

    status(ns: string, key: string): "ready" | "pending" | "missing" {
        const k = id(ns, key);
        const m = this.memory.get(k);
        if (m) { m.used = performance.now(); return "ready"; }
        if (this.pendingPuts.has(k) || this.reading.has(k)) return "pending";
        if (this.index.has(k)) { this.read(ns, key); return "pending"; }
        return "missing";
    }

    /** Reads a stored mesh back into memory. */
    private read(ns: string, key: string): void {
        const k = id(ns, key);
        if (!this.db || this.reading.has(k)) return;
        this.reading.add(k);
        this.db.get<{ v: ArrayBuffer; i: ArrayBuffer }>("meshes", k).then(rec => {
            this.reading.delete(k);
            if (!rec) { this.index.delete(k); void this.db?.delete("index", k); this.count(ns).misses++; return; }
            this.count(ns).hits++;
            this.remember(k, new Float32Array(rec.v), new Uint32Array(rec.i));
            const e = this.index.get(k);
            if (e) { e.used = Date.now(); void this.db?.put("index", k, e); }
            this.onReady?.(ns, key);
        }, () => { this.reading.delete(k); });
    }

    private remember(k: string, vertexData: Float32Array, indexData: Uint32Array): void {
        const old = this.memory.get(k);
        if (old) this.memoryBytes -= old.vertexData.byteLength + old.indexData.byteLength;
        this.memory.set(k, { vertexData, indexData, used: performance.now() });
        this.memoryBytes += vertexData.byteLength + indexData.byteLength;
        if (this.memoryBytes > this.memoryBudget) this.trimMemory(k);
    }

    /** Least recently used meshes leave memory (they stay stored and read back when asked for). */
    private trimMemory(keep: string): void {
        const list = [...this.memory].filter(([k]) => k !== keep).sort((a, b) => a[1].used - b[1].used);
        for (const [k, m] of list) {
            if (this.memoryBytes <= this.memoryBudget * 0.85) break;
            if (!this.index.has(k) || this.unwritten.has(k)) continue; // not stored yet: keep it
            this.memory.delete(k);
            this.memoryBytes -= m.vertexData.byteLength + m.indexData.byteLength;
        }
    }

    put(ns: string, key: string, mesh: CachedMeshData, options: { simplify?: { maxError: number; minFeature?: number; targetRatio?: number }; background?: boolean } = {}): void {
        const k = id(ns, key);
        const vertexData = mesh.vertexData instanceof Float32Array ? mesh.vertexData : new Float32Array(mesh.vertexData);
        const indexData = mesh.indexData instanceof Uint32Array ? mesh.indexData : new Uint32Array(mesh.indexData);
        this.failures.delete(k);
        if (options.simplify && this.pool) {
            this.pendingPuts.add(k);
            const params: SimplifyParams = options.simplify;
            this.pool.run({ kind: "simplify", vertexData: vertexData.slice(), indexData: indexData.slice(), params }).done.then(r => {
                this.pendingPuts.delete(k);
                if (r.kind !== "simplify") return;
                this.store(ns, key, r.mesh.vertexData, r.mesh.indexData, mesh.meta);
            }, (e: Error) => { this.pendingPuts.delete(k); this.failures.set(k, e.message); });
            return;
        }
        this.store(ns, key, vertexData, indexData, mesh.meta);
    }

    /** Stores a finished mesh: in memory now, in IndexedDB in the background. */
    store(ns: string, key: string, vertexData: Float32Array, indexData: Uint32Array, meta: unknown): void {
        const k = id(ns, key);
        this.remember(k, vertexData, indexData);
        const entry: IndexEntry = { vertexCount: vertexData.length / 12, triangleCount: indexData.length / 3, bytes: vertexData.byteLength + indexData.byteLength, meta: meta ?? null, used: Date.now() };
        this.count(ns).writes++;
        this.index.set(k, entry);
        if (this.db) {
            const db = this.db;
            this.unwritten.add(k);
            // Copies: the originals may be handed to the GPU meanwhile.
            db.put("meshes", k, { v: vertexData.slice().buffer, i: indexData.slice().buffer })
                .then(() => db.put("index", k, entry))
                .then(() => this.unwritten.delete(k), e => { this.unwritten.delete(k); this.failures.set(k, String(e)); });
        }
        this.onReady?.(ns, key);
    }

    get(ns: string, key: string): { vertexData: Float32Array; indexData: Uint32Array; meta?: unknown } | null {
        const k = id(ns, key);
        const m = this.memory.get(k);
        if (!m) { if (this.index.has(k)) this.read(ns, key); return null; }
        m.used = performance.now();
        return { vertexData: m.vertexData, indexData: m.indexData, meta: this.index.get(k)?.meta ?? undefined };
    }

    meta(ns: string, key: string): unknown | null { return this.index.get(id(ns, key))?.meta ?? null; }

    info(ns: string, key: string): { vertexCount: number; triangleCount: number; meta?: unknown } | null {
        const e = this.index.get(id(ns, key));
        if (e) return { vertexCount: e.vertexCount, triangleCount: e.triangleCount, meta: e.meta };
        const m = this.memory.get(id(ns, key));
        return m ? { vertexCount: m.vertexData.length / 12, triangleCount: m.indexData.length / 3 } : null;
    }

    /** Not used by the game: meshes are spawned through the renderer (engine/instances.ts). */
    createMesh(): boolean { throw new Error("MeshCache.createMesh: spawn cached meshes through the renderer"); }

    remove(ns: string, key: string): boolean {
        const k = id(ns, key);
        const had = this.index.delete(k) || this.memory.has(k);
        const m = this.memory.get(k);
        if (m) { this.memory.delete(k); this.memoryBytes -= m.vertexData.byteLength + m.indexData.byteLength; }
        if (this.db) { void this.db.delete("meshes", k); void this.db.delete("index", k); }
        return had;
    }

    clear(ns: string): number {
        let n = 0;
        for (const k of [...this.index.keys(), ...this.memory.keys()]) {
            if (!k.startsWith(`${ns}|`)) continue;
            if (this.remove(ns, k.slice(ns.length + 1))) n++;
        }
        return n;
    }

    /** Deletes least recently used meshes until the namespace fits in `maxBytes`; returns how many went. */
    prune(ns: string, maxBytes: number): number {
        const list = [...this.index].filter(([k]) => k.startsWith(`${ns}|`)).sort((a, b) => a[1].used - b[1].used);
        let bytes = list.reduce((s, [, e]) => s + e.bytes, 0);
        let n = 0;
        for (const [k, e] of list) {
            if (bytes <= maxBytes) break;
            this.remove(ns, k.slice(ns.length + 1));
            bytes -= e.bytes;
            n++;
        }
        return n;
    }

    stats(ns: string): MeshCacheStats {
        let files = 0, bytes = 0, memoryMeshes = 0, memoryBytes = 0, pending = 0;
        for (const [k, e] of this.index) if (k.startsWith(`${ns}|`)) { files++; bytes += e.bytes; }
        for (const [k, m] of this.memory) if (k.startsWith(`${ns}|`)) { memoryMeshes++; memoryBytes += m.vertexData.byteLength + m.indexData.byteLength; }
        for (const k of this.pendingPuts) if (k.startsWith(`${ns}|`)) pending++;
        const c = this.count(ns);
        return { files, bytes, memoryMeshes, memoryBytes, pending, hits: c.hits, misses: c.misses, writes: c.writes };
    }

    failure(ns: string, key: string): string | null { return this.failures.get(id(ns, key)) ?? null; }
}
