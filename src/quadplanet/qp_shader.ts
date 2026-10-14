// QuadPlanet's shader conventions: the World uniform, material ids and surface kinds. The shader
// itself (originally WGSL here) is GLSL now, in engine/shaders/world_glsl.ts; what it does:
//
// - Terrain chunks: biome vertex colors, sun + sky ambient that fades to night on the dark side,
//   a sun glint on water, and aerial perspective: every fragment is hazed by how much of the
//   planet's atmosphere shell lies between it and the camera. From orbit that same haze is what
//   makes the limb glow; on the ground it is the blue distance.
// - The sky: a sphere that follows the camera. Stars and the sun, and for each planet the
//   scattering along the view ray through its atmosphere shell - so standing on a planet you get
//   a blue (or amber) day sky that darkens toward space as you climb, and from space a thin glowing
//   rim around each planet.
// - The ship and walker: painted, glass and glowing (engine) surfaces, placed by a per-object
//   model matrix so they move without re-uploading geometry.
//
// - Procedural texturing: terrain gets rock, soil and grass, snow, water and ice surface detail
//   from 3D noise evaluated in the fragment shader, with bump-mapped normals from the noise's
//   analytic gradient. Every octave fades out once it is finer than a pixel, so the detail is
//   there when you look at the ground at your feet and never shimmers on a distant mountain.
//   Which texture a spot gets comes from the vertex color: its alpha is the rock weight
//   (planet.rs Planet::color), snow is told apart by its color.
//
// Coordinates. Planets are tens (Earth: thousands) of kilometers across and hundreds apart, more than f32 can place
// to the millimeter. Everything is drawn relative to a render origin near the camera
// (quadplanet_addon.ts): chunk vertices are relative to their own origin and the per-object model
// matrix moves them by (chunk origin - render origin); the camera and the planets in the World
// uniform are given relative to it too. Texture noise must not depend on that origin, so each
// chunk also gets `tex_origin`, its own origin modulo TEX_PERIOD: the noise repeats every
// TEX_PERIOD meters, so neighbouring chunks agree on it, and the numbers it sees stay small.
//
// Depth is logarithmic (written per fragment): the engine's depth buffer is 24-bit with a 0.1 m
// near plane, which leaves hundreds of meters of depth resolution at the distance of a far
// mountain range. log2(1 + w) spreads it evenly over every scale, from the walker's boots to the
// next planet.
//
// Material ids ride in uv.x's integer part and the chunk's quadtree level in uv.y's; terrain
// chunks put their local grid position in the fractions (mesh.rs pack_chunk_uv) so the debug
// view can color each level and outline each chunk.
//
// Earth's cities (city.rs, qp_city.ts) add:
// - 11 / 6: house surfaces (matte paint, brick, roofing...); 6 is a house's foundation, whose
//   bottom is pushed down by the item's tex_origin.w so it reaches the lowest ground under it.
// - 7: see-through window glass (a full house, which has rooms to see): an ordered dither leaves
//   the color's alpha share of the pane out, like Mesha's viewport.
// - 8: building boxes (level of detail 2), one mesh per city tile. Each vertex knows its
//   building's anchor: uv.x's fraction and uv.y's fraction hold the x/z offset from it
//   ((f - 0.5) * 4000 m), the color's alpha the height above it; uv.y's integer part is 1 for a
//   house and 2 for another building standing on the ground. A house box within world.city.x of
//   the camera, and another building's box within world.city.z, is folded away: a model is there
//   instead (qp_city.ts houses, qp_buildings.ts city buildings). Walls get rows of windows from
//   the height above the anchor.
// - 11's surface kind rides in uv.y's integer part (surfaceKind, from the Mesha material): 1 brick,
//   2 render/plaster/paint, 3 concrete, 4 dressed stone, 5 roof tiles and slates, 6 metal, 7 wood,
//   8 fieldstone (rubble walls; a texture set in Allegiance, dressed stone here). Each
//   is drawn procedurally in the object's own space (courses, joints, tiles, planks, blotches)
//   with weathering: grime rising from the ground and rain streaks running down the walls.
// - 10: roads, faded out past world.city.y and nudged toward the camera in depth so they stay
//   over the ground they are draped on, even where a coarser terrain chunk is drawn.

/** Floats in the World uniform (14 vec4). */
export const WORLD_FLOATS = 56;
/** Floats in the per-object Item uniform: model matrix, tint, texture origin. */
export const ITEM_FLOATS = 24;
/** The texture noise repeats every this many meters (a power of two: see the shader). */
export const TEX_PERIOD = 1024;
export const MAX_PLANETS = 4;

