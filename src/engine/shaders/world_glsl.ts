// The world's one shader, in GLSL ES 3.00 for Babylon's WebGL2 engine: a port of QuadPlanet's
// WGSL shader (qp_shader.ts QUADPLANET_SHADER) with everything Allegiance injected into it
// (al_shader.ts, al_clouds.ts, al_materials.ts, al_territory.ts), assembled by feature flags
// instead of string anchors:
//
// - TEXTURED: PBR material maps on the surface kinds that have a set (al_materials.ts).
// - TERRITORY: the territory overlay seen from the air, on the terrain (al_territory.ts).
// - PEOPLE: per-person skin and hair colors from the instance record (al_crowd.ts).
// - CASTER: the shadow caster (al_shader.ts vs_shadow): the same vertex, through a cascade's
//   light matrix, with what casts nothing collapsed away.
//
// Every mesh is drawn with Babylon thin instances: an instance's record (QuadPlanet's Item: model
// matrix, tint, texture origin) arrives as per-instance attributes (world0-3, tint, texOrigin)
// rather than a uniform or a storage-buffer element, so one shader path serves single objects,
// terrain chunks and instanced batches alike. The fragment stage reads the record through flat
// varyings.
//
// Material ids ride in uv.x's integer part (qp_shader.ts). Depth is logarithmic, written per
// fragment, exactly as in the original; GL's clip space runs -w..w where WebGPU's ran 0..w, so
// clip z is remapped and window depth (0..1) is the same value.

import { CLOUD_PERIOD, FINISH_BASE, MAX_PLANETS, TEX_PERIOD } from "../../quadplanet/qp_shader";
import { HIP, SHOULDER, MAT_FIRE, MAT_SMOKE, MAT_FOLIAGE } from "../../game/al_shader";
import { CLOUD_CACHE_COLUMNS, CLOUD_CACHE_HEIGHT, CLOUD_CACHE_SIZE, CLOUD_CACHE_TILE, CLOUD_CACHE_WIDTH } from "../../game/al_clouds";
import { GROUND, MATERIAL_SETS, PARALLAX_FAR, PARALLAX_NEAR, materialTable } from "../../game/al_materials";
import { TERRITORY_MAX } from "../../game/al_territory";

export interface WorldShaderOptions {
    textured: boolean; territory: boolean; people: boolean; caster: boolean;
    /** Write logarithmic depth per fragment (exact, but no early depth test) rather than per vertex. */
    fragmentDepth?: boolean;
    /** Diagnostics (?flat): vertex colors only, to tell vertex cost from shading cost. */
    flat?: boolean;
    flatAll?: boolean;
    /**
     * The material ids this variant draws: only their branches are compiled. Absent, the terrain
     * variant (territory) gets the terrain's materials and the others everything else.
     */
    materials?: readonly number[];
}

/** What each mesh family draws (engine/renderer.ts picks a variant per family). */
export const TERRAIN_MATERIALS = [0, 1, 2, 8, 10] as const;
export const SHADER_FAMILIES = {
    terrain: [0, 1, 2] as number[],
    cityTiles: [8, 10] as number[],
    sky: [9] as number[],
    buildings: [3, 4, 5, 6, 7, 11] as number[],
    props: [3, 4, 5, 6, 7, 11, MAT_FOLIAGE] as number[],
    effects: [3, 4, 6, 11, MAT_FIRE, MAT_SMOKE] as number[],
    people: [3, 4, 5, 7, 12, 13, 14, 15, 16] as number[],
};
export type ShaderFamily = keyof typeof SHADER_FAMILIES | "all";

const f = (x: number) => (Number.isInteger(x) ? `${x}.0` : String(x));

/** Vertex attributes every world mesh has (the engine's packed mesh layout) and the instance record. */
export const WORLD_ATTRIBUTES = ["position", "normal", "uv", "color", "tint", "texOrigin"];
export const PEOPLE_ATTRIBUTES = [...WORLD_ATTRIBUTES, "skin", "hair"];

export const WORLD_UNIFORMS = ["viewProjection", "u_world", "u_eye", "u_shadowMats", "u_shadowTexel", "u_shadowParams", "u_territory"];
export const WORLD_SAMPLERS = ["mat_basecolor", "mat_normal", "mat_roughness", "mat_height", "mat_metallic", "cloud_atlas", "shadow_maps"];

const HEADER = /* glsl */ `
precision highp float;
precision highp int;
precision highp sampler2DArray;
precision highp sampler2DArrayShadow;
`;

// The World uniform (qp_shader.ts packWorld): 14 vec4.
const WORLD_DECL = /* glsl */ `
uniform vec4 u_world[14];
uniform vec3 u_eye;
#define W_SUN_DIR u_world[0]
#define W_SUN_COLOR u_world[1]
#define W_PARAMS u_world[2]
#define W_PLANET(i) u_world[3 + (i)]
#define W_ATMOSPHERE(i) u_world[${3 + MAX_PLANETS} + (i)]
#define W_CITY u_world[${3 + 2 * MAX_PLANETS}]
#define W_CLOUD u_world[${4 + 2 * MAX_PLANETS}]
#define W_WIND u_world[${5 + 2 * MAX_PLANETS}]
// Always 0 (sun_color.w is never set): added to loop bounds so the shader compiler keeps them as
// loops instead of unrolling every call site (which made Chrome's D3D compile take 15 seconds).
#define LOOP0 int(u_world[1].w)
// Diagnostics (profiler only; packWorld's params.w, 0 in play): bit k turns feature k off.
#define DIAG_OFF(bit) ((int(W_PARAMS.w) & (bit)) != 0)
const float TEX_PERIOD = ${f(TEX_PERIOD)};
const float LOG_DEPTH_FAR = 1.0e8;
const float SKY_DEPTH = 0.99999;
float log_depth(float w) {
    return clamp(log2(max(w, 1.0e-6) + 1.0) / log2(LOG_DEPTH_FAR + 1.0), 0.0, 1.0);
}
`;

/** The material ids a variant compiles (WorldShaderOptions.materials, or its default). */
function variantIds(o: WorldShaderOptions): Set<number> {
    return new Set<number>(o.materials ?? (o.territory ? TERRAIN_MATERIALS : [3, 4, 5, 6, 7, 9, 11, 12, 13, 14, 15, 16, MAT_FIRE, MAT_SMOKE, MAT_FOLIAGE]));
}

/**
 * Which optional varyings a variant's materials read. Vertex outputs are much of the cost on
 * integrated GPUs (a flat shader reading all of them ran at half the speed of one reading two),
 * so a variant carries only what it uses; the fragment shader sees constants for the rest.
 */
function varyingNeeds(o: WorldShaderOptions) {
    const ids = variantIds(o);
    const has = (...m: number[]) => m.some(i => ids.has(i));
    return {
        localNormal: has(6, 8, 11),
        model: has(6, 11),
        tint: has(3, 4, 6, 11, 12, MAT_FIRE, MAT_SMOKE, MAT_FOLIAGE),
        texOrigin: has(11, 13, MAT_FIRE, MAT_SMOKE),
        people: o.people && has(15, 16),
    };
}

const VARYINGS = (o: WorldShaderOptions, fragment: boolean) => {
    const n = varyingNeeds(o);
    const opt = (need: boolean, decl: string, fallback: string) => (need ? decl : fragment ? fallback : "");
    return /* glsl */ `
varying vec3 v_world_pos;
varying vec3 v_normal;
varying vec2 v_uv;
varying vec4 v_color;
varying vec3 v_tex_pos;
${opt(n.localNormal, "varying vec3 v_local_normal;", "#define v_local_normal vec3(0.0, 1.0, 0.0)")}
${opt(n.tint, "flat varying vec4 v_tint;", "#define v_tint vec4(1.0, 1.0, 1.0, 0.0)")}
${opt(n.texOrigin, "flat varying vec4 v_tex_origin;", "#define v_tex_origin vec4(0.0)")}
${opt(n.model, "flat varying vec3 v_m0;\nflat varying vec3 v_m1;\nflat varying vec3 v_m2;", "#define v_m0 vec3(1.0, 0.0, 0.0)\n#define v_m1 vec3(0.0, 1.0, 0.0)\n#define v_m2 vec3(0.0, 0.0, 1.0)")}
${n.people ? "flat varying vec4 v_skin;\nflat varying vec4 v_hair;" : ""}
`;
};

