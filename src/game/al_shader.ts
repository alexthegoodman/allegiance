// Allegiance draws with QuadPlanet's shader (terrain, sky, atmosphere, cities) plus people: the
// GLSL is engine/shaders/world_glsl.ts. These are the material ids and poses it shares with the
// game's meshes. It adds clothing, body and per-person skin/hair materials:
//
// - 12: clothing, top  - colored by the item's tint.rgb (party armbands and uniforms recolor
//       without rebuilding the mesh);
// - 13: clothing, bottom - colored by the item's tex_origin.xyz;
// - 14: eyes, lips, shoes, gear - the vertex color;
// - 15/16: skin/hair - separate per-person colors, without new geometry.
//
// People are animated in the vertex shader: uv.y's integer part says which limb a vertex
// belongs to (0 rigid, 1/2 left/right leg, 3/4 left/right arm). Legs swing about the hip and
// arms about the shoulder by sin(phase) * amplitude, with phase = |tex_origin.w| and amplitude
// tint.w; uv.y's fractional part / 0.49 blends the limb into the torso. A negative
// tex_origin.w raises the arms to aim a weapon.
//
// People are instanced (al_crowd.ts): each instance's record (its Item and its skin and hair
// colors) arrives as per-instance attributes, instead of a uniform per person; the vertex stage
// passes it on (flat) so the fragment stage reads the same one.
//
// - 17: foliage (al_scatter.ts packFoliage): painted like 11, bent by the wind in the vertex
//       stage (uv.y's fraction is how far, in meters, the vertex bends in a full gust; an integer
//       part of 1 marks a leaf, which also flutters and lets the sun through from behind).
//
// - 18/19: fire and smoke (al_fx.ts): see MAT_FIRE / MAT_SMOKE.
//
// Broken building pieces (al_destruction.ts) are unit boxes in the house material stretched to
// size; their record's tex_origin.w is -1, so their procedural surface (brick, render...) is laid
// out in meters on the piece as drawn rather than on the unit box.
//
// Sun shadows (engine/shadows.ts): the caster variant draws what casts into the cascades - not the
// ground, water, roads, glass, glowing things or sky, and not the first-person weapon at the eye -
// and every surface is shaded by PCF over the cascade it falls in, with the cloud shadows on top
// (al_sky.ts places the cascades).

export const MAT_CLOTH_TOP = 12;
export const MAT_CLOTH_BOTTOM = 13;
export const MAT_BODY = 14;
export const MAT_SKIN = 15;
export const MAT_HAIR = 16;

export const MAT_FOLIAGE = 17;
/** Fire (al_fx.ts): flames, fireballs and sparks. Self-lit: vertex color x tint.rgb, brightness
 * tint.w, flickering; fades out by ordered dither below tex_origin.w (opacity). Casts nothing. */
export const MAT_FIRE = 18;
/** Smoke and dust (al_fx.ts): lit, colored by tint.rgb, faded by dither like fire. Casts nothing. */
export const MAT_SMOKE = 19;

export const HIP = 0.92;
export const SHOULDER = 1.42;