export interface WorldUniform {
    sunDir: [number, number, number];
    time: number;
    sunColor: [number, number, number];
    exposure: number;
    debugLod: boolean;
    /** Outline every chunk (independent of the level tint). */
    debugOutlines?: boolean;
    planets: { center: [number, number, number]; radius: number; atmosphere: [number, number, number]; atmosphereHeight: number }[];
    /** Cities: house boxes within `hideRadius` of the camera (other buildings' within `buildingHideRadius`) are folded away; roads end at `roadDistance`. */
    city?: { hideRadius: number; roadDistance: number; buildingHideRadius?: number };
    /**
     * Clouds and wind (default: none). `cloudOffset` is where the cloud noise is sampled relative
     * to the render origin, kept small by the caller (render origin plus drift, modulo
     * CLOUD_PERIOD); `cloudAltitude` is the cloud layer's height above the first planet's radius;
     * `wind` is the wind's velocity in render space (m/s).
     */
    weather?: { cloudCover: number; cloudOffset: [number, number, number]; cloudAltitude: number; wind: [number, number, number] };
}

/** The cloud noise repeats every this many meters. */
export const CLOUD_PERIOD = 65536;

export function packWorld(w: WorldUniform): Float32Array {
    const out = new Float32Array(WORLD_FLOATS);
    out.set([...w.sunDir, w.time], 0);
    out.set([...w.sunColor, 0], 4);
    out.set([w.exposure, w.debugLod ? 1 : 0, Math.min(MAX_PLANETS, w.planets.length), w.debugOutlines ? 1 : 0], 8);
    for (let i = 0; i < MAX_PLANETS; i++) {
        const p = w.planets[i];
        if (!p) continue;
        out.set([...p.center, p.radius], 12 + i * 4);
        out.set([...p.atmosphere, p.atmosphereHeight], 12 + MAX_PLANETS * 4 + i * 4);
    }
    out.set([w.city?.hideRadius ?? 0, w.city?.roadDistance ?? 3000, w.city?.buildingHideRadius ?? 0, 0], 12 + MAX_PLANETS * 8);
    const wx = w.weather;
    if (wx) {
        out.set([...wx.cloudOffset, wx.cloudCover], 16 + MAX_PLANETS * 8);
        out.set([...wx.wind, wx.cloudAltitude], 20 + MAX_PLANETS * 8);
    }
    return out;
}

export const MATERIAL_PAINT = 3;
export const MATERIAL_GLOW = 4;
export const MATERIAL_GLASS = 5;
export const MATERIAL_SKY = 9;
export const MATERIAL_FOUNDATION = 6;
export const MATERIAL_HOUSE = 11;
export const MATERIAL_CLEAR_GLASS = 7;
export const MATERIAL_BUILDING_BOX = 8;
export const MATERIAL_ROAD = 10;

/** Surface kinds for material 11 (uv.y's integer part): see the top. */
export const SURFACE = { plain: 0, brick: 1, render: 2, concrete: 3, stone: 4, tiles: 5, metal: 6, wood: 7, fieldstone: 8 } as const;

/** Distinct authored finishes; procedural rendering still uses their broad SURFACE category. */
export const FINISH = { paint: 9, buff: 10, whitewash: 11, granite: 12, marble: 13,
    clay: 14, cedar: 15, seam: 16, corrugated: 17, walnut: 18, cherry: 19, slate: 20, ash: 21 } as const;
export const FINISH_BASE = [0, 1, 2, 3, 4, 5, 6, 7, 8, 2, 1, 1, 4, 4, 5, 5, 6, 6, 7, 7, 4, 7];

/** Keep finish identity in cached meshes so a game can select an authored texture set. */
export function materialSurfaceKind(id: string | undefined): number {
    if (id?.startsWith("paint.")) return FINISH.paint;
    const finishes: Record<string, number> = {
        "masonry.buff": FINISH.buff, "masonry.whitewash": FINISH.whitewash,
        "stone.granite": FINISH.granite, "stone.marble": FINISH.marble, "stone.slate": FINISH.slate,
        "roofing.clay": FINISH.clay, "roofing.cedar": FINISH.cedar, "roofing.seam": FINISH.seam,
        "metal.corrugated": FINISH.corrugated, "metal.corrugatedGreen": FINISH.corrugated,
        "wood.walnut": FINISH.walnut, "wood.cherry": FINISH.cherry, "wood.ash": FINISH.ash,
    };
    return (id ? finishes[id] : undefined) ?? surfaceKind(id);
}

/** The surface kind a Mesha material is drawn as (by its id; plain when unknown). */
export function surfaceKind(id: string | undefined): number {
    if (!id) return SURFACE.plain;
    if (id === "masonry.brick" || id === "masonry.buff" || id === "masonry.whitewash") return SURFACE.brick;
    if (id === "masonry.stucco" || id === "masonry.plaster" || id.startsWith("paint.")) return SURFACE.render;
    if (id.startsWith("masonry.") && id.includes("oncrete") || id.startsWith("composite.")) return SURFACE.concrete;
    if (id === "masonry.fieldstone") return SURFACE.fieldstone;
    if (id.startsWith("stone.")) return SURFACE.stone;
    if (id === "roofing.seam") return SURFACE.metal;
    if (id.startsWith("roofing.")) return SURFACE.tiles;
    if (id.startsWith("metal.")) return SURFACE.metal;
    if (id.startsWith("wood.")) return SURFACE.wood;
    return SURFACE.plain;
}
