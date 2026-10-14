// The mesh worker: Mesha evaluations and level-of-detail simplification off the main thread, so a
// house (10-150 ms) or a city block never holds a frame. It replaces the engine's worker isolate
// (qp_house_worker.ts) and its Rust simplifier thread. Nothing here touches the scene: results go
// back to the main thread, which puts them in the mesh cache.

import { simplifierReady, simplifyPacked, type SimplifyParams } from "./mesh_simplify";
import { HOUSE_MODEL, type CityModel } from "../quadplanet/qp_city";
import { BUILDING_MODEL } from "../quadplanet/qp_buildings";
import type { ParamValues } from "../mesha/mesha_object";

export type WorkerJob =
    | { kind: "simplify"; vertexData: Float32Array; indexData: Uint32Array; params: SimplifyParams }
    /** A city model (house or city block): evaluated once, packed at the LODs wanted, LOD 1 simplified. */
    | { kind: "city"; model: "house" | "box"; values: ParamValues; lod0: boolean; lod1: boolean };

export interface PackedMesh { vertexData: Float32Array; indexData: Uint32Array; triangles: number; sourceTriangles?: number }

export type WorkerResult =
    | { kind: "simplify"; mesh: PackedMesh }
    | { kind: "city"; lod0: PackedMesh | null; lod1: PackedMesh | null };

const MODELS: Record<"house" | "box", CityModel> = { house: HOUSE_MODEL, box: BUILDING_MODEL };

async function run(job: WorkerJob): Promise<WorkerResult> {
    await simplifierReady;
    if (job.kind === "simplify") {
        const r = simplifyPacked(job.vertexData, job.indexData, job.params);
        return { kind: "simplify", mesh: { vertexData: r.vertexData, indexData: r.indexData, triangles: r.stats.trianglesOut, sourceTriangles: r.stats.trianglesIn } };
    }
    const m = MODELS[job.model];
    const e = m.evaluate(job.values);
    let lod0: PackedMesh | null = null, lod1: PackedMesh | null = null;
    if (job.lod0) lod0 = m.pack(e, 0);
    if (job.lod1) {
        const full = m.pack(e, 1);
        const r = simplifyPacked(full.vertexData, full.indexData, m.lod1Simplify);
        lod1 = { vertexData: r.vertexData, indexData: r.indexData, triangles: r.stats.trianglesOut, sourceTriangles: full.triangles };
    }
    return { kind: "city", lod0, lod1 };
}

const scope = self as unknown as { onmessage: ((e: MessageEvent) => void) | null; postMessage: (m: unknown, transfer?: Transferable[]) => void };
scope.onmessage = (e: MessageEvent<{ id: number; job: WorkerJob }>) => {
    const { id, job } = e.data;
    run(job).then(result => {
        const transfer = new Set<Transferable>();
        const add = (m: PackedMesh | null) => { if (m) { transfer.add(m.vertexData.buffer); transfer.add(m.indexData.buffer); } };
        if (result.kind === "simplify") add(result.mesh); else { add(result.lod0); add(result.lod1); }
        scope.postMessage({ id, result }, [...transfer]);
    }, (err: Error) => scope.postMessage({ id, error: err?.message ?? String(err) }));
};
