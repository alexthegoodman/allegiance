// Seeded 3D simplex noise (after Stefan Gustavson's public-domain reference) plus the fractal
// layers QuadPlanet's terrain is built from. Sampled on the unit sphere, so a planet's surface is
// continuous everywhere: there are no seams at the cube-face edges and no poles pinching.
// Ported from QuadPlanet's noise.rs (same permutation from the same Mulberry32 seed).

const GRAD3 = [
    1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1, 0,
    1, 0, 1, -1, 0, 1, 1, 0, -1, -1, 0, -1,
    0, 1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1,
];

const F3 = 1 / 3;
const G3 = 1 / 6;

/** Mulberry32: a tiny deterministic PRNG, so a seed always builds the same planet. */
export class Mulberry32 {
    constructor(private state: number) { this.state >>>= 0; }
    next(): number {
        this.state = (this.state + 0x6d2b79f5) >>> 0;
        let t = this.state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }
}

export class Simplex3 {
    private perm = new Uint8Array(512);
    private permMod12 = new Uint8Array(512);

    constructor(seed: number) {
        const rand = new Mulberry32(seed);
        const p = new Uint8Array(256);
        for (let i = 0; i < 256; i++) p[i] = i;
        for (let i = 255; i >= 1; i--) {
            const j = Math.floor(rand.next() * (i + 1));
            const t = p[i]; p[i] = p[j]; p[j] = t;
        }
        for (let i = 0; i < 512; i++) {
            this.perm[i] = p[i & 255];
            this.permMod12[i] = this.perm[i] % 12;
        }
    }

    /** Noise in roughly [-1, 1]. */
    noise(xin: number, yin: number, zin: number): number {
        const perm = this.perm, pm = this.permMod12;
        const s = (xin + yin + zin) * F3;
        const i = Math.floor(xin + s), j = Math.floor(yin + s), k = Math.floor(zin + s);
        const t = (i + j + k) * G3;
        const x0 = xin - (i - t), y0 = yin - (j - t), z0 = zin - (k - t);
        let i1: number, j1: number, k1: number, i2: number, j2: number, k2: number;
        if (x0 >= y0) {
            if (y0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 1; k2 = 0; }
            else if (x0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 0; k2 = 1; }
            else { i1 = 0; j1 = 0; k1 = 1; i2 = 1; j2 = 0; k2 = 1; }
        } else if (y0 < z0) { i1 = 0; j1 = 0; k1 = 1; i2 = 0; j2 = 1; k2 = 1; }
        else if (x0 < z0) { i1 = 0; j1 = 1; k1 = 0; i2 = 0; j2 = 1; k2 = 1; }
        else { i1 = 0; j1 = 1; k1 = 0; i2 = 1; j2 = 1; k2 = 0; }
        const x1 = x0 - i1 + G3, y1 = y0 - j1 + G3, z1 = z0 - k1 + G3;
        const x2 = x0 - i2 + 2 * G3, y2 = y0 - j2 + 2 * G3, z2 = z0 - k2 + 2 * G3;
        const x3 = x0 - 1 + 3 * G3, y3 = y0 - 1 + 3 * G3, z3 = z0 - 1 + 3 * G3;
        const ii = i & 255, jj = j & 255, kk = k & 255;
        let n = 0;
        const corner = (g: number, x: number, y: number, z: number, tt: number) => {
            const t2 = tt * tt;
            return t2 * t2 * (GRAD3[g] * x + GRAD3[g + 1] * y + GRAD3[g + 2] * z);
        };
        const t0 = 0.6 - x0 * x0 - y0 * y0 - z0 * z0;
        if (t0 > 0) n += corner(pm[ii + perm[jj + perm[kk]]] * 3, x0, y0, z0, t0);
        const t1 = 0.6 - x1 * x1 - y1 * y1 - z1 * z1;
        if (t1 > 0) n += corner(pm[ii + i1 + perm[jj + j1 + perm[kk + k1]]] * 3, x1, y1, z1, t1);
        const t2 = 0.6 - x2 * x2 - y2 * y2 - z2 * z2;
        if (t2 > 0) n += corner(pm[ii + i2 + perm[jj + j2 + perm[kk + k2]]] * 3, x2, y2, z2, t2);
        const t3 = 0.6 - x3 * x3 - y3 * y3 - z3 * z3;
        if (t3 > 0) n += corner(pm[ii + 1 + perm[jj + 1 + perm[kk + 1]]] * 3, x3, y3, z3, t3);
        return 32 * n;
    }

    /**
     * Fractal Brownian motion, normalized to roughly [-1, 1]. `keep` (fractional) is how many
     * octaves to actually add - the rest are left out, the last one faded in - so a coarse mesh
     * can sample a band-limited version of the same field. The normalization always counts every
     * octave, so leaving detail out never rescales what remains.
     */
    fbm(x: number, y: number, z: number, octaves: number, lacunarity: number, gain: number, keep: number): number {
        let sum = 0, amp = 1, freq = 1, norm = 0;
        for (let o = 0; o < octaves; o++) {
            const w = Math.max(0, Math.min(1, keep - o));
            if (w > 0) sum += this.noise(x * freq + o * 17.1, y * freq - o * 9.7, z * freq + o * 5.3) * amp * w;
            norm += amp;
            amp *= gain;
            freq *= lacunarity;
        }
        return sum / norm;
    }

    /** Ridged multifractal in [0, 1]: sharp crests for mountain ranges. `keep` as for fbm. */
    ridged(x: number, y: number, z: number, octaves: number, keep: number): number {
        let sum = 0, amp = 0.5, freq = 1, weight = 1, norm = 0;
        for (let o = 0; o < octaves; o++) {
            const w = Math.max(0, Math.min(1, keep - o));
            if (w > 0) {
                let n = 1 - Math.abs(this.noise(x * freq + o * 3.3, y * freq + o * 7.7, z * freq - o * 1.9));
                n *= n;
                n *= weight;
                weight = Math.min(1, n * 2);
                sum += n * amp * w;
            }
            norm += amp;
            amp *= 0.5;
            freq *= 2.1;
        }
        return sum / norm;
    }
}