// Wind (world.wind: velocity in render space, m/s) bends a plant over and back in gusts; the phase
// comes from where the plant stands on the street (tex_origin.xz), so a rebase does not jolt it.
const FOLIAGE_GLSL = /* glsl */ `
vec3 foliage_sway(float code, vec3 local, vec4 tex_origin, vec3 model_up) {
    float speed = length(W_WIND.xyz);
    if (speed < 0.01) { return vec3(0.0); }
    vec3 dir = W_WIND.xyz / speed;
    float bend = fract(code);
    bool leaf = code >= 1.0;
    float t = W_SUN_DIR.w;
    float ph = dot(tex_origin.xz, vec2(0.37, 0.23));
    float strength = clamp(speed / 7.0, 0.0, 1.6);
    float gust = 0.55 + 0.45 * sin(t * 0.55 - ph * 0.6) * sin(t * 0.21 + ph * 0.3);
    float sway = 0.45 + 0.55 * sin(t * 1.7 + ph) * (0.7 + 0.3 * sin(t * 2.9 + ph * 1.7));
    vec3 d = dir * bend * strength * (0.35 * gust + 0.4 * sway * gust);
    vec3 up = normalize(model_up);
    d = d - up * dot(d, d) * 0.35 / max(bend + 0.3, 0.3);
    if (leaf) {
        vec3 q = local * 3.1 + vec3(ph);
        d = d + vec3(sin(t * 7.3 + q.x), sin(t * 9.1 + q.y), sin(t * 8.2 + q.z)) * 0.025 * strength * (0.5 + gust);
    }
    return d;
}
`;

function vertexShader(o: WorldShaderOptions): string {
    const vary = varyingNeeds(o);
    return /* glsl */ `${HEADER}
attribute vec3 position;
attribute vec3 normal;
attribute vec2 uv;
attribute vec4 color;
attribute vec4 world0;
attribute vec4 world1;
attribute vec4 world2;
attribute vec4 world3;
attribute vec4 tint;
attribute vec4 texOrigin;
${o.people ? "attribute vec4 skin;\nattribute vec4 hair;" : ""}
uniform mat4 viewProjection;
${WORLD_DECL}
${o.caster ? "" : VARYINGS(o, false)}
${FOLIAGE_GLSL}

void main() {
    mat4 model = mat4(world0, world1, world2, world3);
    int material = int(floor(uv.x + 0.0005));
    vec4 clip;
    bool folded = false;
    vec3 world_pos;
    vec3 out_normal;
    if (material == 9) {
        // The sky sphere rides with the camera and sits at the far end of the depth range.
        vec3 w = u_eye + position * 30000.0;
        clip = viewProjection * vec4(w, 1.0);
        clip.z = clip.w * (2.0 * SKY_DEPTH - 1.0);
        world_pos = w;
        out_normal = normal;
    } else {
        vec3 pos = position;
        vec3 nrm = normal;
        if (material == 6 && pos.y < 0.01) {
            // A house's foundation reaches down to the lowest ground under it.
            pos.y = pos.y - texOrigin.w;
        }
        if (material >= 12 && material <= 16) {
            // People: swing the limbs about the hip / shoulder (al_shader.ts).
            int limb = int(floor(uv.y + 0.0005));
            if (limb > 0) {
                float weight = clamp(fract(uv.y) / 0.49, 0.0, 1.0);
                float phase = abs(texOrigin.w);
                bool aiming = texOrigin.w < 0.0;
                float side = (limb == 1 || limb == 3) ? 1.0 : -1.0;
                float ang = sin(phase) * tint.w * side;
                vec3 pivot = vec3(0.0, ${f(HIP)}, 0.0);
                if (limb >= 3) {
                    pivot = vec3(0.0, ${f(SHOULDER)}, 0.0);
                    ang = -ang * 0.8;
                    if (aiming) { ang = limb == 4 ? 1.5 : 1.15; }
                }
                ang = ang * weight;
                float c = cos(ang);
                float sn = sin(ang);
                vec3 q = pos - pivot;
                pos = pivot + vec3(q.x, q.y * c - q.z * sn, q.y * sn + q.z * c);
                nrm = vec3(nrm.x, nrm.y * c - nrm.z * sn, nrm.y * sn + nrm.z * c);
            }
        }
        vec4 w = model * vec4(pos, 1.0);
        if (material == ${MAT_FOLIAGE}) { w = vec4(w.xyz + foliage_sway(uv.y, pos, texOrigin, model[1].xyz), 1.0); }
        clip = viewProjection * w;
        if (material == 8 && uv.y >= 1.0) {
            // A building's box: fold it away where its model is drawn instead.
            vec3 anchor = position - vec3((fract(uv.x) - 0.5) * 4000.0, color.a, (fract(uv.y) - 0.5) * 4000.0);
            vec4 a = model * vec4(anchor, 1.0);
            float hide = uv.y < 2.0 ? W_CITY.x : W_CITY.z;
            if (length(a.xyz - u_eye) < hide) {
                clip = vec4(0.0, 0.0, 0.0, 1.0);
                folded = true;
            }
        }
        // Logarithmic depth. Per vertex by default (the GPU's early depth test stays on); with
        // fragmentDepth it is rewritten exactly per fragment, as the original did. Roads are pulled
        // toward the camera so a coarser terrain chunk under them doesn't swallow them.
        ${o.caster ? "" : `float depth_w = material == 10 ? max(clip.w * 0.996 - 0.05, 0.01) : clip.w;
        clip.z = (2.0 * log_depth(depth_w) - 1.0) * clip.w;`}
        world_pos = w.xyz;
        out_normal = (model * vec4(nrm, 0.0)).xyz;
    }
${o.caster ? /* glsl */ `
    // Ground, water, ice, glass, glowing things, fire, smoke, the sky and roads cast nothing.
    bool at_eye = length(model[3].xyz - u_eye) < 0.75;
    if (material <= 2 || material == 4 || material == 5 || material == 7 || material == 9 || material == 10 || material == ${MAT_FIRE} || material == ${MAT_SMOKE} || folded || at_eye) {
        gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
    } else {
        gl_Position = viewProjection * vec4(world_pos, 1.0);
    }
` : /* glsl */ `
    gl_Position = clip;
    v_world_pos = world_pos;
    v_normal = out_normal;
    v_uv = uv;
    v_color = color;
    v_tex_pos = position + texOrigin.xyz;
${vary.localNormal ? "    v_local_normal = normal;" : ""}
${vary.tint ? "    v_tint = tint;" : ""}
${vary.texOrigin ? "    v_tex_origin = texOrigin;" : ""}
${vary.model ? "    v_m0 = model[0].xyz;\n    v_m1 = model[1].xyz;\n    v_m2 = model[2].xyz;" : ""}
${vary.people ? "    v_skin = skin;\n    v_hair = hair;" : ""}
`}
}
`;
}

// --- The fragment stage --------------------------------------------------------------------------

const NOISE_GLSL = /* glsl */ `
float hash3(vec3 p) {
    vec3 q = fract(p * vec3(0.1031, 0.1030, 0.0973));
    vec3 r = q + dot(q, q.yxz + 33.33);
    return fract((r.x + r.y) * r.z);
}

vec3 aces(vec3 x) {
    return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), vec3(0.0), vec3(1.0));
}

// Integer hash of a lattice point, in [0, 1].
float lattice(uvec3 q) {
    uvec3 v = q * 1664525u + 1013904223u;
    v.x = v.x + v.y * v.z; v.y = v.y + v.z * v.x; v.z = v.z + v.x * v.y;
    v = v ^ (v >> uvec3(16u));
    v.x = v.x + v.y * v.z; v.y = v.y + v.z * v.x; v.z = v.z + v.x * v.y;
    return float(v.x & 0xffffffu) / 16777215.0;
}

// Value noise in [-1, 1] with its analytic gradient (.yzw, per lattice unit), repeating every
// \`period\` lattice cells (an integer): the lattice is wrapped before hashing.
vec4 vnoise(vec3 x, float period) {
    vec3 i = floor(x);
    vec3 f = x - i;
    vec3 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
    vec3 du = 30.0 * f * f * (f * (f - 2.0) + 1.0);
    vec3 w0 = i - period * floor(i / period);
    uint p = uint(period);
    uvec3 a0 = uvec3(w0);
    uvec3 a1 = (a0 + uvec3(1u)) % uvec3(p);
    float a = lattice(uvec3(a0.x, a0.y, a0.z));
    float b = lattice(uvec3(a1.x, a0.y, a0.z));
    float c = lattice(uvec3(a0.x, a1.y, a0.z));
    float d = lattice(uvec3(a1.x, a1.y, a0.z));
    float e = lattice(uvec3(a0.x, a0.y, a1.z));
    float f1 = lattice(uvec3(a1.x, a0.y, a1.z));
    float g = lattice(uvec3(a0.x, a1.y, a1.z));
    float h = lattice(uvec3(a1.x, a1.y, a1.z));
    float k1 = b - a;
    float k2 = c - a;
    float k3 = e - a;
    float k4 = a - b - c + d;
    float k5 = a - c - e + g;
    float k6 = a - b - e + f1;
    float k7 = -a + b + c - d + e - f1 - g + h;
    float v = a + k1 * u.x + k2 * u.y + k3 * u.z + k4 * u.x * u.y + k5 * u.y * u.z + k6 * u.z * u.x + k7 * u.x * u.y * u.z;
    vec3 grad = du * vec3(
        k1 + k4 * u.y + k6 * u.z + k7 * u.y * u.z,
        k2 + k5 * u.z + k4 * u.x + k7 * u.z * u.x,
        k3 + k6 * u.x + k5 * u.y + k7 * u.x * u.y);
    return vec4(v * 2.0 - 1.0, grad * 2.0);
}

// How much of an octave of wavelength 1/freq survives a pixel \`footprint\` meters wide.
float octave_fade(float freq, float footprint) {
    return 1.0 - smoothstep(0.3, 0.6, footprint * freq);
}

// Fractal noise in meters-space: (value, gradient per meter). Octaves finer than a pixel are faded out.
vec4 fbm(vec3 p, float freq0, int octaves, float gain, float footprint) {
    vec4 sum = vec4(0.0);
    if (DIAG_OFF(16)) { return sum; }
    float amp = 0.5;
    float freq = freq0;
    for (int o = 0; o < octaves + LOOP0; o++) {
        float fade = octave_fade(freq, footprint);
        if (fade <= 0.0) { break; }
        vec4 n = vnoise(p * freq + vec3(float(o) * 17.0, float(o) * 31.0, float(o) * 7.0), TEX_PERIOD * freq);
        sum = sum + vec4(n.x, n.yzw * freq) * amp * fade;
        amp = amp * gain;
        freq = freq * 2.0;
    }
    return sum;
}

// Tilts normal n by the gradient of a height field (meters per meter).
vec3 bump(vec3 n, vec3 grad) {
    return normalize(n - (grad - dot(grad, n) * n));
}
`;

