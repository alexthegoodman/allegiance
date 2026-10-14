// Textures the world shader samples: the PBR material maps (one mipmapped texture array per map
// type, a layer per set: al_materials.ts), the baked cloud-noise atlas (al_clouds.ts), and
// placeholders bound until they are ready (a sampler must always have a texture of its type).
//
// The material arrays are allocated and filled with WebGL 2 directly (immutable storage, sRGB for
// base color, one layer uploaded per decoded image, then mipmaps) and handed to Babylon wrapped as
// internal textures: Babylon's raw array textures have no sRGB option, and uploading layer by
// layer keeps a hundred 1024px images from being held in memory at once.

import type { Engine } from "@babylonjs/core/Engines/engine";
import type { Scene } from "@babylonjs/core/scene";
import { BaseTexture } from "@babylonjs/core/Materials/Textures/baseTexture";
import { InternalTexture, InternalTextureSource } from "@babylonjs/core/Materials/Textures/internalTexture";
import { WebGLHardwareTexture } from "@babylonjs/core/Engines/WebGL/webGLHardwareTexture";
import { Constants } from "@babylonjs/core/Engines/constants";
import { RenderTargetTexture } from "@babylonjs/core/Materials/Textures/renderTargetTexture";
import { EffectRenderer, EffectWrapper } from "@babylonjs/core/Materials/effectRenderer";
import { MATERIAL_MAPS, MATERIAL_SETS, MATERIAL_SIZE, materialFallback, materialFiles, type MaterialLoad } from "../game/al_materials";
import { CLOUD_CACHE_HEIGHT, CLOUD_CACHE_WIDTH, cloudBakeGlsl } from "../game/al_clouds";
import { NOISE_FOR_BAKE } from "./shaders/world_glsl";

type GL = WebGL2RenderingContext;
const glOf = (engine: Engine): GL => (engine as unknown as { _gl: GL })._gl;

/** Babylon caches the bound textures and unpack state; raw WebGL calls must leave them unknown. */
function forgetGlState(engine: Engine): void {
    engine.resetTextureCache();
    (engine as unknown as { _unpackFlipYCached: boolean | null })._unpackFlipYCached = null;
}

/** A texture array made with raw WebGL, wrapped for Babylon. */
export class GlTextureArray {
    readonly texture: BaseTexture;
    private gl: GL;
    private handle: WebGLTexture;

    constructor(private engine: Engine, scene: Scene, readonly size: number, readonly layers: number, srgb: boolean, mipmaps = true) {
        const gl = this.gl = glOf(engine);
        this.handle = gl.createTexture()!;
        const levels = mipmaps ? Math.floor(Math.log2(size)) + 1 : 1;
        gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.handle);
        gl.texStorage3D(gl.TEXTURE_2D_ARRAY, levels, srgb ? gl.SRGB8_ALPHA8 : gl.RGBA8, size, size, layers);
        gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, mipmaps ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.REPEAT);
        gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.REPEAT);
        gl.bindTexture(gl.TEXTURE_2D_ARRAY, null);
        forgetGlState(engine);
        const it = new InternalTexture(engine, InternalTextureSource.Raw2DArray);
        it._hardwareTexture = new WebGLHardwareTexture(this.handle, gl);
        it.width = it.baseWidth = size;
        it.height = it.baseHeight = size;
        it.depth = it.baseDepth = layers;
        it.is2DArray = true;
        it.generateMipMaps = mipmaps;
        it.samplingMode = mipmaps ? Constants.TEXTURE_TRILINEAR_SAMPLINGMODE : Constants.TEXTURE_BILINEAR_SAMPLINGMODE;
        it.format = Constants.TEXTUREFORMAT_RGBA;
        it.type = Constants.TEXTURETYPE_UNSIGNED_BYTE;
        it._useSRGBBuffer = srgb;
        it.isReady = true;
        this.texture = new BaseTexture(scene, it);
        this.texture.wrapU = Constants.TEXTURE_WRAP_ADDRESSMODE;
        this.texture.wrapV = Constants.TEXTURE_WRAP_ADDRESSMODE;
        this.texture.anisotropicFilteringLevel = mipmaps ? 8 : 1;
    }

    /** Fills one layer from an image (exactly size x size) or RGBA bytes. */
    upload(layer: number, source: TexImageSource | Uint8Array): void {
        const gl = this.gl;
        gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.handle);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
        gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
        if (source instanceof Uint8Array) gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, layer, this.size, this.size, 1, gl.RGBA, gl.UNSIGNED_BYTE, source);
        else gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, layer, this.size, this.size, 1, gl.RGBA, gl.UNSIGNED_BYTE, source);
        gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.BROWSER_DEFAULT_WEBGL);
        gl.bindTexture(gl.TEXTURE_2D_ARRAY, null);
        forgetGlState(this.engine);
    }

    /** Builds the mip chain once every layer is in. */
    finish(): void {
        const gl = this.gl;
        gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.handle);
        gl.generateMipmap(gl.TEXTURE_2D_ARRAY);
        gl.bindTexture(gl.TEXTURE_2D_ARRAY, null);
        forgetGlState(this.engine);
    }
}

