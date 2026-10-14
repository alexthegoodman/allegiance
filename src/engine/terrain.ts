// The Earth on screen: terrain chunks and city tiles streamed by the Earth system
// (quadplanet/earth/system.ts) become drawables in the terrain material, each placed by its record
// relative to the render origin. When the render origin moves, every record is rewritten (the
// engine did this for chunk uniforms in quadplanet_ops.rs).

import type { Scene } from "@babylonjs/core/scene";
import type { ShaderMaterial } from "@babylonjs/core/Materials/shaderMaterial";
import { Drawable, makeGeometry, VERTEX_FLOATS } from "./drawables";
import type { Geometry } from "@babylonjs/core/Meshes/geometry";
import type { EarthSystem, EarthUpdate } from "../quadplanet/earth/system";
import { tileMatrix } from "../quadplanet/earth/city";
import type { V3 } from "../quadplanet/earth/math";

interface Placed { drawable: Drawable; origin: V3; basis: [V3, V3, V3] | null; texOrigin: V3; radius: number }

/** Every vertex lies within this distance of the mesh's origin (frustum culling), as the engine measured it. */
function localRadius(vertices: Float32Array): number {
    let r2 = 0;
    for (let i = 0; i < vertices.length; i += VERTEX_FLOATS) r2 = Math.max(r2, vertices[i] * vertices[i] + vertices[i + 1] * vertices[i + 1] + vertices[i + 2] * vertices[i + 2]);
    return Math.sqrt(r2) * 1.01 + 1;
}

export class TerrainMeshes {
    private chunks = new Map<string, Placed>();
    private tiles = new Map<string, Placed>();
    private origin: V3 = [0, 0, 0];
    private serial = 0;

    constructor(private scene: Scene, private material: (g: Geometry) => ShaderMaterial) {}

    get chunkCount(): number { return this.chunks.size; }
    get tileCount(): number { return this.tiles.size; }

    private record(p: Placed): void {
        const t: V3 = [p.origin[0] - this.origin[0], p.origin[1] - this.origin[1], p.origin[2] - this.origin[2]];
        const m = p.basis ? tileMatrix(p.origin, p.basis, this.origin) : [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, t[0], t[1], t[2], 1];
        p.drawable.setItem(m, [1, 1, 1, 0], p.basis ? [0, 0, 0, 0] : [p.texOrigin[0], p.texOrigin[1], p.texOrigin[2], 0]);
        p.drawable.setBounds(t, p.radius);
        if (p.drawable.instanceCount !== 1) p.drawable.setCount(1);
    }

    /** Applies an Earth update: new chunks and tiles become meshes, dropped ones go. */
    apply(update: EarthUpdate, renderOrigin: V3): void {
        const moved = renderOrigin.some((v, i) => v !== this.origin[i]);
        this.origin = renderOrigin;
        if (moved) for (const p of [...this.chunks.values(), ...this.tiles.values()]) this.record(p);
        for (const key of update.chunks.destroyed) { this.chunks.get(key)?.drawable.dispose(); this.chunks.delete(key); }
        for (const c of update.chunks.created) {
            this.chunks.get(c.key)?.drawable.dispose();
            const g = makeGeometry(this.scene, `chunk-${this.serial++}`, c.mesh.vertexData, c.mesh.indexData);
            const p: Placed = { drawable: new Drawable(this.scene, c.key, g, { material: this.material(g), ownsGeometry: true }), origin: c.mesh.origin, basis: null, texOrigin: c.texOrigin, radius: localRadius(c.mesh.vertexData) };
            this.record(p);
            this.chunks.set(c.key, p);
        }
        for (const [id] of update.city.destroyed) {
            const k = `${id.z}/${id.x}/${id.y}`;
            this.tiles.get(k)?.drawable.dispose();
            this.tiles.delete(k);
        }
        for (const [id, t] of update.city.created) {
            const k = `${id.z}/${id.x}/${id.y}`;
            this.tiles.get(k)?.drawable.dispose();
            if (!t.indices.length) continue;
            const g = makeGeometry(this.scene, `city-${this.serial++}`, t.vertices, t.indices);
            const p: Placed = { drawable: new Drawable(this.scene, `city:${k}`, g, { material: this.material(g), ownsGeometry: true }), origin: t.origin, basis: t.basis, texOrigin: [0, 0, 0], radius: localRadius(t.vertices) };
            this.record(p);
            this.tiles.set(k, p);
        }
    }

    /** Drops everything (travel; a fresh start). */
    clear(earth?: EarthSystem): void {
        for (const p of [...this.chunks.values(), ...this.tiles.values()]) p.drawable.dispose();
        this.chunks.clear();
        this.tiles.clear();
        earth?.clear();
    }
}