/** The lattice hash and value noise, for the cloud bake (al_clouds.ts). */
export const NOISE_FOR_BAKE = NOISE_GLSL;

const SURFACES_GLSL = /* glsl */ `
struct Surface { vec3 albedo; vec3 n; float spec; float shin; float ao; };
struct Facade { vec3 albedo; vec3 grad; float spec; float shin; float ao; };

// Courses of blocks: x = joint amount (0 block .. 1 joint), y = the block's random tone, z = how far up its course.
vec3 courses(vec2 uv, vec2 size, float joint, float stagger) {
    float row = floor(uv.y / size.y);
    float x = uv.x / size.x + stagger * (row - 2.0 * floor(row * 0.5));
    float col = floor(x);
    float fu = fract(x) * size.x;
    float fv = fract(uv.y / size.y) * size.y;
    float inside = smoothstep(0.0, joint, fu) * smoothstep(0.0, joint, size.x - fu) * smoothstep(0.0, joint, fv) * smoothstep(0.0, joint, size.y - fv);
    return vec3(1.0 - inside, hash3(vec3(col, row, 3.7)), fv / size.y);
}

// (along, up) on a wall; on a roof (across the slope, up the slope); on a floor its plan.
vec2 surface_uv(vec3 p, vec3 ln) {
    vec2 flat_ = vec2(ln.x, ln.z);
    float fl = length(flat_);
    if (abs(ln.y) < 0.5) {
        vec2 along = vec2(-flat_.y, flat_.x) / max(fl, 1.0e-4);
        return vec2(dot(p.xz, along), p.y);
    }
    if (fl < 0.08) { return p.xz; }
    vec2 across = vec2(-flat_.y, flat_.x) / fl;
    return vec2(dot(p.xz, across), p.y / fl);
}

const int FINISH_COUNT = ${FINISH_BASE.length};
const int FINISH_CATEGORY[${FINISH_BASE.length}] = int[${FINISH_BASE.length}](${FINISH_BASE.join(", ")});

Facade city_surface(int finish_kind, vec3 base, vec3 p, vec3 ln, float fp) {
    int kind = FINISH_CATEGORY[clamp(finish_kind, 0, FINISH_COUNT - 1)];
    Facade f;
    f.albedo = base;
    f.grad = vec3(0.0);
    f.spec = 0.12;
    f.shin = 24.0;
    f.ao = 1.0;
    vec2 uv = surface_uv(p, ln);
    bool wall = abs(ln.y) < 0.5;
    vec4 blotch = fbm(p, 1.0 / 4.0, 3, 0.5, fp);
    vec4 grain = fbm(p, 4.0, 3, 0.5, fp);
    if (kind == 1) {
        vec3 c = courses(uv, vec2(0.225, 0.075), 0.011, 0.5);
        float vis = octave_fade(1.0 / 0.075, fp);
        vec3 brick = base * (0.8 + 0.4 * c.y) * mix(vec3(1.0), vec3(1.08, 0.95, 0.88), hash3(vec3(floor(uv / 0.15), 1.0)));
        vec3 mortar = mix(vec3(0.58, 0.56, 0.52), base, 0.2);
        f.albedo = mix(mix(base, mortar, 0.2), mix(brick, mortar, c.x), vis);
        f.ao = 1.0 - 0.25 * c.x * vis;
        f.grad = grain.yzw * 0.004;
        f.spec = 0.06; f.shin = 14.0;
    } else if (kind == 2) {
        f.albedo = base * (0.93 + 0.1 * blotch.x + 0.03 * grain.x);
        f.grad = grain.yzw * 0.006 + blotch.yzw * 0.02;
        f.spec = 0.08; f.shin = 16.0;
    } else if (kind == 3) {
        vec3 c = courses(uv, vec2(2.4, 1.2), 0.012, 0.0);
        float vis = octave_fade(1.0 / 1.2, fp);
        vec2 tie = vec2(fract(uv.x / 0.6) - 0.5, fract(uv.y / 0.6) - 0.5);
        float hole = (1.0 - smoothstep(0.008, 0.014, length(tie * 0.6))) * octave_fade(16.0, fp);
        f.albedo = base * (0.86 + 0.16 * blotch.x + 0.06 * grain.x) * (1.0 - 0.18 * c.x * vis) * (1.0 - 0.3 * hole) * (0.97 + 0.06 * c.y * vis);
        f.grad = grain.yzw * 0.008;
        f.ao = 1.0 - 0.2 * c.x * vis;
    } else if (kind == 4 || kind == 8) {
        vec3 c = courses(uv, vec2(0.62, 0.34), 0.012, 0.5);
        float vis = octave_fade(1.0 / 0.34, fp);
        f.albedo = base * mix(vec3(0.96), (0.8 + 0.35 * c.y) * vec3(1.0) * (1.0 - 0.3 * c.x), vis) * (0.92 + 0.1 * grain.x);
        f.grad = grain.yzw * 0.01;
        f.ao = 1.0 - 0.3 * c.x * vis;
        f.spec = 0.1;
    } else if (kind == 5) {
        vec3 c = courses(uv, vec2(0.3, 0.24), 0.008, 0.5);
        float vis = octave_fade(1.0 / 0.24, fp);
        float lap = 0.72 + 0.28 * smoothstep(0.0, 0.5, c.z);
        f.albedo = base * mix(vec3(0.88), (0.82 + 0.3 * c.y) * lap * (1.0 - 0.35 * c.x) * vec3(1.0), vis) * (0.94 + 0.08 * blotch.x);
        f.ao = mix(0.9, lap, vis);
        f.spec = 0.18; f.shin = 30.0;
    } else if (kind == 6) {
        f.albedo = base * (0.9 + 0.12 * blotch.x);
        f.spec = 0.55 - 0.25 * smoothstep(0.0, 0.6, blotch.x); f.shin = 70.0;
    } else if (kind == 7) {
        vec3 c = courses(uv, vec2(2.7, 0.16), 0.006, 0.37);
        float vis = octave_fade(1.0 / 0.16, fp);
        vec4 g = fbm(vec3(uv.x * 0.15, uv.y * 6.0, c.y * 31.0), 4.0, 3, 0.5, fp);
        f.albedo = base * mix(vec3(0.95), (0.8 + 0.35 * c.y) * (0.9 + 0.15 * g.x) * (1.0 - 0.4 * c.x) * vec3(1.0), vis);
        f.ao = 1.0 - 0.3 * c.x * vis;
        f.spec = 0.1; f.shin = 20.0;
    } else {
        f.albedo = base * (0.95 + 0.06 * blotch.x);
    }
    if (wall && kind != 6) {
        float h = p.y;
        float splash = 1.0 - 0.28 * (1.0 - smoothstep(0.0, 1.1, h)) * (0.7 + 0.3 * blotch.x);
        float streak = vnoise(vec3(uv.x * 2.2, h * 0.09, 5.0), TEX_PERIOD).x;
        float rain = 1.0 - 0.12 * smoothstep(0.1, 0.8, streak) * smoothstep(0.5, 3.0, h);
        f.albedo = f.albedo * splash * rain;
        f.ao = f.ao * (0.82 + 0.18 * smoothstep(0.0, 0.6, h));
    }
    return f;
}

// Bare rock: lumpy grain, fracture lines and faint strata along the planet's up direction.
Surface rock_surface(vec3 base, vec3 t, vec3 n, vec3 up, float fp) {
    Surface s;
    vec4 lumps = fbm(t, 1.0 / 16.0, 9, 0.52, fp);
    vec4 cn = vnoise(t * 0.5 + vec3(3.0, 11.0, 5.0), TEX_PERIOD * 0.5);
    float cfade = octave_fade(2.0, fp);
    float crack = (1.0 - smoothstep(0.0, 0.07, abs(cn.x))) * cfade;
    vec4 fine = fbm(t, 4.0, 5, 0.6, fp);
    float strata = sin(dot(t, up) * 3.7 + lumps.x * 4.0) * octave_fade(1.0, fp);
    vec3 grad = lumps.yzw * 0.55 + fine.yzw * 0.05;
    grad = grad + sign(cn.x) * cn.yzw * 0.5 * crack * 0.12;
    s.n = bump(n, grad);
    float tone = 0.78 + 0.45 * lumps.x + 0.18 * fine.x + 0.06 * strata;
    vec3 mineral = mix(vec3(1.0), vec3(1.08, 0.97, 0.88), smoothstep(-0.2, 0.5, fbm(t, 1.0 / 64.0, 3, 0.5, fp).x));
    s.albedo = base * tone * mineral * (1.0 - 0.55 * crack);
    s.ao = 1.0 - 0.5 * crack;
    s.spec = 0.12;
    s.shin = 24.0;
    return s;
}

// Soil and vegetation (the procedural ground; with material maps, ground_surface_maps instead).
Surface ground_surface(vec3 base, vec3 t, vec3 n, float fp) {
    Surface s;
    float green = clamp((base.g - max(base.r, base.b)) * 6.0, 0.0, 1.0);
    vec4 clumps = fbm(t, 1.0 / 8.0, 4, 0.5, fp);
    vec4 blades = fbm(t, 8.0, 4, 0.7, fp);
    float dirt = smoothstep(0.05, 0.35, fbm(t + vec3(19.0), 1.0 / 4.0, 3, 0.5, fp).x - 0.4 * green);
    vec4 pebble_n = vnoise(t * 16.0 + vec3(7.0), TEX_PERIOD * 16.0);
    float pebbles = smoothstep(0.55, 0.75, pebble_n.x) * octave_fade(32.0, fp) * (0.25 + 0.75 * dirt);
    vec3 soil = base * vec3(1.05, 0.86, 0.66) * 0.8;
    vec3 albedo = base * (0.82 + 0.35 * clumps.x) * (0.85 + 0.3 * blades.x * green);
    float sward = fbm(t + vec3(41.0, 7.0, 23.0), 1.0 / 32.0, 3, 0.5, fp).x;
    albedo = mix(albedo, albedo * vec3(1.16, 1.04, 0.6), smoothstep(0.0, 0.45, sward) * green * 0.5);
    albedo = mix(albedo, albedo * vec3(0.74, 0.92, 0.78), smoothstep(0.0, -0.4, sward) * green * 0.55);
    albedo = mix(albedo, soil * (0.9 + 0.2 * blades.x), dirt * 0.7);
    vec3 stone = mix(soil, vec3(0.1, 0.095, 0.09), 0.5) * (0.8 + 0.4 * pebble_n.x);
    albedo = mix(albedo, stone, pebbles * 0.7);
    s.albedo = albedo;
    s.n = bump(n, clumps.yzw * 0.25 + blades.yzw * 0.012 * (1.0 - dirt) + pebble_n.yzw * 16.0 * 0.004 * pebbles);
    s.ao = 0.85 + 0.15 * blades.x;
    s.spec = 0.05;
    s.shin = 12.0;
    return s;
}

// Snow: soft wind-blown drifts and a sparkle of crystals.
Surface snow_surface(vec3 base, vec3 t, vec3 n, float fp) {
    Surface s;
    vec4 drifts = fbm(t, 1.0 / 8.0, 5, 0.45, fp);
    s.n = bump(n, drifts.yzw * 0.2);
    s.albedo = base * (0.94 + 0.08 * drifts.x);
    s.ao = 1.0;
    vec3 cell = floor(t * 16.0);
    float glint = step(0.994, hash3(cell)) * octave_fade(16.0, fp);
    s.spec = 0.25 + glint * 30.0;
    s.shin = 60.0 + glint * 400.0;
    return s;
}

Surface blend_surface(Surface a, Surface b, float t) {
    Surface s;
    s.albedo = mix(a.albedo, b.albedo, t);
    s.n = normalize(mix(a.n, b.n, t));
    s.spec = mix(a.spec, b.spec, t);
    s.shin = mix(a.shin, b.shin, t);
    s.ao = mix(a.ao, b.ao, t);
    return s;
}
`;

