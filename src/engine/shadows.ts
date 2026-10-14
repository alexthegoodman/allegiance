// Cascaded sun shadows (the engine's addon_sun_shadows.rs, on Babylon): one layered depth target,
// a layer per cascade, rendered before the scene with the caster variant of the world shader, and
// sampled by every receiver through a comparison sampler (shaders/world_glsl.ts SHADOW_GLSL).
//
// The game places the cascades (al_sky.ts shadowCascades: a sphere around the camera per cascade,
// texel-snapped, the light's near plane far toward the sun). Each drawable says how many cascades
// it casts into (people and small props the nearest two, ground cover the nearest one, trees and
// buildings all four), and a cascade draws only the casters whose bounding sphere reaches it.
// Cascades that hold still are redrawn every `refresh[k]` frames (the far ones less often).

import { RenderTargetTexture } from "@babylonjs/core/Materials/Textures/renderTargetTexture";
import { BaseTexture } from "@babylonjs/core/Materials/Textures/baseTexture";
import { Constants } from "@babylonjs/core/Engines/constants";
import { Matrix } from "@babylonjs/core/Maths/math.vector";
import type { Scene } from "@babylonjs/core/scene";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import type { ShaderMaterial } from "@babylonjs/core/Materials/shaderMaterial";
import type { Drawable } from "./drawables";
import type { Renderer } from "./renderer";

export const MAX_CASCADES = 4;

/** Cascades as the game sends them (Entropy.Lighting.setSunShadows). */
export interface CascadeConfig {
    /** Column-major light matrices (render space -> clip with z in 0..1), one per cascade. */
    cascades: number[][];
    /** Meters per shadow texel, per cascade. */
    texel: number[];
    depthRange: number;
    strength: number;
    mapSize: number;
    /** Redraw cascade k every refresh[k] frames while it holds still. */
    refresh?: number[];
}

/** WebGPU-style clip (z 0..1) to GL clip (z -1..1): z' = 2z - 1. */
const IDENTITY = Matrix.Identity();
const Z_TO_GL = Matrix.FromValues(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 2, 0, 0, 0, -1, 1);

export class SunShadows {
    private rtt: RenderTargetTexture | null = null;
    private size = 0;
    private casters = new Map<AbstractMesh, { drawable: Drawable; caster: ShaderMaterial }>();
    private config: CascadeConfig | null = null;
    private light: Matrix[] = [];
    private glLight: Matrix[] = [];
    private dirty = [true, true, true, true];
    private frame = 0;
    private layerNow = 0;
    private lists: AbstractMesh[][] = [[], [], [], []];
    /** Casters drawn per cascade last frame (for the state report). */
    lastCounts = [0, 0, 0, 0];

    constructor(private scene: Scene, private renderer: Renderer, mapSize = 2048) { this.ensureTarget(mapSize); }

    private ensureTarget(size: number): RenderTargetTexture {
        if (this.rtt && this.size === size) return this.rtt;
        if (this.rtt) {
            this.scene.customRenderTargets = this.scene.customRenderTargets.filter(t => t !== this.rtt);
            this.rtt.dispose();
        }
        this.size = size;
        const rtt = new RenderTargetTexture("sun-shadows", { width: size, height: size, layers: MAX_CASCADES }, this.scene, {
            generateMipMaps: false, doNotChangeAspectRatio: true, type: Constants.TEXTURETYPE_UNSIGNED_BYTE, samplingMode: Constants.TEXTURE_NEAREST_SAMPLINGMODE,
            generateDepthBuffer: false, format: Constants.TEXTUREFORMAT_RED,
        });
        rtt.createDepthStencilTexture(Constants.LESS, true, false, 1, Constants.TEXTUREFORMAT_DEPTH24, "sun-shadow-depth");
        rtt.renderList = [];
        rtt.refreshRate = 1;
        rtt.getCustomRenderList = (layer: number) => this.lists[layer] ?? [];
        rtt.onBeforeBindObservable.add(() => this.renderer.gpu?.begin("shadows"));
        rtt.onAfterUnbindObservable.add(() => this.renderer.gpu?.end());
        rtt.onBeforeRenderObservable.add(layer => {
            this.layerNow = layer;
            if (this.light[layer]) this.scene.setTransformMatrix(IDENTITY, this.glLight[layer]);
        });
        rtt.onClearObservable.add(engine => {
            if (this.dirty[this.layerNow]) engine.clear(null, false, true, false);
        });
        for (const [mesh, c] of this.casters) rtt.setMaterialForRendering(mesh, c.caster);
        this.scene.customRenderTargets.push(rtt);
        this.rtt = rtt;
        this.renderer.setShadowTexture(new BaseTexture(this.scene, rtt.depthStencilTexture!));
        return rtt;
    }

