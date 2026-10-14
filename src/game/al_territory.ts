// The territory overlay: flying high, the ground is washed in the color of whoever governs it -
// your party's color where you rule, each rival's where they do - with a bright line along every
// border, so you can read the map from the air. It fades in with altitude.
//
// Ownership follows regionAt (al_state.ts) exactly: a point inside a settlement's radius belongs to
// the nearest such settlement; anywhere else to the nearest hinterland anchor (the 108 regions).
// The terrain shader (engine/shaders/world_glsl.ts TERRITORY) works this out per pixel from up to
// TERRITORY_MAX places in one uniform array, rewritten as you fly.

export const TERRITORY_MAX = 64;
/** head (strength, count, border width, unused), then TERRITORY_MAX spots and TERRITORY_MAX colors. */
export const TERRITORY_FLOATS = 4 + TERRITORY_MAX * 8;
/** A place on the overlay: its center (render space), radius (meters; 0 for a hinterland anchor), and color. */
export interface TerritorySpot { at: [number, number, number]; radius: number; color: [number, number, number]; party: boolean }

/** How strongly the overlay shows at `altitude` meters above the ground: none below 120 m, full by 450 m. */
export function territoryStrength(altitude: number): number {
    const t = Math.max(0, Math.min(1, (altitude - 120) / 330));
    return t * t * (3 - 2 * t);
}

/** Border lines widen with altitude so they stay a few pixels across (meters). */
export function borderWidth(altitude: number): number {
    return Math.max(6, altitude * 0.012);
}

/** The uniform's floats. Settlements go first (the shader needs no order, but a truncated list keeps them). */
export function packTerritories(spots: readonly TerritorySpot[], strength: number, width: number): Float32Array {
    const out = new Float32Array(TERRITORY_FLOATS);
    const list = spots.slice(0, TERRITORY_MAX);
    out[0] = strength; out[1] = list.length; out[2] = width;
    list.forEach((s, i) => {
        const o = 4 + i * 4, c = 4 + TERRITORY_MAX * 4 + i * 4;
        out[o] = s.at[0]; out[o + 1] = s.at[1]; out[o + 2] = s.at[2]; out[o + 3] = s.radius;
        out[c] = s.color[0]; out[c + 1] = s.color[1]; out[c + 2] = s.color[2]; out[c + 3] = s.party ? 1 : 0;
    });
    return out;
}
