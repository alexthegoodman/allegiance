// A small pool of mesh workers (mesh_worker.ts): jobs go to the least busy worker and come back as
// promises. Also polled synchronously by job id (CityHouses asks "pending / done / failed" each
// frame, the way it polled the engine's worker isolate).

import type { WorkerJob, WorkerResult } from "./mesh_worker";

interface Pending { resolve: (r: WorkerResult) => void; reject: (e: Error) => void; worker: number }

export class WorkerPool {
    private workers: Worker[] = [];
    private load: number[] = [];
    private pending = new Map<number, Pending>();
    private states = new Map<number, "pending" | "done" | "failed">();
    private serial = 1;
    jobsRun = 0;
    lastError: string | null = null;

    constructor(size = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 4) - 2))) {
        for (let i = 0; i < size; i++) {
            const w = new Worker(new URL("./mesh_worker.ts", import.meta.url), { type: "module", name: `mesh-worker-${i}` });
            w.onmessage = (e: MessageEvent<{ id: number; result?: WorkerResult; error?: string }>) => this.finish(e.data.id, e.data.result, e.data.error);
            w.onerror = e => { this.lastError = e.message; };
            this.workers.push(w);
            this.load.push(0);
        }
    }

    get size(): number { return this.workers.length; }
    get busy(): number { return this.pending.size; }

    /** Runs a job; transfers the typed arrays it carries. */
    run(job: WorkerJob): { id: number; done: Promise<WorkerResult> } {
        const id = this.serial++;
        let best = 0;
        for (let i = 1; i < this.workers.length; i++) if (this.load[i] < this.load[best]) best = i;
        this.load[best]++;
        this.states.set(id, "pending");
        const done = new Promise<WorkerResult>((resolve, reject) => this.pending.set(id, { resolve, reject, worker: best }));
        const transfer: Transferable[] = job.kind === "simplify" ? [job.vertexData.buffer, job.indexData.buffer] : [];
        this.workers[best].postMessage({ id, job }, transfer);
        return { id, done };
    }

    /** A job's state, for polling. Finished states are forgotten once read twice over. */
    state(id: number): "pending" | "done" | "failed" | "unknown" {
        return this.states.get(id) ?? "unknown";
    }

    forget(id: number): void { this.states.delete(id); }

    private finish(id: number, result: WorkerResult | undefined, error: string | undefined): void {
        const p = this.pending.get(id);
        if (!p) return;
        this.pending.delete(id);
        this.load[p.worker]--;
        this.jobsRun++;
        if (result) { this.states.set(id, "done"); p.resolve(result); }
        else { this.states.set(id, "failed"); this.lastError = error ?? "worker failed"; p.reject(new Error(this.lastError)); }
    }
}