    /** A drawable that casts (its `casterCascades` says into how many cascades). */
    addCaster(d: Drawable, caster: ShaderMaterial): void {
        this.casters.set(d.mesh, { drawable: d, caster });
        this.rtt?.setMaterialForRendering(d.mesh, caster);
    }

    removeCaster(d: Drawable): void {
        this.casters.delete(d.mesh);
    }

    /** Sets this frame's cascades, or turns shadows off (null). */
    update(config: CascadeConfig | null): void {
        const r = this.renderer;
        if (!config || !config.cascades.length) {
            this.config = null;
            r.shadow.params[0] = 0;
            for (const l of this.lists) l.length = 0;
            return;
        }
        this.ensureTarget(config.mapSize);
        const refresh = config.refresh ?? [1, 1, 1, 1];
        this.frame++;
        const n = Math.min(MAX_CASCADES, config.cascades.length);
        for (let k = 0; k < n; k++) {
            const changed = !this.config || this.config.mapSize !== config.mapSize || !sameArray(this.config.cascades[k], config.cascades[k]);
            this.dirty[k] = changed || this.frame % Math.max(1, refresh[k] ?? 1) === 0;
            const m = Matrix.FromArray(config.cascades[k]);
            this.light[k] = m;
            this.glLight[k] = m.multiply(Z_TO_GL);
            r.shadow.matrices.set(config.cascades[k], k * 16);
            r.shadow.texel[k] = config.texel[k];
        }
        r.shadow.params[0] = n;
        r.shadow.params[1] = config.mapSize;
        r.shadow.params[2] = config.strength;
        r.shadow.params[3] = 1 / config.depthRange;
        this.config = config;
        // Casters per cascade: the ones that cast this far and whose sphere reaches the cascade's box.
        for (let k = 0; k < MAX_CASCADES; k++) {
            const list = this.lists[k];
            list.length = 0;
            if (k >= n || !this.dirty[k]) continue;
            const m = config.cascades[k];
            for (const { drawable } of this.casters.values()) {
                if (drawable.disposed || drawable.casterCascades <= k || drawable.instanceCount === 0) continue;
                const s = drawable.sphere;
                if (s && !inCascade(m, s, config.texel[k] * config.mapSize / 2, config.depthRange)) continue;
                list.push(drawable.mesh);
            }
            this.lastCounts[k] = list.length;
        }
    }
}

function sameArray(a: readonly number[] | undefined, b: readonly number[]): boolean {
    if (!a || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
}

/** Whether a sphere (render space) reaches a cascade's box (`radius`: the cascade's half width). */
function inCascade(m: readonly number[], s: readonly number[], radius: number, depthRange: number): boolean {
    const x = m[0] * s[0] + m[4] * s[1] + m[8] * s[2] + m[12];
    const y = m[1] * s[0] + m[5] * s[1] + m[9] * s[2] + m[13];
    const z = m[2] * s[0] + m[6] * s[1] + m[10] * s[2] + m[14];
    const rx = s[3] / radius, rz = s[3] / depthRange;
    return Math.abs(x) <= 1 + rx && Math.abs(y) <= 1 + rx && z >= -rz && z <= 1 + rz;
}