/** A layer of one color, or the magenta/black checkerboard a missing base color map shows as. */
function fallbackPixels(size: number, fallback: "checker" | [number, number, number, number]): Uint8Array {
    const out = new Uint8Array(size * size * 4);
    const cell = Math.max(1, size / 16);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
        const o = (y * size + x) * 4;
        let c: number[];
        if (fallback === "checker") c = (Math.floor(x / cell) + Math.floor(y / cell)) % 2 ? [255, 0, 255, 255] : [0, 0, 0, 255];
        else c = fallback.map(v => Math.round(v * 255));
        out[o] = c[0]; out[o + 1] = c[1]; out[o + 2] = c[2]; out[o + 3] = c[3];
    }
    return out;
}

export type MaterialArrays = Record<typeof MATERIAL_MAPS[number], GlTextureArray>;

/** Empty material arrays: one layer of fallback values each, until the real maps load. */
export function placeholderMaterials(engine: Engine, scene: Scene): MaterialArrays {
    const out = {} as MaterialArrays;
    for (const map of MATERIAL_MAPS) {
        const a = new GlTextureArray(engine, scene, 4, 1, map === "basecolor", false);
        a.upload(0, fallbackPixels(4, materialFallback(map) === "checker" ? [0.5, 0.5, 0.5, 1] : materialFallback(map) as [number, number, number, number]));
        out[map] = a;
    }
    return out;
}

/**
 * Loads every material map: one array per map type, a layer per set, decoded off the main thread
 * and uploaded layer by layer. A file that can't be read becomes the fallback (the checkerboard
 * for color), so a missing asset is plain to see. `size` scales every map (1024 as authored).
 */
export async function loadMaterialArrays(engine: Engine, scene: Scene, base: string, size = MATERIAL_SIZE, progress?: (done: number, total: number) => void): Promise<{ arrays: MaterialArrays; load: MaterialLoad }> {
    const arrays = {} as MaterialArrays;
    const missing: MaterialLoad["missing"] = [];
    const total = MATERIAL_MAPS.length * MATERIAL_SETS.length;
    let done = 0;
    for (const map of MATERIAL_MAPS) {
        const a = new GlTextureArray(engine, scene, size, MATERIAL_SETS.length, map === "basecolor");
        const files = materialFiles(map);
        // A few decodes at once; each layer is uploaded as soon as it is ready.
        await Promise.all(files.map(async (file, layer) => {
            try {
                const res = await fetch(`${base}${file}`);
                if (!res.ok) throw new Error(String(res.status));
                const bmp = await createImageBitmap(await res.blob(), { colorSpaceConversion: "none", premultiplyAlpha: "none", resizeWidth: size, resizeHeight: size, resizeQuality: "high" });
                a.upload(layer, bmp);
                bmp.close();
            } catch {
                missing.push({ map, set: MATERIAL_SETS[layer].name });
                a.upload(layer, fallbackPixels(size, materialFallback(map)));
            }
            progress?.(++done, total);
        }));
        a.finish();
        arrays[map] = a;
    }
    return { arrays, load: { missing } };
}

/**
 * Bakes the cloud-noise atlas (al_clouds.ts) with a fragment pass: half-float RGBA, filtered,
 * clamped (the atlas wraps itself). Null where the GPU can't render to half floats; the shader
 * then evaluates the clouds procedurally.
 */
export function bakeClouds(engine: Engine, scene: Scene): Promise<RenderTargetTexture | null> {
    const caps = engine.getCaps();
    if (!caps.textureHalfFloatRender) return Promise.resolve(null);
    const rtt = new RenderTargetTexture("cloud-atlas", { width: CLOUD_CACHE_WIDTH, height: CLOUD_CACHE_HEIGHT }, scene, {
        type: Constants.TEXTURETYPE_HALF_FLOAT, generateMipMaps: false, samplingMode: Constants.TEXTURE_BILINEAR_SAMPLINGMODE,
        generateDepthBuffer: false, format: Constants.TEXTUREFORMAT_RGBA,
    });
    rtt.wrapU = Constants.TEXTURE_CLAMP_ADDRESSMODE;
    rtt.wrapV = Constants.TEXTURE_CLAMP_ADDRESSMODE;
    rtt.refreshRate = 0;
    return new Promise(resolve => {
        // A bake that fails to compile leaves the clouds procedural rather than stopping the game.
        const wrapper = new EffectWrapper({ engine, name: "cloud-bake", fragmentShader: cloudBakeGlsl(NOISE_FOR_BAKE), uniformNames: [], samplerNames: [],
            onError: (_e, errors) => { console.warn(`[allegiance] cloud bake: ${errors}`); rtt.dispose(); resolve(null); } });
        const fx = new EffectRenderer(engine);
        wrapper.effect.executeWhenCompiled(() => {
            fx.render(wrapper, rtt);
            fx.dispose();
            wrapper.dispose();
            resolve(rtt);
        });
    });
}