const ATMOSPHERE_GLSL = /* glsl */ `
// Ray (origin o, unit dir d) against a sphere: (t_enter, t_exit), or t_exit < 0 when missed.
vec2 sphere_hit(vec3 o, vec3 d, vec3 c, float r) {
    vec3 oc = o - c;
    float b = dot(oc, d);
    float l = length(oc);
    float h = b * b - (l - r) * (l + r);
    if (h < 0.0) { return vec2(1.0, -1.0); }
    float s = sqrt(h);
    return vec2(-b - s, -b + s);
}

vec3 linear(vec3 c) {
    return pow(max(c, vec3(0.0)), vec3(2.2));
}

vec3 atmo_color(int i) {
    return linear(W_ATMOSPHERE(i).rgb);
}

float daylight(vec3 p, int i) {
    vec3 up = normalize(p - W_PLANET(i).xyz);
    return smoothstep(-0.22, 0.28, dot(up, W_SUN_DIR.xyz));
}

struct Haze { vec3 light; float transmit; };

Haze atmosphere_segment(vec3 o, vec3 d, int i, float t_max, float k, float extinction) {
    Haze outp;
    outp.light = vec3(0.0);
    outp.transmit = 1.0;
    vec3 c = W_PLANET(i).xyz;
    float r = W_PLANET(i).w;
    float h = W_ATMOSPHERE(i).w;
    vec2 hit = sphere_hit(o, d, c, r + h);
    if (hit.y < 0.0) { return outp; }
    float t0 = max(hit.x, 0.0);
    float t1 = min(hit.y, t_max);
    if (t1 <= t0) { return outp; }
    float len = t1 - t0;
    vec3 mid = o + d * ((t0 + t1) * 0.5);
    float depth = clamp(1.0 - (length(mid - c) - r) / h, 0.0, 1.0);
    float optical = len / h * (0.35 + 0.9 * depth * depth);
    float day = daylight(mid, i);
    float sun_d = max(dot(d, W_SUN_DIR.xyz), 0.0);
    float forward = 1.0 + 1.6 * pow(sun_d, 6.0);
    float amount = 1.0 - exp(-optical * k);
    vec3 tintc = mix(atmo_color(i), vec3(1.0, 0.97, 0.92), clamp(optical * 0.05, 0.0, 0.3));
    outp.light = tintc * amount * day * forward * 1.15;
    outp.transmit = mix(1.0, exp(-optical * k * extinction), day);
    return outp;
}

vec3 stars(vec3 d) {
    vec3 col = vec3(0.0);
    for (int layer = 0; layer < 2 + LOOP0; layer++) {
        float sc = layer == 1 ? 120.0 : 260.0;
        vec3 q = d * sc;
        vec3 cell = floor(q);
        float h = hash3(cell + float(layer) * 17.0);
        if (h > 0.985) {
            vec3 center = cell + vec3(hash3(cell + 3.1), hash3(cell + 7.7), hash3(cell + 1.3));
            float dist = length(q - center);
            float b = smoothstep(0.32, 0.0, dist) * (h - 0.985) * 66.0;
            float warm = hash3(cell + 9.9);
            col = col + b * mix(vec3(0.75, 0.82, 1.0), vec3(1.0, 0.85, 0.7), warm);
        }
    }
    float band = exp(-pow(dot(d, normalize(vec3(0.2, 0.9, -0.35))) * 3.2, 2.0));
    col = col + vec3(0.05, 0.045, 0.07) * band;
    return col;
}

int planet_of(vec3 p) {
    int best = 0;
    float best_d = 1e30;
    int count = int(W_PARAMS.z);
    for (int i = 0; i < ${MAX_PLANETS} + LOOP0; i++) {
        if (i >= count) { break; }
        float dd = length(p - W_PLANET(i).xyz) - W_PLANET(i).w;
        if (dd < best_d) { best_d = dd; best = i; }
    }
    return best;
}

vec4 finish_color(vec3 c) {
    return vec4(pow(aces(c * W_PARAMS.x), vec3(1.0 / 2.2)), 1.0);
}
`;

