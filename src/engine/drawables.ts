// Meshes on Babylon: every mesh the game draws is geometry in the packed layout (position 3,
// normal 3, uv 2, color 4) drawn with thin instances, one instance per record (QuadPlanet's Item:
// model matrix, tint, texture origin; a person's record adds skin and hair). A single object is a
// mesh with one instance, a terrain chunk too (its record places it relative to the render
// origin), and an instanced batch (houses, set dressing, people) has many. That is what the
// engine's Model / MeshCache.createMesh / setInstanceCount / setBounds were.

import { Buffer, VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { Geometry } from "@babylonjs/core/Meshes/geometry";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { BoundingInfo } from "@babylonjs/core/Culling/boundingInfo";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { Scene } from "@babylonjs/core/scene";
import type { Material } from "@babylonjs/core/Materials/material";
import "@babylonjs/core/Meshes/thinInstanceMesh";

export const VERTEX_FLOATS = 12;
/** Item records: model matrix (16), tint (4), texture origin (4). */
export const ITEM_RECORD = 24;
/** Person records: an Item and skin (4) and hair (4) (al_crowd.ts PERSON_FLOATS). */
export const PERSON_RECORD = 32;

const masks = new WeakMap<Geometry, number>();

/** The material ids a packed mesh uses (uv.x), as a bit set. */
export function materialMask(vertexData: Float32Array): number {
    let mask = 0;
    for (let i = 6; i < vertexData.length; i += VERTEX_FLOATS) mask |= 1 << (Math.floor(vertexData[i] + 0.0005) & 31);
    return mask;
}

/** The material ids a geometry made by makeGeometry draws (0 when unknown). */
export const geometryMask = (g: Geometry): number => masks.get(g) ?? 0;

/** Shared GPU geometry from a packed mesh. */
export function makeGeometry(scene: Scene, name: string, vertexData: Float32Array, indexData: Uint32Array): Geometry {
    const engine = scene.getEngine();
    const g = new Geometry(name, scene, undefined, false);
    const buffer = new Buffer(engine, vertexData, false, VERTEX_FLOATS);
    g.setVerticesBuffer(buffer.createVertexBuffer(VertexBuffer.PositionKind, 0, 3), vertexData.length / VERTEX_FLOATS);
    g.setVerticesBuffer(buffer.createVertexBuffer(VertexBuffer.NormalKind, 3, 3));
    g.setVerticesBuffer(buffer.createVertexBuffer(VertexBuffer.UVKind, 6, 2));
    g.setVerticesBuffer(buffer.createVertexBuffer(VertexBuffer.ColorKind, 8, 4));
    g.setIndices(indexData, vertexData.length / VERTEX_FLOATS);
    masks.set(g, materialMask(vertexData));
    return g;
}

/** Which shader a drawable uses and how far it casts sun shadows (0: none; 1-4: the nearest cascades). */
export interface DrawableOptions {
    material: Material;
    recordFloats?: number;
    casterCascades?: number;
    renderingGroup?: number;
    /** The drawable's own geometry (disposed with it); otherwise it is shared and outlives it. */
    ownsGeometry?: boolean;
}

/**
 * One drawn mesh: geometry plus its instance records. Records are written whole (`setRecords`,
 * the engine's buffer write) and drawn `count` at a time.
 */
export class Drawable {
    readonly mesh: Mesh;
    readonly recordFloats: number;
    casterCascades: number;
    private capacity = 0;
    private matrix = new Float32Array(0);
    private tint = new Float32Array(0);
    private texOrigin = new Float32Array(0);
    private skin: Float32Array | null = null;
    private hair: Float32Array | null = null;
    private count = 0;
    private bounds: [number, number, number, number] | null = null;
    disposed = false;

    readonly geometry: Geometry;
    private ownsGeometry: boolean;

    constructor(scene: Scene, name: string, geometry: Geometry, o: DrawableOptions) {
        this.geometry = geometry;
        this.ownsGeometry = !!o.ownsGeometry;
        this.recordFloats = o.recordFloats ?? ITEM_RECORD;
        this.casterCascades = o.casterCascades ?? 0;
        this.mesh = new Mesh(name, scene);
        geometry.applyToMesh(this.mesh);
        this.mesh.material = o.material;
        this.mesh.isPickable = false;
        this.mesh.doNotSyncBoundingInfo = true;
        this.mesh.freezeWorldMatrix();
        if (o.renderingGroup) this.mesh.renderingGroupId = o.renderingGroup;
        this.ensure(1);
        this.mesh.thinInstanceCount = 0;
        this.mesh.isVisible = false;
    }

    private ensure(n: number): void {
        if (n <= this.capacity) return;
        const cap = Math.max(n, this.capacity * 2, 1);
        const grow = (a: Float32Array, k: number) => { const b = new Float32Array(cap * k); b.set(a.subarray(0, Math.min(a.length, b.length))); return b; };
        this.matrix = grow(this.matrix, 16);
        this.tint = grow(this.tint, 4);
        this.texOrigin = grow(this.texOrigin, 4);
        if (this.recordFloats >= PERSON_RECORD) { this.skin = grow(this.skin ?? new Float32Array(0), 4); this.hair = grow(this.hair ?? new Float32Array(0), 4); }
        this.capacity = cap;
        this.mesh.thinInstanceSetBuffer("matrix", this.matrix, 16, false);
        this.mesh.thinInstanceSetBuffer("tint", this.tint, 4, false);
        this.mesh.thinInstanceSetBuffer("texOrigin", this.texOrigin, 4, false);
        if (this.skin && this.hair) { this.mesh.thinInstanceSetBuffer("skin", this.skin, 4, false); this.mesh.thinInstanceSetBuffer("hair", this.hair, 4, false); }
    }

    /** Writes `count` records (recordFloats each, interleaved like the engine's storage buffers) and draws them. */
    setRecords(records: Float32Array, count: number): void {
        if (this.disposed) return;
        this.ensure(count);
        const f = this.recordFloats;
        for (let i = 0; i < count; i++) {
            const o = i * f;
            this.matrix.set(records.subarray(o, o + 16), i * 16);
            this.tint.set(records.subarray(o + 16, o + 20), i * 4);
            this.texOrigin.set(records.subarray(o + 20, o + 24), i * 4);
            if (this.skin && this.hair) {
                this.skin.set(records.subarray(o + 24, o + 28), i * 4);
                this.hair.set(records.subarray(o + 28, o + 32), i * 4);
            }
        }
        this.mesh.thinInstanceBufferUpdated("matrix");
        this.mesh.thinInstanceBufferUpdated("tint");
        this.mesh.thinInstanceBufferUpdated("texOrigin");
        if (this.skin) { this.mesh.thinInstanceBufferUpdated("skin"); this.mesh.thinInstanceBufferUpdated("hair"); }
        this.setCount(count);
    }

    /**
     * Writes the first record from its parts (a single object's Item uniform, as Buffer.write did).
     * Whether it is drawn is `setCount`'s business (showProp).
     */
    setItem(matrix: ArrayLike<number>, tint: ArrayLike<number>, texOrigin: ArrayLike<number>): void {
        if (this.disposed) return;
        this.ensure(1);
        for (let k = 0; k < 16; k++) this.matrix[k] = matrix[k];
        for (let k = 0; k < 4; k++) { this.tint[k] = tint[k] ?? 0; this.texOrigin[k] = texOrigin[k] ?? 0; }
        this.mesh.thinInstanceBufferUpdated("matrix");
        this.mesh.thinInstanceBufferUpdated("tint");
        this.mesh.thinInstanceBufferUpdated("texOrigin");
    }

    /** Instances drawn: 0 draws nothing (no draw call). */
    setCount(n: number): void {
        if (this.disposed) return;
        this.count = Math.min(n, this.capacity);
        this.mesh.thinInstanceCount = this.count;
        this.mesh.isVisible = this.count > 0;
    }

    get instanceCount(): number { return this.count; }

    /**
     * Render-space bounding sphere of everything it draws (null: always drawn). Babylon culls by it;
     * the shadow cascades use it to pick their casters.
     */
    setBounds(center: [number, number, number] | null, radius: number): void {
        if (this.disposed) return;
        if (!center || radius < 0) {
            this.bounds = null;
            this.mesh.alwaysSelectAsActiveMesh = true;
            return;
        }
        this.bounds = [center[0], center[1], center[2], radius];
        this.mesh.alwaysSelectAsActiveMesh = false;
        const r = new Vector3(radius, radius, radius);
        const c = new Vector3(center[0], center[1], center[2]);
        this.mesh.setBoundingInfo(new BoundingInfo(c.subtract(r), c.add(r)));
    }

    get sphere(): [number, number, number, number] | null { return this.bounds; }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        if (this.ownsGeometry) { this.mesh.dispose(false, false); this.geometry.dispose(); return; }
        // A shared geometry (a MeshCache key's) outlives its meshes: its owner releases it.
        this.geometry.releaseForMesh(this.mesh, false);
        this.mesh.dispose(false, false);
    }
}
