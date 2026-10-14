// The engine-facing types the game modules share (formerly Entropy's addon.d.ts).
declare global {
  /** Packed engine `mesh` layout: 12 floats a vertex (position 3, normal 3, uv 2, color 4). */
  interface CachedMeshData {
    vertexData: Float32Array | number[];
    indexData: Uint32Array | number[];
    /** Anything JSON you want back without the geometry (bounds, triangle counts...). */
    meta?: unknown;
  }

  interface MeshCacheStats {
    files: number; bytes: number; memoryMeshes: number; memoryBytes: number; pending: number;
    hits: number; misses: number; writes: number;
  }

  /**
   * Generated meshes kept on disk (`<data dir>/mesh-cache/<namespace>/`), like a shader cache:
   * build a mesh the first time it is wanted and `put` it; from then on (this session or the
   * next) `createMesh` spawns it from the cache on the Rust side, without the geometry crossing
   * into JavaScript. Put everything that identifies the geometry in the key (generator and
   * version, parameters, level of detail). Namespaces are folder names ([A-Za-z0-9_.-]).
   */
  interface MeshCacheAPI {
    /** "pending" while a background `put` (simplify, or `background: true`) is still working. */
    status: (namespace: string, key: string) => "ready" | "pending" | "missing";
    /**
     * Stores a mesh. `simplify` makes a level of detail on a background thread first: surfaces
     * (vertex color + material id in uv.x) are welded and simplified to `maxError` meters,
     * connected parts under `minFeature` meters across are dropped, and the result is flat shaded.
     */
    put: (namespace: string, key: string, mesh: CachedMeshData, options?: {
      simplify?: { maxError: number; minFeature?: number; targetRatio?: number };
      background?: boolean;
    }) => void;
    get: (namespace: string, key: string) => { vertexData: Float32Array; indexData: Uint32Array; meta?: unknown } | null;
    meta: (namespace: string, key: string) => unknown | null;
    /** A cached mesh's size (after any simplification) and metadata, without its geometry; null if it isn't cached. */
    info: (namespace: string, key: string) => { vertexCount: number; triangleCount: number; meta?: unknown } | null;
    /** Spawns the cached mesh like `Entropy.Model.createMesh`; false (nothing spawned) if it isn't cached. */
    createMesh: (namespace: string, key: string, config: {
      id?: string; position?: [number, number, number]; rotation?: [number, number, number]; scale?: [number, number, number];
      pipelineId: string; renderRole?: string; bindings?: BindingConfig[];
      /** Instances drawn (default 1); the shader places each by `@builtin(instance_index)`. 0
       * draws nothing until `Model.setInstanceCount`. */
      instanceCount?: number;
      /** Render-space bounding sphere [x, y, z, radius] for frustum culling (see Model.setBounds). */
      bounds?: [number, number, number, number];
    }) => boolean;
    remove: (namespace: string, key: string) => boolean;
    clear: (namespace: string) => number;
    /** Deletes least recently used meshes until the namespace fits in `maxBytes`; returns how many went. */
    prune: (namespace: string, maxBytes: number) => number;
    stats: (namespace: string) => MeshCacheStats;
    /** Why the last background `put` of this key failed, or null. */
    failure: (namespace: string, key: string) => string | null;
  }
}
export {};