// One static, periodic 3D cloud-noise field stored as padded slices in a filterable 2D atlas
// (al_clouds.ts); the procedural reference is kept for when the atlas is off.
const CLOUDS_GLSL = /* glsl */ `
const float CLOUD_PERIOD = ${f(CLOUD_PERIOD)};
uniform sampler2D cloud_atlas;

float cloud_density_procedural(vec3 p, int octaves) {
    float cover = W_CLOUD.w;
    if (cover <= 0.0) { return 0.0; }
    vec3 q = p + W_CLOUD.xyz;
    float sum = 0.0;
    float amp = 0.5;
    float freq = 1.0 / 4096.0;
    for (int o = 0; o < octaves + LOOP0; o++) {
        sum = sum + vnoise(q * freq + vec3(float(o) * 5.0, float(o) * 13.0, float(o) * 3.0), CLOUD_PERIOD * freq).x * amp;
        amp = amp * 0.5;
        freq = freq * 2.0;
    }
    return smoothstep(1.0 - cover * 1.15, 1.25 - cover * 0.9, sum + 0.5);
}

vec4 cloud_slice(vec2 p, float z) {
    vec2 tile = vec2(z - floor(z / ${f(CLOUD_CACHE_COLUMNS)}) * ${f(CLOUD_CACHE_COLUMNS)}, floor(z / ${f(CLOUD_CACHE_COLUMNS)}));
    vec2 uv = (tile * ${f(CLOUD_CACHE_TILE)} + p + vec2(1.5)) / vec2(${f(CLOUD_CACHE_WIDTH)}, ${f(CLOUD_CACHE_HEIGHT)});
    return textureLod(cloud_atlas, uv, 0.0);
}

float cloud_density(vec3 p, int octaves) {
    if (W_CLOUD.w <= 0.0) { return 0.0; }
    if (W_CITY.w < 0.5) { return cloud_density_procedural(p, octaves); }
    vec3 q = fract((p + W_CLOUD.xyz) / CLOUD_PERIOD) * ${f(CLOUD_CACHE_SIZE)};
    float z = floor(q.z);
    vec4 planes = cloud_slice(q.xy, z);
    vec2 raw = mix(planes.rg, planes.ba, fract(q.z));
    float sum = octaves >= 4 ? raw.y : raw.x;
    return smoothstep(1.0 - W_CLOUD.w * 1.15, 1.25 - W_CLOUD.w * 0.9, sum + 0.5);
}

float cloud_hit(vec3 o, vec3 d, int i) {
    vec2 hit = sphere_hit(o, d, W_PLANET(i).xyz, W_PLANET(i).w + W_WIND.w);
    if (hit.y < 0.0) { return -1.0; }
    return hit.x > 0.0 ? hit.x : hit.y;
}

float cloud_shadow(vec3 p, vec3 sun, int i) {
    if (W_CLOUD.w <= 0.0 || i != 0 || DIAG_OFF(8)) { return 1.0; }
    float t = cloud_hit(p, sun, i);
    if (t < 0.0) { return 1.0; }
    return 1.0 - 0.62 * cloud_density(p + sun * t, 3);
}

vec3 sky_clouds(vec3 col, vec3 cam, vec3 d, vec3 sun) {
    if (W_CLOUD.w <= 0.0) { return col; }
    vec3 c = W_PLANET(0).xyz;
    vec3 up = normalize(cam - c);
    float alt = length(cam - c) - W_PLANET(0).w;
    if (alt > W_WIND.w) { return col; }
    float t = cloud_hit(cam, d, 0);
    if (t < 0.0) { return col; }
    vec3 p = cam + d * t;
    float dens = cloud_density(p, 6);
    if (dens <= 0.001) { return col; }
    float toward = cloud_density(p + sun * 350.0, 4);
    float day = daylight(p, 0);
    float sun_h = smoothstep(-0.1, 0.35, dot(up, sun));
    vec3 warm = mix(vec3(1.0, 0.62, 0.38), vec3(1.0), sun_h);
    vec3 lit = W_SUN_COLOR.rgb * warm * (1.25 - 0.85 * toward) * day;
    vec3 shade = linear(W_ATMOSPHERE(0).rgb) * 0.45 * day + vec3(0.03, 0.035, 0.045);
    vec3 silver = pow(max(dot(d, sun), 0.0), 8.0) * (1.0 - dens) * 1.5 * W_SUN_COLOR.rgb * day;
    vec3 cloud = mix(shade, lit, 0.55 + 0.45 * (1.0 - dens)) + silver;
    float fade = smoothstep(0.0, 0.12, dot(d, up)) * exp(-t / 60000.0);
    return mix(col, cloud, clamp(dens * 1.3, 0.0, 1.0) * fade);
}
`;

// Cascaded sun shadows (al_shader.ts SHADOW_WGSL): PCF over the cascade a point falls in, blended
// into the next one near its edge. Light matrices map render space to clip with z in 0..1.
const SHADOW_GLSL = /* glsl */ `
uniform mat4 u_shadowMats[4];
uniform vec4 u_shadowTexel;
uniform vec4 u_shadowParams;  // x = cascades, y = map size, z = strength, w = depth per meter
uniform highp sampler2DArrayShadow shadow_maps;

vec2 cascade_lookup(vec3 p, vec3 n, int k) {
    // (lit share, how far inside the cascade the point is in uv units; negative when outside)
    float texel = u_shadowTexel[k];
    vec3 q = p + n * texel * 1.5;
    vec4 c = u_shadowMats[k] * vec4(q, 1.0);
    vec2 uv = vec2(c.x * 0.5 + 0.5, c.y * 0.5 + 0.5);
    float edge = min(min(uv.x, uv.y), min(1.0 - uv.x, 1.0 - uv.y));
    if (edge <= 0.0 || c.z >= 1.0) { return vec2(1.0, -1.0); }
    float depth = c.z - texel * u_shadowParams.w;
    float stp = 1.0 / u_shadowParams.y;
    float sum = 0.0;
    for (int y = -1; y <= 1 + LOOP0; y++) {
        for (int x = -1; x <= 1 + LOOP0; x++) {
            sum += texture(shadow_maps, vec4(uv + vec2(float(x), float(y)) * stp * 1.2, float(k), depth));
        }
    }
    return vec2(sum / 9.0, edge);
}

float cast_shadow(vec3 p, vec3 n) {
    int count = int(u_shadowParams.x);
    for (int k = 0; k < 4 + LOOP0; k++) {
        if (k >= count) { break; }
        vec2 a = cascade_lookup(p, n, k);
        if (a.y < 0.0) { continue; }
        float blend = smoothstep(0.0, 0.1, a.y);
        if (blend >= 1.0) { return a.x; }
        float next = 1.0;
        if (k + 1 < count) {
            vec2 b = cascade_lookup(p, n, k + 1);
            if (b.y >= 0.0) { next = b.x; }
        }
        return mix(next, a.x, blend);
    }
    return 1.0;
}

float sun_visibility(vec3 p, vec3 n, float view_w, int i) {
    float clouds = cloud_shadow(p, normalize(W_SUN_DIR.xyz), i);
    if (u_shadowParams.x < 0.5 || view_w < 0.0 || DIAG_OFF(2)) { return clouds; }
    return clouds * mix(1.0, cast_shadow(p, normalize(n)), u_shadowParams.z);
}
`;

