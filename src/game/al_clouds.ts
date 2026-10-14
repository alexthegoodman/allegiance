// One static, periodic 3D cloud-noise field stored as padded slices in a filterable 2D atlas.
// Weather thresholds and wind offsets stay live. No rebaking for movement, travel or rebasing.
// Baked once at startup by a fragment pass (engine/clouds.ts; WebGL has no compute shaders) with
// the exact lattice hash and value noise of the reference cloud shader (engine/shaders/world_glsl.ts).
import { CLOUD_PERIOD } from "../quadplanet/qp_shader";

export const CLOUD_CACHE_SIZE = 64;
export const CLOUD_CACHE_TILE = CLOUD_CACHE_SIZE + 2;
export const CLOUD_CACHE_COLUMNS = 8;
export const CLOUD_CACHE_WIDTH = CLOUD_CACHE_TILE * CLOUD_CACHE_COLUMNS;
export const CLOUD_CACHE_HEIGHT = CLOUD_CACHE_TILE * CLOUD_CACHE_SIZE / CLOUD_CACHE_COLUMNS;
export const CLOUD_CACHE_BYTES = CLOUD_CACHE_WIDTH * CLOUD_CACHE_HEIGHT * 8; // RGBA16F

/** The bake: one texel of the atlas per fragment. RG = coarse/fine at Z; BA = coarse/fine at Z+1. */
export function cloudBakeGlsl(noise: string): string {
    return /* glsl */ `
precision highp float;
precision highp int;
varying vec2 vUV;
const float TEX_PERIOD = 1024.0;
#define LOOP0 0
#define DIAG_OFF(bit) false
${noise}
vec2 field(vec3 p) {
    float sum = 0.0;
    float amp = 0.5;
    float freq = 1.0 / 4096.0;
    float coarse = 0.0;
    for (int o = 0; o < 6; o++) {
        sum += vnoise(p * freq + vec3(float(o) * 5.0, float(o) * 13.0, float(o) * 3.0), ${CLOUD_PERIOD}.0 * freq).x * amp;
        if (o == 2) { coarse = sum; }
        amp *= 0.5;
        freq *= 2.0;
    }
    return vec2(coarse, sum);
}
void main() {
    uvec2 id = uvec2(gl_FragCoord.xy);
    uvec2 tile = id / ${CLOUD_CACHE_TILE}u;
    // One wrapped border texel on each side makes XY filtering seam-free.
    uvec2 xy = (id % ${CLOUD_CACHE_TILE}u + ${CLOUD_CACHE_SIZE - 1}u) % ${CLOUD_CACHE_SIZE}u;
    uint z = tile.y * ${CLOUD_CACHE_COLUMNS}u + tile.x;
    vec3 p = vec3(vec2(xy), float(z)) * ${CLOUD_PERIOD / CLOUD_CACHE_SIZE}.0;
    vec2 a = field(p);
    vec2 b = field(vec3(p.xy, float((z + 1u) % ${CLOUD_CACHE_SIZE}u) * ${CLOUD_PERIOD / CLOUD_CACHE_SIZE}.0));
    gl_FragColor = vec4(a, b);
}
`;
}
