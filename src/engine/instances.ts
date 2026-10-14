// Instanced batches on Babylon: the InstanceEngine qp_instances.ts drives (it was Entropy's
// buffers, MeshCache.createMesh, setInstanceCount and setBounds). A batch's records go to a
// drawable of the cached mesh's shared geometry; the shadow cascades get it as a caster.

import type { Scene } from "@babylonjs/core/scene";
import type { Geometry } from "@babylonjs/core/Meshes/geometry";
import type { ShaderMaterial } from "@babylonjs/core/Materials/shaderMaterial";
import { Drawable, makeGeometry } from "./drawables";
import type { MeshCache } from "./mesh_cache";
import type { SunShadows } from "./shadows";
import type { InstanceEngine } from "../quadplanet/qp_instances";

/** GPU geometry of cached meshes, shared by every drawable of a key; released a while after its last user goes. */
export class GeometryRegistry {
    private entries = new Map<string, { geometry: Geometry; idleSince: number }>();
    private serial = 0;

    constructor(private scene: Scene, private cache: MeshCache) {}

    get(ns: string, key: string): Geometry | null {
        const id = `${ns}|${key}`;
        const e = this.entries.get(id);
        if (e && !e.geometry.isDisposed()) { e.idleSince = Infinity; return e.geometry; }
        const mesh = this.cache.get(ns, key);
        if (!mesh) return null;
        const geometry = makeGeometry(this.scene, `cached-${this.serial++}`, mesh.vertexData, mesh.indexData);
        this.entries.set(id, { geometry, idleSince: Infinity });
        return geometry;
    }

    /** Frees geometry nobody has drawn for `idleMs` (call now and then). */
    sweep(idleMs = 30000): void {
        const now = performance.now();
        for (const [id, e] of this.entries) {
            if (e.geometry.meshes.length) { e.idleSince = Infinity; continue; }
            if (e.idleSince === Infinity) { e.idleSince = now; continue; }
            if (now - e.idleSince > idleMs) { e.geometry.dispose(); this.entries.delete(id); }
        }
    }

    get size(): number { return this.entries.size; }
}

export interface InstanceSpec {
    namespace: string;
    /** The shader variant for a geometry (engine/renderer.ts Renderer.variant). */
    material: (g: Geometry) => ShaderMaterial;
    caster: ShaderMaterial | null;
    /** Cascades it casts into (0: none). */
    casterCascades: number;
    recordFloats: number;
}

/** An InstanceEngine for one family of batches (houses, a set dressing shadow class, people, effects). */
export function babylonInstances(scene: Scene, geometries: GeometryRegistry, shadows: SunShadows | null, spec: () => InstanceSpec): InstanceEngine {
    const buffers = new Map<string, { data: Float32Array; drawable: Drawable | null }>();
    const meshes = new Map<string, { drawable: Drawable; buffer: string }>();
    let serial = 0;
    return {
        createBuffer: bytes => { const id = `buf-${serial++}`; buffers.set(id, { data: new Float32Array(bytes / 4), drawable: null }); return id; },
        destroyBuffer: id => { buffers.delete(id); },
        writeBuffer: (id, data) => {
            const b = buffers.get(id);
            if (!b) return;
            b.data.set(data.subarray(0, Math.min(data.length, b.data.length)));
            b.drawable?.setRecords(b.data, Math.floor(data.length / b.drawable.recordFloats));
        },
        createMesh: (key, meshId, buffer, instances) => {
            const s = spec();
            const geometry = geometries.get(s.namespace, key);
            if (!geometry) return false;
            const d = new Drawable(scene, meshId, geometry, { material: s.material(geometry), recordFloats: s.recordFloats, casterCascades: s.casterCascades });
            const b = buffers.get(buffer);
            if (b) { b.drawable = d; d.setRecords(b.data, instances); }
            meshes.set(meshId, { drawable: d, buffer });
            if (shadows && s.caster && s.casterCascades > 0) shadows.addCaster(d, s.caster);
            return true;
        },
        clearMesh: meshId => {
            const m = meshes.get(meshId);
            if (!m) return;
            shadows?.removeCaster(m.drawable);
            m.drawable.dispose();
            const b = buffers.get(m.buffer);
            if (b && b.drawable === m.drawable) b.drawable = null;
            meshes.delete(meshId);
        },
        setInstanceCount: (meshId, count) => meshes.get(meshId)?.drawable.setCount(count),
        setBounds: (meshId, center, radius) => meshes.get(meshId)?.drawable.setBounds(center, radius),
    };
}