function materialsGlsl(): string {
    const t = materialTable(MATERIAL_SETS);
    const n = t.layer.length;
    return /* glsl */ `
uniform sampler2DArray mat_basecolor;
uniform sampler2DArray mat_normal;
uniform sampler2DArray mat_roughness;
uniform sampler2DArray mat_height;
uniform sampler2DArray mat_metallic;

const int SURFACE_LAYER[${n}] = int[${n}](${t.layer.join(", ")});
const float SURFACE_TILE[${n}] = float[${n}](${t.tile.map(f).join(", ")});
const float SURFACE_DEPTH[${n}] = float[${n}](${t.depth.map(f).join(", ")});

struct Textured { vec3 albedo; vec3 n_local; float rough; float height; float metallic; };

int surface_layer(int kind) {
    if (kind < 0 || kind >= ${n}) { return -1; }
    return SURFACE_LAYER[kind];
}

vec4 mat_sample(sampler2DArray s, vec2 uv, int layer, vec2 gx, vec2 gy) {
    return textureGrad(s, vec3(uv, float(layer)), gx, gy);
}

Textured textured_surface(int kind, int layer, vec2 uv0, vec2 dx, vec2 dy, vec3 ln, vec3 v_local, float dist) {
    Textured outp;
    float tile = SURFACE_TILE[kind];
    vec2 flip = vec2(1.0, -1.0) / tile;
    vec2 uv = uv0 * flip;
    vec2 gx = dx * flip;
    vec2 gy = dy * flip;
    vec2 flat_ = vec2(ln.x, ln.z);
    float fl = length(flat_);
    vec3 t = vec3(1.0, 0.0, 0.0);
    if (fl >= 0.08) { t = normalize(vec3(-flat_.y, 0.0, flat_.x)); }
    vec3 b = cross(t, ln);
    float near_ = 1.0 - smoothstep(${f(PARALLAX_NEAR)}, ${f(PARALLAX_FAR)}, dist);
    vec3 vt = vec3(dot(v_local, t), dot(v_local, b), dot(v_local, ln));
    if (near_ > 0.0 && vt.z > 0.08 && SURFACE_DEPTH[kind] > 0.0) {
        vec2 shift = vec2(vt.x, -vt.y) / vt.z * (SURFACE_DEPTH[kind] / tile) * near_;
        float steps = mix(24.0, 8.0, vt.z);
        float stp = 1.0 / steps;
        float depth = 0.0;
        vec2 cur = uv;
        float surface = 1.0 - mat_sample(mat_height, cur, layer, gx, gy).r;
        vec2 prev_cur = cur;
        float prev_gap = surface;
        for (int i = 0; i < 32 + LOOP0; i++) {
            if (depth >= surface || float(i) >= steps) { break; }
            prev_cur = cur;
            prev_gap = surface - depth;
            cur = cur - shift * stp;
            depth = depth + stp;
            surface = 1.0 - mat_sample(mat_height, cur, layer, gx, gy).r;
        }
        float after = surface - depth;
        float w = clamp(after / (after - prev_gap + 1.0e-5), 0.0, 1.0);
        uv = mix(cur, prev_cur, w);
    }
    outp.albedo = mat_sample(mat_basecolor, uv, layer, gx, gy).rgb;
    vec3 nt = mat_sample(mat_normal, uv, layer, gx, gy).xyz * 2.0 - 1.0;
    outp.n_local = normalize(t * nt.x + b * nt.y + ln * max(nt.z, 0.05));
    outp.rough = clamp(mat_sample(mat_roughness, uv, layer, gx, gy).r, 0.04, 1.0);
    outp.height = mat_sample(mat_height, uv, layer, gx, gy).r;
    outp.metallic = clamp(mat_sample(mat_metallic, uv, layer, gx, gy).r, 0.0, 1.0);
    return outp;
}

// Terrain: triplanar projection keeps neighbouring chunks continuous. A projection weighing under
// 1% is skipped (and the rest renormalized): on level ground that is two of the three, a third of
// the texture reads, with no visible difference.
Textured ground_maps(int kind, vec3 p, vec3 ln, vec3 dx, vec3 dy) {
    int layer = surface_layer(kind);
    float tile = SURFACE_TILE[kind];
    vec3 q = p / tile;
    vec3 gx = dx / tile;
    vec3 gy = dy / tile;
    vec3 w0 = pow(abs(ln), vec3(4.0));
    vec3 w = w0 / max(w0.x + w0.y + w0.z, 1.0e-5);
    w = w * step(vec3(0.01), w);
    w = w / max(w.x + w.y + w.z, 1.0e-5);
    Textured outp;
    outp.albedo = vec3(0.0);
    vec3 detail = vec3(0.0);
    float rough = 0.0;
    float height = 0.0;
    if (w.x > 0.0) {
        vec2 uv = vec2(q.z, -q.y), ddx = vec2(gx.z, -gx.y), ddy = vec2(gy.z, -gy.y);
        outp.albedo += mat_sample(mat_basecolor, uv, layer, ddx, ddy).rgb * w.x;
        vec3 nx = mat_sample(mat_normal, uv, layer, ddx, ddy).xyz * 2.0 - 1.0;
        detail += vec3(0.0, nx.y, nx.x) * w.x;
        rough += mat_sample(mat_roughness, uv, layer, ddx, ddy).r * w.x;
        height += mat_sample(mat_height, uv, layer, ddx, ddy).r * w.x;
    }
    if (w.y > 0.0) {
        vec2 uv = vec2(q.x, -q.z), ddx = vec2(gx.x, -gx.z), ddy = vec2(gy.x, -gy.z);
        outp.albedo += mat_sample(mat_basecolor, uv, layer, ddx, ddy).rgb * w.y;
        vec3 ny = mat_sample(mat_normal, uv, layer, ddx, ddy).xyz * 2.0 - 1.0;
        detail += vec3(ny.x, 0.0, ny.y) * w.y;
        rough += mat_sample(mat_roughness, uv, layer, ddx, ddy).r * w.y;
        height += mat_sample(mat_height, uv, layer, ddx, ddy).r * w.y;
    }
    if (w.z > 0.0) {
        vec2 uv = vec2(q.x, -q.y), ddx = vec2(gx.x, -gx.y), ddy = vec2(gy.x, -gy.y);
        outp.albedo += mat_sample(mat_basecolor, uv, layer, ddx, ddy).rgb * w.z;
        vec3 nz = mat_sample(mat_normal, uv, layer, ddx, ddy).xyz * 2.0 - 1.0;
        detail += vec3(nz.x, nz.y, 0.0) * w.z;
        rough += mat_sample(mat_roughness, uv, layer, ddx, ddy).r * w.z;
        height += mat_sample(mat_height, uv, layer, ddx, ddy).r * w.z;
    }
    // Add tangent detail to the geometric normal; a neutral normal leaves it unchanged.
    outp.n_local = normalize(ln + detail - ln * dot(detail, ln));
    outp.rough = clamp(rough, 0.04, 1.0);
    outp.height = height;
    outp.metallic = 0.0;
    return outp;
}

Surface ground_surface_maps(vec3 base, vec3 p, vec3 n, vec3 up, float fp, vec3 dx, vec3 dy) {
    float green = clamp((base.g - max(base.r, base.b)) * 6.0, 0.0, 1.0);
    bool meadow = vnoise(p / 32.0, TEX_PERIOD / 32.0).x > 0.0;
    int grass_kind = meadow ? ${GROUND.meadow} : ${GROUND.grass};
    Textured grass = ground_maps(grass_kind, p, n, dx, dy);
    Textured dirt = ground_maps(${GROUND.soil}, p, n, dx, dy);
    float snow_w = smoothstep(0.72, 0.86, min(base.r, min(base.g, base.b)));
    vec3 albedo = mix(dirt.albedo, grass.albedo, green);
    vec3 norm = normalize(mix(dirt.n_local, grass.n_local, green));
    float rough = mix(dirt.rough, grass.rough, green);
    float height = mix(dirt.height, grass.height, green);
    if (snow_w > 0.0) {
        Textured snow = ground_maps(${GROUND.snow}, p, n, dx, dy);
        albedo = mix(albedo, snow.albedo, snow_w);
        norm = normalize(mix(norm, snow.n_local, snow_w));
        rough = mix(rough, snow.rough, snow_w);
        height = mix(height, snow.height, snow_w);
    }
    Surface outp;
    outp.albedo = albedo; outp.n = norm;
    outp.ao = mix(0.75, 1.0, height);
    float a = rough * rough;
    outp.shin = clamp(2.0 / (a * a) - 2.0, 2.0, 2048.0);
    outp.spec = 0.04 * (outp.shin + 8.0) / 8.0;
    return outp;
}
`;
}

// The territory overlay (al_territory.ts): head, then TERRITORY_MAX spots and TERRITORY_MAX colors.
const TERRITORY_GLSL = /* glsl */ `
uniform vec4 u_territory[${1 + 2 * TERRITORY_MAX}];

vec3 territory_overlay(vec3 col, vec3 p) {
    float k = u_territory[0].x;
    if (k <= 0.001) { return col; }
    int n = int(u_territory[0].y);
    float sd = 1e30; float sd2 = 1e30; int si = -1; float rim = 1e30;
    float hd = 1e30; float hd2 = 1e30; int hi = -1;
    for (int i = 0; i < ${TERRITORY_MAX} + LOOP0; i++) {
        if (i >= n) { break; }
        vec4 s = u_territory[1 + i];
        float d = distance(p, s.xyz);
        if (s.w > 0.0) {
            rim = min(rim, abs(s.w - d));
            if (d <= s.w) {
                if (d < sd) { sd2 = sd; sd = d; si = i; } else if (d < sd2) { sd2 = d; }
            }
        } else {
            if (d < hd) { hd2 = hd; hd = d; hi = i; } else if (d < hd2) { hd2 = d; }
        }
    }
    vec4 c = vec4(0.0);
    float a = 0.0;
    float edge = rim;
    if (si >= 0) {
        c = u_territory[${1 + TERRITORY_MAX} + si];
        a = 0.3;
        edge = min(edge, (sd2 - sd) * 0.5);
    } else if (hi >= 0) {
        c = u_territory[${1 + TERRITORY_MAX} + hi];
        a = 0.16;
        edge = min(edge, (hd2 - hd) * 0.5);
    } else {
        return col;
    }
    vec3 tintc = pow(c.rgb, vec3(2.2));
    float lum = dot(col, vec3(0.3, 0.5, 0.2));
    float wash = a * (1.0 + 0.3 * c.a) * k;
    vec3 outc = mix(col, tintc * (lum * 1.7 + 0.03), wash);
    float w = u_territory[0].z;
    float line = 1.0 - smoothstep(w * 0.35, w, edge);
    outc = mix(outc, tintc * (lum * 2.4 + 0.12) + vec3(0.04), line * 0.85 * k);
    return outc;
}
`;

