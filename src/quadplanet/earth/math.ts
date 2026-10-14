// Vector helpers for the Earth streamer: QuadPlanet's (qp_math.ts) in doubles, plus geography.
//
// A planet's own frame: +Y is the north pole, latitude 0 / longitude 0 is +Z, and east is +X, so
// a camera out on +Z looking at the planet with +Y up sees east to its right, as on a map.

export {
    type Vec3 as V3, add, sub, scale, addScaled, dot, cross, length, distance, clamp, smoothstep, normalize, anyPerpendicular, rotateAround,
} from "../qp_math";
import type { Vec3 } from "../qp_math";

const DEG = Math.PI / 180;

/** Unit direction (planet frame) of a latitude/longitude in degrees. */
export function latLonToDir(lat: number, lon: number): Vec3 {
    const la = lat * DEG, lo = lon * DEG;
    return [Math.cos(la) * Math.sin(lo), Math.sin(la), Math.cos(la) * Math.cos(lo)];
}

/** Latitude and longitude in degrees of a unit direction (planet frame). */
export function dirToLatLon(d: Vec3): [number, number] {
    return [Math.asin(Math.max(-1, Math.min(1, d[1]))) / DEG, Math.atan2(d[0], d[2]) / DEG];
}

/** FNV-1a 64-bit of a string, as two 32-bit halves [high, low] (the engine's mesh_cache stable_hash). */
export function stableHash64(s: string): [number, number] {
    // 64-bit FNV in 16-bit limbs: h = (h ^ byte) * 0x100000001b3.
    let h0 = 0x2325, h1 = 0x8422, h2 = 0x9ce4, h3 = 0xcbf2;
    const bytes = new TextEncoder().encode(s);
    for (const b of bytes) {
        h0 ^= b;
        // Multiply by 0x0000_0100_0000_01b3: (h << 40) + h * 0x1b3.
        const t0 = h0 * 0x1b3, t1 = h1 * 0x1b3, t2 = h2 * 0x1b3, t3 = h3 * 0x1b3;
        // h << 40 moves limb 0 to limb 2.5: limb k shifted by 40 bits = limb (k + 2) shifted by 8.
        const r0 = t0;
        const r1 = t1 + (r0 >>> 16);
        const r2 = t2 + (r1 >>> 16) + ((h0 << 8) & 0xffff);
        const r3 = t3 + (r2 >>> 16) + ((h0 >>> 8) & 0xff) + ((h1 << 8) & 0xffff);
        h0 = r0 & 0xffff; h1 = r1 & 0xffff; h2 = r2 & 0xffff; h3 = r3 & 0xffff;
    }
    return [((h3 << 16) | h2) >>> 0, ((h1 << 16) | h0) >>> 0];
}

/** stableHash64 as 16 hex digits. */
export function stableHashHex(s: string): string {
    const [hi, lo] = stableHash64(s);
    return hi.toString(16).padStart(8, "0") + lo.toString(16).padStart(8, "0");
}
