// The UI layer: a 2D canvas over the world, standing in for Entropy.UI's retained rects and texts
// (al_ui.ts DrawApi). The game describes its whole frame into a Painter, which resubmits only when
// the description changed; this draws a submitted frame the way the engine did: every rect first,
// then every text (each text's background fill right before it), so the UI's "panel over text"
// trick (al_ui.ts Painter.panel) works the same. Coordinates are CSS pixels.

import type { Color, DrawApi } from "../game/al_ui";

type RectOp = Parameters<DrawApi["drawRect"]>[0];
type TextOp = Parameters<DrawApi["drawText"]>[0];

const css = (c: Color) => `rgba(${Math.round(c[0] * 255)}, ${Math.round(c[1] * 255)}, ${Math.round(c[2] * 255)}, ${c[3]})`;

export class CanvasUi implements DrawApi {
    private ctx: CanvasRenderingContext2D;
    private rects: RectOp[] = [];
    private texts: TextOp[] = [];
    private dirty = true;
    private wraps = new Map<string, string[]>();

    constructor(private canvas: HTMLCanvasElement) {
        this.ctx = canvas.getContext("2d")!;
        window.addEventListener("resize", () => { this.dirty = true; });
    }

    clear(): void { this.rects = []; this.texts = []; this.dirty = true; }
    drawRect(c: RectOp): void { this.rects.push(c); this.dirty = true; }
    drawText(c: TextOp): void { this.texts.push(c); this.dirty = true; }

    /** Window size in CSS pixels. */
    size(): [number, number] { return [window.innerWidth, window.innerHeight]; }

    /** Draws the submitted frame if it changed (or the window did). */
    present(): void {
        const dpr = window.devicePixelRatio || 1;
        const w = Math.round(window.innerWidth * dpr), h = Math.round(window.innerHeight * dpr);
        if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; this.dirty = true; }
        if (!this.dirty) return;
        this.dirty = false;
        const g = this.ctx;
        g.setTransform(dpr, 0, 0, dpr, 0, 0);
        g.clearRect(0, 0, window.innerWidth, window.innerHeight);
        for (const r of this.rects) {
            const [x, y] = r.position, [rw, rh] = r.size;
            if (r.color[3] > 0) { g.fillStyle = css(r.color); g.fillRect(x, y, rw, rh); }
            if (r.strokeThickness > 0 && r.strokeColor[3] > 0) {
                g.lineWidth = r.strokeThickness;
                g.strokeStyle = css(r.strokeColor);
                const s = r.strokeThickness / 2;
                g.strokeRect(x + s, y + s, rw - r.strokeThickness, rh - r.strokeThickness);
            }
        }
        g.textBaseline = "top";
        for (const t of this.texts) {
            const [x, y] = t.position, [tw, th] = t.dimensions;
            if (t.backgroundFill[3] > 0) { g.fillStyle = css(t.backgroundFill); g.fillRect(x, y, tw, th); }
            if (!t.text.trim() || t.color[3] <= 0) continue;
            g.font = `${t.fontSize}px "${t.fontFamily}", sans-serif`;
            g.fillStyle = css(t.color);
            const lines = this.wrap(t.text, tw, t.fontSize, t.fontFamily);
            const lh = t.fontSize * 1.25;
            lines.forEach((line, i) => g.fillText(line, x, y + i * lh));
        }
    }

    /** Word wrap to a width (cached: most texts repeat frame to frame). */
    private wrap(text: string, width: number, size: number, family: string): string[] {
        const key = `${size}|${family}|${Math.round(width)}|${text}`;
        const known = this.wraps.get(key);
        if (known) return known;
        const g = this.ctx;
        const out: string[] = [];
        for (const para of text.split("\n")) {
            const words = para.split(" ");
            let line = "";
            for (const w of words) {
                const next = line ? `${line} ${w}` : w;
                if (line && width > 0 && g.measureText(next).width > width) { out.push(line); line = w; }
                else line = next;
            }
            out.push(line);
        }
        if (this.wraps.size > 4000) this.wraps.clear();
        this.wraps.set(key, out);
        return out;
    }
}

/** Waits for the UI's fonts (Bungee, Vina Sans, Play) so the first frames measure and draw right. */
export async function loadFonts(): Promise<void> {
    try {
        await Promise.all(["16px Bungee", "16px \"Vina Sans\"", "16px Play", "bold 16px Play"].map(f => document.fonts.load(f)));
    } catch { /* fallback fonts stand in */ }
}