function fragmentShader(o: WorldShaderOptions): string {
    // Only the branches of the materials this variant draws are compiled: an uber-shader holding
    // every material runs far slower even where its branches aren't taken (register pressure).
    const ids = variantIds(o);
    const has = (...m: number[]) => m.some(i => ids.has(i));
    const g = (cond: boolean, code: string) => (cond ? code : "");
    if (o.caster) return /* glsl */ `${HEADER}
void main() {
    gl_FragColor = vec4(1.0);
}
`;
    const tex = o.textured;
    return /* glsl */ `${HEADER}
${WORLD_DECL}
${VARYINGS(o, true)}
${NOISE_GLSL}
${SURFACES_GLSL}
${ATMOSPHERE_GLSL}
${CLOUDS_GLSL}
${SHADOW_GLSL}
${tex ? materialsGlsl() : ""}
${o.territory ? TERRITORY_GLSL : ""}

void main() {
${o.flat ? "    gl_FragColor = vec4(v_color.rgb * (0.5 + 0.5 * max(dot(normalize(v_normal), normalize(W_SUN_DIR.xyz)), 0.0)), 1.0); return;" : ""}
${o.flatAll ? "    gl_FragColor = vec4(v_color.rgb * (0.5 + 0.5 * max(dot(normalize(v_normal), normalize(W_SUN_DIR.xyz)), 0.0)) + 1e-9 * (v_world_pos + vec3(v_uv, 0.0) + v_tex_pos + v_local_normal + v_tint.xyz + v_tex_origin.xyz + v_m0 + v_m1 + v_m2), 1.0); return;" : ""}
    mat3 model = mat3(v_m0, v_m1, v_m2);
    vec4 item_tint = v_tint;
    vec4 item_tex_origin = v_tex_origin;
    vec2 in_uv = v_uv;
    // The view depth (clip w) without a varying: gl_FragCoord.w is its reciprocal.
    float view_w = 1.0 / gl_FragCoord.w;
    int material = int(floor(in_uv.x + 0.0005));
    vec3 cam = u_eye;
    vec3 sun = normalize(W_SUN_DIR.xyz);
    int count = int(W_PARAMS.z);
    // One pixel's width on the surface, in meters (derivatives taken in uniform control flow).
    float footprint = max(length(fwidth(v_tex_pos)), 1.0e-4);
${g(has(8), `
    vec2 wall_dir = normalize(vec2(-v_local_normal.z, v_local_normal.x) + vec2(1.0e-6, 0.0));
    vec2 win_uv = vec2(dot(v_tex_pos.xz, wall_dir) / 3.0, v_color.a / 3.2);
    float win_fw = max(fwidth(win_uv.x), fwidth(win_uv.y));`)}
${g(tex && has(6, 11), `
    vec3 mat_scale = vec3(length(v_m0), length(v_m1), length(v_m2));
    vec2 mat_uv0 = surface_uv(v_tex_pos * mat_scale, normalize(v_local_normal));
    vec2 mat_dx = dFdx(mat_uv0);
    vec2 mat_dy = dFdy(mat_uv0);`)}
${g(tex && has(0, 10), `
    vec3 ground_dx = dFdx(v_tex_pos);
    vec3 ground_dy = dFdy(v_tex_pos);`)}
${g(has(9), `
    if (material == 9) {
        vec3 d = normalize(v_world_pos - cam);
        vec3 col = stars(d);
        float sd = dot(d, sun);
        col = col + W_SUN_COLOR.rgb * (smoothstep(0.99955, 0.9998, sd) * 30.0 + pow(max(sd, 0.0), 900.0) * 3.0 + pow(max(sd, 0.0), 12.0) * 0.06);
        for (int i = 0; i < ${MAX_PLANETS} + LOOP0; i++) {
            if (i >= count) { break; }
            Haze hz = atmosphere_segment(cam, d, i, 1e9, 1.2, 3.0);
            col = col * hz.transmit + hz.light;
        }
        col = sky_clouds(col, cam, d, sun);
        gl_FragColor = finish_color(col);
        ${o.fragmentDepth ? "gl_FragDepth = SKY_DEPTH;" : ""}
        return;
    }`)}
    float frag_depth = log_depth(view_w);
${g(has(10), `
    if (material == 10) {
        // Roads: gone past the road distance, and pulled toward the camera in depth.
        if (view_w > W_CITY.y) { discard; }
        frag_depth = log_depth(max(view_w * 0.996 - 0.05, 0.01));
    }`)}
${g(has(7, MAT_FIRE, MAT_SMOKE), `
    uvec2 fc = uvec2(gl_FragCoord.xy);
    uint b2 = ((fc.x ^ fc.y) & 1u) * 2u + (fc.y & 1u);
    uint b4 = b2 * 4u + (((fc.x >> 1u) ^ (fc.y >> 1u)) & 1u) * 2u + ((fc.y >> 1u) & 1u);
    float dither = (float(b4) + 0.5) / 16.0;`)}
${g(has(MAT_FIRE, MAT_SMOKE), `
    if (material == ${MAT_FIRE} || material == ${MAT_SMOKE}) {
        // Fire and smoke fade by ordered dither (4 x 4), so nothing needs blending.
        if (dither > item_tex_origin.w) { discard; }
    }`)}
${g(has(7), `
    if (material == 7) {
        // See-through window glass: leave the alpha share of the pane unpainted.
        vec3 vv = normalize(cam - v_world_pos);
        float fr = pow(1.0 - abs(dot(normalize(v_normal), vv)), 3.0);
        float keep = 1.0 - v_color.a * (1.0 - fr);
        if (dither > keep) { discard; }
    }`)}

    int pi = planet_of(v_world_pos);
    vec3 pc = W_PLANET(pi).xyz;
    vec3 n = normalize(v_normal);
    vec3 v_vec = cam - v_world_pos;
    float dist = length(v_vec);
    vec3 v = v_vec / max(dist, 0.0001);
    vec3 up = normalize(v_world_pos - pc);
    float day = daylight(v_world_pos, pi);
    vec3 atmo = atmo_color(pi);
    vec3 base = linear(v_color.rgb);
    vec3 col = vec3(0.0);
    float sun_vis = sun_visibility(v_world_pos, n, view_w, pi);

    if (material < 0) {
        // (unreachable: keeps the chain below well formed in every variant)
    }${g(has(MAT_FIRE), `
    else if (material == ${MAT_FIRE}) {
        // Flames: hot where the vertex color is bright, licking and flickering over the surface.
        float ft = W_SUN_DIR.w;
        vec3 q = v_tex_pos * 2.3 + vec3(item_tex_origin.x);
        float flick = 0.75 + 0.25 * sin(q.x * 3.1 + ft * 17.0) * sin(q.y * 2.7 - ft * 23.0 + q.z * 1.9);
        float rim = pow(max(dot(n, v), 0.0), 0.6);
        col = linear(item_tint.rgb) * base * (0.6 + 0.4 * rim) * flick * (1.2 + item_tint.w * 3.0);
    }`)}${g(has(4), `
    else if (material == 4) {
        col = base * (1.1 + item_tint.w * 2.2);
    }`)}${g(has(5, 7), `
    else if (material == 5 || material == 7) {
        vec3 r = reflect(-v, n);
        float fres = 0.08 + 0.92 * pow(1.0 - max(dot(n, v), 0.0), 4.0);
        vec3 sky_amb = atmo * (0.22 + 0.18 * max(dot(n, up), 0.0)) * day + vec3(0.012, 0.014, 0.02);
        col = base * 0.12 + sky_amb * 0.6 * fres + W_SUN_COLOR.rgb * pow(max(dot(r, sun), 0.0), 180.0) * 3.0 * sun_vis;
    }`)} else {
${g(has(3, 6, 11), "        if (material == 3 || material == 6 || material == 11) { base = base * item_tint.rgb; }")}
${g(has(MAT_FOLIAGE), `        if (material == ${MAT_FOLIAGE}) { base = base * item_tint.rgb; }`)}
${g(has(MAT_SMOKE), `        if (material == ${MAT_SMOKE}) { base = base * item_tint.rgb; }`)}
${g(has(12), "        if (material == 12) { base = base * linear(item_tint.rgb); }")}
${g(has(13), "        if (material == 13) { base = base * linear(item_tex_origin.xyz); }")}
${o.people && has(15, 16) ? /* glsl */ `
        if (material == 15) { base = base * linear(v_skin.rgb); }
        if (material == 16) { base = base * linear(v_hair.rgb); }
` : ""}
        float spec = 0.0;
        float shin = 16.0;
        vec3 spec_color = vec3(1.0);
        float diffuse_weight = 1.0;
        float ao = 1.0;
        vec3 t = v_tex_pos;
        if (material < 0) {}
${g(has(0), `
        else if (material == 0) {
            // Terrain: rock where the vertex says so, snow by its color, soil and grass elsewhere.
            float rock_w = smoothstep(0.15, 0.75, v_color.a);
${tex ? /* glsl */ `
            Surface g;
            if (DIAG_OFF(32)) { g = ground_surface(base, t, n, footprint); }
            else { g = ground_surface_maps(v_color.rgb, t, n, up, footprint, ground_dx, ground_dy); }
` : /* glsl */ `
            float snow_w = smoothstep(0.72, 0.86, min(v_color.r, min(v_color.g, v_color.b))) * (1.0 - rock_w);
            Surface g = ground_surface(base, t, n, footprint);
            if (snow_w > 0.0) { g = blend_surface(g, snow_surface(base, t, n, footprint), snow_w); }
`}
            if (rock_w > 0.0 && !DIAG_OFF(1)) { g = blend_surface(g, rock_surface(base, t, n, up, footprint), rock_w); }
            base = g.albedo;
            n = g.n;
            spec = g.spec;
            shin = g.shin;
            ao = g.ao;
        }`)}${g(has(1), `
        else if (material == 1) {
            // Water: wind ripples drifting with time.
            float time = W_SUN_DIR.w;
            vec4 waves = fbm(t + vec3(time * 0.6, 0.0, time * 0.35), 1.0 / 8.0, 6, 0.55, footprint);
            vec4 chop = fbm(t - vec3(time * 0.9, 0.0, -time * 0.5), 1.0 / 2.0, 4, 0.5, footprint);
            n = bump(n, waves.yzw * 0.12 + chop.yzw * 0.03);
            spec = 1.2;
            shin = 140.0;
        }`)}${g(has(8), `
        else if (material == 8) {
            // Building boxes: rows of windows on the walls.
            vec3 ln = normalize(v_local_normal);
            if (abs(ln.y) < 0.5) {
                float vv = win_uv.y;
                vec2 cell = fract(win_uv);
                float inside = step(0.22, cell.x) * step(cell.x, 0.78) * step(0.3, cell.y) * step(cell.y, 0.82) * step(1.0, vv);
                vec3 glass = vec3(0.05, 0.065, 0.085);
                float w = mix(inside, 0.29 * step(1.0, vv), smoothstep(0.15, 0.4, win_fw));
                base = mix(base, glass, w);
                spec = 0.6 * w;
                shin = 90.0;
            }
        }`)}${g(has(10), `
        else if (material == 10) {
${tex ? /* glsl */ `
            Textured road = ground_maps(${GROUND.asphalt}, t, n, ground_dx, ground_dy);
            base = road.albedo; n = road.n_local;
            float a = road.rough * road.rough;
            shin = clamp(2.0 / (a * a) - 2.0, 2.0, 2048.0);
            spec = 0.04 * (shin + 8.0) / 8.0;
` : /* glsl */ `
            vec4 g = fbm(t, 1.0 / 2.0, 4, 0.5, footprint);
            base = base * (0.9 + 0.12 * g.x);
            spec = 0.08;
            shin = 20.0;
`}
        }`)}${g(has(2), `
        else if (material == 2) {
            // Ice: smooth sheets with pale fracture lines.
            vec4 sheet = fbm(t, 1.0 / 16.0, 5, 0.5, footprint);
            vec4 cn = vnoise(t * 0.25, TEX_PERIOD * 0.25);
            float crack = (1.0 - smoothstep(0.0, 0.05, abs(cn.x))) * octave_fade(1.0, footprint);
            n = bump(n, sheet.yzw * 0.06);
            base = base * (0.95 + 0.1 * sheet.x) + vec3(0.12) * crack;
            spec = 0.45;
            shin = 40.0;
        }`)}
${g(has(11) || (tex && has(6)), `
        else if (${tex ? "material == 11 || material == 6" : "material == 11"}) {
            int kind = int(floor(in_uv.y + 0.0005));
            vec3 ln = normalize(v_local_normal);
${tex ? /* glsl */ `
            int layer = DIAG_OFF(64) ? -1 : surface_layer(kind);
            if (layer >= 0) {
                // Textured: maps with parallax near the eye, then the same weathering.
                vec3 vl = normalize(vec3(dot(v, normalize(v_m0)), dot(v, normalize(v_m1)), dot(v, normalize(v_m2))));
                Textured tx = textured_surface(kind, layer, mat_uv0, mat_dx, mat_dy, ln, vl, dist);
                Facade fc = city_surface(0, tx.albedo * item_tint.rgb, v_tex_pos * mat_scale, ln, footprint);
                base = fc.albedo;
                float a = tx.rough * tx.rough;
                shin = clamp(2.0 / (a * a) - 2.0, 2.0, 2048.0);
                vec3 f0 = mix(vec3(0.04), tx.albedo, tx.metallic);
                vec3 fresnel = f0 + (vec3(1.0) - f0) * pow(1.0 - max(dot(n, v), 0.0), 5.0);
                spec = (shin + 8.0) / 8.0;
                spec_color = fresnel;
                diffuse_weight = 1.0 - tx.metallic;
                ao = fc.ao * mix(0.5, 1.0, smoothstep(0.05, 0.55, tx.height));
                n = normalize(model * tx.n_local);
            } else {
                // Broken pieces (tex_origin.w < 0): the pattern in meters on the piece as drawn.
                vec3 ftex = item_tex_origin.w < -0.5 ? v_tex_pos * mat_scale : v_tex_pos;
                Facade fc = city_surface(kind, base, ftex, ln, footprint);
                base = fc.albedo;
                spec = fc.spec;
                shin = fc.shin;
                ao = fc.ao;
                n = bump(n, model * fc.grad);
            }
` : /* glsl */ `
            Facade fc = city_surface(kind, base, v_tex_pos, ln, footprint);
            base = fc.albedo;
            spec = fc.spec;
            shin = fc.shin;
            ao = fc.ao;
            n = bump(n, model * fc.grad);
`}
        }
`)}
${g(has(3), "        if (material == 3) { spec = 0.35; shin = 48.0; }")}
${g(!tex && has(6), "        if (material == 6) { spec = 0.12; shin = 24.0; }")}
${g(has(12, 13, 14, 15, 16), "        if (material >= 12 && material <= 16) { spec = 0.1; shin = 18.0; }")}
${g(has(MAT_SMOKE), `        if (material == ${MAT_SMOKE}) { spec = 0.0; if (dot(n, v) < 0.0) { n = -n; } }`)}
${g(has(MAT_FOLIAGE), `
        if (material == ${MAT_FOLIAGE}) {
            // Leaves: a waxy sheen, lit from either side.
            spec = 0.16; shin = 30.0;
            if (dot(n, v) < 0.0) { n = -n; }
        }`)}
        float ndl = max(dot(n, sun), 0.0);
        // Sky light (Allegiance): a paler fill than QuadPlanet's, and bounce from the sunlit ground.
        vec3 sky_tone = mix(atmo, vec3(dot(atmo, vec3(0.3, 0.5, 0.2))), 0.55 + 0.35 * W_CLOUD.w);
        vec3 bounce = W_SUN_COLOR.rgb * 0.09 * clamp(0.55 - 0.45 * dot(n, up), 0.0, 1.0) * smoothstep(-0.12, 0.2, dot(up, sun));
        vec3 sky_amb = (sky_tone * (0.3 + 0.22 * max(dot(n, up), 0.0)) + bounce) * day + vec3(0.012, 0.014, 0.02);
        vec3 h = normalize(sun + v);
        float s = pow(max(dot(n, h), 0.0), shin) * spec * ndl;
        float lit = ndl * smoothstep(-0.12, 0.2, dot(up, sun)) * sun_vis;
        col = base * diffuse_weight * (W_SUN_COLOR.rgb * lit * 1.35 + sky_amb * ao) + W_SUN_COLOR.rgb * spec_color * s * smoothstep(-0.12, 0.2, dot(up, sun)) * sun_vis;
${g(has(3, 6, 8, 11, 12, 13, 14, 15, 16), "        if (material == 3 || material == 6 || material == 8 || material == 11 || (material >= 12 && material <= 16)) { col = col + base * 0.18 * max(dot(n, v), 0.0); }")}
${g(has(MAT_FOLIAGE), `
        if (material == ${MAT_FOLIAGE}) {
            // Sun through the leaves: bright yellow-green where you look toward the sun past them.
            float leaf = in_uv.y >= 1.0 ? 1.0 : 0.35;
            float through = pow(max(dot(-v, sun), 0.0), 4.0) * 0.9 + max(dot(-n, sun), 0.0) * 0.4;
            col = col + base * vec3(1.15, 1.3, 0.55) * W_SUN_COLOR.rgb * through * leaf * sun_vis * smoothstep(-0.12, 0.2, dot(up, sun));
            col = col + base * 0.1 * max(dot(n, v), 0.0);
        }`)}
${g(has(1), `
        if (material == 1) {
            float fres = pow(1.0 - max(dot(n, v), 0.0), 5.0);
            col = col + atmo * fres * 0.5 * day;
        }`)}
    }
${g(o.territory && has(0, 8, 10), "    if (material == 0 || material == 8 || material == 10) { col = territory_overlay(col, v_world_pos); }")}
    // Aerial perspective through every atmosphere between the camera and this point.
    for (int i = 0; i < ${MAX_PLANETS} + LOOP0; i++) {
        if (i >= count || DIAG_OFF(4)) { break; }
        Haze hz = atmosphere_segment(cam, -v, i, dist, 0.1, 1.0);
        col = col * hz.transmit + hz.light;
    }
    gl_FragColor = finish_color(col);
    if (W_PARAMS.y > 0.5) { // DEBUG
        int dm = int(W_PARAMS.y);
        if (dm == 1) gl_FragColor = vec4(normalize(v_normal) * 0.5 + 0.5, 1.0);
        if (dm == 2) gl_FragColor = vec4(float(material) / 12.0, fract(in_uv.y), fract(in_uv.x), 1.0);
        if (dm == 3) gl_FragColor = vec4(fract(item_tex_origin.xyz / 1024.0), 1.0);
        if (dm == 4) gl_FragColor = vec4(fract(dist / 1.0e6), fract(dist / 1.0e7), length(v_world_pos) / 2.0e7, 1.0);
        if (dm == 5) gl_FragColor = vec4(v_color.rgb, 1.0);
        if (dm == 6) gl_FragColor = vec4(base, 1.0);
    }
    ${o.fragmentDepth ? "gl_FragDepth = frag_depth;" : ""}
}
`;
}

/** The vertex and fragment sources of one world shader variant. */
export function worldShader(o: WorldShaderOptions): { vertex: string; fragment: string } {
    return { vertex: vertexShader(o), fragment: fragmentShader(o) };
}
