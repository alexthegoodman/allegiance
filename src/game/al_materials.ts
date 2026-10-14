// Textured PBR surfaces: tiling material sets (base color, normal, roughness and height maps) drawn
// in Allegiance's own forward shader, not the engine's deferred PBR path. That path would cost
// the atmosphere, logarithmic depth, render origin and sun shadows this shader already has; the
// maps are what make a surface rich, and they work here just as well.
//
// - A set covers city surface kinds (qp_shader.ts SURFACE): fieldstone on rubble walls.
//   Each map type is one mipmapped texture array (engine/materials.ts), a layer per set, sampled
//   by the world shader (engine/shaders/world_glsl.ts TEXTURED). A file that cannot be read loads as a magenta/black checkerboard (base color)
//   or a neutral value (the others), so a missing asset is plain to see.
// - Meshes from Mesha have no texture coordinates, so the maps are laid on the same planes the
//   procedural surfaces use (along and up a wall, across and up a roof's slope), in the object's
//   own space, so they stay put on a building.
// - Near the camera the height map drives parallax occlusion mapping: the view ray is stepped
//   through the height field so stones stand proud of their joints and hide what lies behind
//   them. It fades out by PARALLAX_FAR, where plain normal mapping takes over, and the height also
//   darkens the crevices. Roughness feeds a normalized specular lobe (dielectric, F0 = 0.04).

import { SURFACE, FINISH } from "../quadplanet/qp_shader";

export interface MaterialSet {
    /** Folder under MATERIAL_DIR holding basecolor.png, normal.png, roughness.png and height.png. */
    name: string;
    /** Surface kinds drawn with it (qp_shader.ts SURFACE). */
    kinds: number[];
    /** Meters one repeat of the maps covers. */
    tile: number;
    /** How deep the height map's range is (meters): the parallax depth. */
    depth: number;
}

/** Where the sets are served from (public/materials). */
export const MATERIAL_DIR = "materials";
export const GROUND = { asphalt: 22, grass: 23, meadow: 24, soil: 25, snow: 26 } as const;
export const MATERIAL_SETS: MaterialSet[] = [
    // Rubble walls: cottages, farmhouse plinths and chimneys, and the compounds' perimeter walls.
    { name: "fieldstone", kinds: [SURFACE.fieldstone], tile: 1.6, depth: 0.15 },
    // Repeat sizes are estimates from the visible courses, not metadata supplied by the ZIPs.
    { name: "brick-red", kinds: [SURFACE.brick], tile: 1.8, depth: 0.15 },
    { name: "brick-buff", kinds: [FINISH.buff], tile: 1.8, depth: 0.1 },
    { name: "stucco", kinds: [SURFACE.render], tile: 1.5, depth: 0.08 },
    { name: "brick-whitewashed", kinds: [FINISH.whitewash], tile: 1.8, depth: 0.1 },
    { name: "concrete", kinds: [SURFACE.concrete], tile: 2.4, depth: 0.08 },
    { name: "sandstone-blocks", kinds: [SURFACE.stone], tile: 2.4, depth: 0.15 },
    { name: "granite", kinds: [FINISH.granite], tile: 2.4, depth: 0.08 },
    { name: "marble", kinds: [FINISH.marble], tile: 2, depth: 0.02 },
    { name: "roof-clay", kinds: [FINISH.clay], tile: 1.8, depth: 0.1 },
    { name: "roof-cedar", kinds: [FINISH.cedar], tile: 1.8, depth: 0.1 },
    { name: "roof-standing-seam", kinds: [FINISH.seam], tile: 2.4, depth: 0.15 },
    { name: "metal-corrugated", kinds: [FINISH.corrugated], tile: 2, depth: 0.15 },
    { name: "wood-oak", kinds: [SURFACE.wood, FINISH.ash], tile: 2.4, depth: 0.03 },
    { name: "wood-walnut", kinds: [FINISH.walnut], tile: 2, depth: 0.03 },
    { name: "wood-cherry", kinds: [FINISH.cherry], tile: 2, depth: 0.03 },
    { name: "asphalt", kinds: [GROUND.asphalt], tile: 4, depth: 0.05 },
    { name: "grass-ground", kinds: [GROUND.grass], tile: 2, depth: 0.1 },
    { name: "meadow-ground", kinds: [GROUND.meadow], tile: 2, depth: 0.1 },
    { name: "soil", kinds: [GROUND.soil], tile: 2, depth: 0.1 },
    { name: "snow", kinds: [GROUND.snow], tile: 4, depth: 0.1 },
];
export const MATERIAL_MAPS = ["basecolor", "normal", "roughness", "height", "metallic"] as const;
export const MATERIAL_SIZE = 1024;
/** Parallax is full within PARALLAX_NEAR meters and gone by PARALLAX_FAR. */
export const PARALLAX_NEAR = 6;
export const PARALLAX_FAR = 14;

/** Texture ids, by map. */
export const materialTextureId = (map: typeof MATERIAL_MAPS[number]): string => `allegiance-material-${map}`;

/** The files of one map, a layer per set (WebP made from the authored PNGs by scripts/materials.mjs). */
export const materialFiles = (map: typeof MATERIAL_MAPS[number], sets = MATERIAL_SETS): string[] =>
    sets.map(s => `${MATERIAL_DIR}/${s.name}/${map}.webp`);

/** What a map's missing layer becomes: the checkerboard for color, neutral values for the rest. */
export function materialFallback(map: typeof MATERIAL_MAPS[number]): "checker" | [number, number, number, number] {
    if (map === "basecolor") return "checker";
    if (map === "normal") return [0.5, 0.5, 1, 1];
    if (map === "roughness") return [0.8, 0.8, 0.8, 1];
    if (map === "metallic") return [0, 0, 0, 1];
    return [1, 1, 1, 1];
}

export interface MaterialLoad { missing: { map: string; set: string }[] }

/** Loads every map array (once, at startup). */
export function loadMaterials(load: (config: { id: string; files: string[]; srgb: boolean; size: number; fallback: "checker" | [number, number, number, number] }) => { missing: number[] }): MaterialLoad {
    const missing: { map: string; set: string }[] = [];
    for (const map of MATERIAL_MAPS) {
        const r = load({ id: materialTextureId(map), files: materialFiles(map), srgb: map === "basecolor", size: MATERIAL_SIZE, fallback: materialFallback(map) });
        for (const i of r.missing) missing.push({ map, set: MATERIAL_SETS[i]?.name ?? String(i) });
    }
    return { missing };
}

/** Per surface kind: its layer (-1: procedural), tile and depth, as WGSL constants. */
export function materialTable(sets = MATERIAL_SETS): { layer: number[]; tile: number[]; depth: number[] } {
    const size = Math.max(27, ...sets.flatMap(s => s.kinds.map(k => k + 1)));
    const layer = new Array(size).fill(-1), tile = new Array(size).fill(1), depth = new Array(size).fill(0);
    sets.forEach((s, i) => { for (const k of s.kinds) { layer[k] = i; tile[k] = s.tile; depth[k] = s.depth; } });
    return { layer, tile, depth };
}
