// GPU time per pass (EXT_disjoint_timer_query_webgl2), for the profiler (?profile): one query
// in flight per label, read back a few frames later, averaged.

type GL = WebGL2RenderingContext;
interface TimerExt { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number }

export class GpuTimer {
    private ext: TimerExt | null;
    private pending: { label: string; query: WebGLQuery }[] = [];
    private open: { label: string; query: WebGLQuery } | null = null;
    readonly totals = new Map<string, { ms: number; count: number }>();

    constructor(private gl: GL) {
        this.ext = gl.getExtension("EXT_disjoint_timer_query_webgl2") as TimerExt | null;
    }

    get available(): boolean { return !!this.ext; }

    begin(label: string): void {
        if (!this.ext || this.open) return;
        const q = this.gl.createQuery()!;
        this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, q);
        this.open = { label, query: q };
    }

    end(): void {
        if (!this.ext || !this.open) return;
        this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
        this.pending.push(this.open);
        this.open = null;
    }

    /** Collects finished queries (call once a frame). */
    poll(): void {
        if (!this.ext) return;
        const gl = this.gl;
        const disjoint = gl.getParameter(this.ext.GPU_DISJOINT_EXT);
        this.pending = this.pending.filter(p => {
            if (!gl.getQueryParameter(p.query, gl.QUERY_RESULT_AVAILABLE)) return true;
            if (!disjoint) {
                const ns = gl.getQueryParameter(p.query, gl.QUERY_RESULT) as number;
                const t = this.totals.get(p.label) ?? { ms: 0, count: 0 };
                t.ms += ns / 1e6; t.count++;
                this.totals.set(p.label, t);
            }
            gl.deleteQuery(p.query);
            return false;
        });
    }

    report(): Record<string, number> {
        const out: Record<string, number> = {};
        for (const [k, v] of this.totals) out[k] = Math.round(v.ms / Math.max(1, v.count) * 10) / 10;
        return out;
    }

    reset(): void { this.totals.clear(); }
}
