// The renderer: Babylon's WebGL2 engine and one scene, drawn entirely with the world shader
// (shaders/world_glsl.ts) through a camera whose view the game sets directly (render space,
// right-handed, any up vector: on a planet "up" is wherever you stand).
//
// Coordinates follow QuadPlanet: everything is drawn relative to a render origin near the camera
// (the game moves it as the camera travels), so float precision is spent where you look. Depth is
// logarithmic, written by the shader, so the near plane is 10 cm and nothing is ever too far.

import { Engine } from "@babylonjs/core/Engines/engine";
import { Scene } from "@babylonjs/core/scene";
import { Camera } from "@babylonjs/core/Cameras/camera";
import { ShaderMaterial } from "@babylonjs/core/Materials/shaderMaterial";
import { Material } from "@babylonjs/core/Materials/material";
import { Matrix, Vector3, Vector4 } from "@babylonjs/core/Maths/math.vector";
import { Color4 } from "@babylonjs/core/Maths/math.color";
import { RenderingGroup } from "@babylonjs/core/Rendering/renderingGroup";
import type { BaseTexture } from "@babylonjs/core/Materials/Textures/baseTexture";
import { WORLD_ATTRIBUTES, PEOPLE_ATTRIBUTES, WORLD_SAMPLERS, WORLD_UNIFORMS, worldShader, SHADER_FAMILIES, type WorldShaderOptions } from "./shaders/world_glsl";
import { WORLD_FLOATS } from "../quadplanet/qp_shader";
import { GpuTimer } from "./gpu_timer";
import { TERRITORY_FLOATS } from "../game/al_territory";

/** A camera placed by the game: position, target and up in render space. */
export class WorldCamera extends Camera {
    readonly view = Matrix.Identity();
    override getViewMatrix(): Matrix { return this.view; }
}

export type MaterialKind = "scene" | "terrain" | "people";

export interface WorldMaterials {
    scene: ShaderMaterial;
    terrain: ShaderMaterial;
    people: ShaderMaterial;
    sceneCaster: ShaderMaterial;
    peopleCaster: ShaderMaterial;
}

/** The shadow uniforms (al_sky.ts cascades, as the receivers sample them). */
export interface ShadowUniforms { matrices: Float32Array; texel: Float32Array; params: Float32Array }

export class Renderer {
    readonly engine: Engine;
    readonly scene: Scene;
    readonly camera: WorldCamera;
    readonly materials: WorldMaterials;
    /** The World uniform (qp_shader.ts packWorld) and the territory overlay (al_territory.ts packTerritories). */
    world: Float32Array = new Float32Array(WORLD_FLOATS);
    territory: Float32Array = new Float32Array(TERRITORY_FLOATS);
    shadow: ShadowUniforms = { matrices: new Float32Array(64), texel: new Float32Array(4), params: new Float32Array(4) };
    eye: [number, number, number] = [0, 0, 0];
    /** Profiler only: shader features turned off (a bitmask; see world_glsl.ts DIAG_OFF). */
    diagnostics = 0;
    private receivers: ShaderMaterial[];
    private all: ShaderMaterial[];
    private territorial: ShaderMaterial[];
    /** Per-family variants (bit set of their material ids, material), smallest first. */
    private families: { terrain: [number, ShaderMaterial][]; scene: [number, ShaderMaterial][] } = { terrain: [], scene: [] };
    /** GPU pass timings (?profile). */
    gpu: GpuTimer | null = null;
    private worldArray: number[] = [];

    constructor(readonly canvas: HTMLCanvasElement) {
        const q = new URLSearchParams(location.search);
        // No multisampling, as the original drew (wgpu sample_count 1); ?msaa turns it on.
        this.engine = new Engine(canvas, q.has("msaa"), { preserveDrawingBuffer: !q.has("nopreserve"), stencil: false, antialias: q.has("msaa"), powerPreference: "high-performance", disableWebGL2Support: false }, false);
        if (this.engine.webGLVersion < 2) throw new Error("Allegiance needs WebGL 2.");
        this.scene = new Scene(this.engine);
        this.scene.useRightHandedSystem = true;
        this.scene.clearColor = new Color4(0, 0, 0, 1);
        this.scene.skipPointerMovePicking = true;
        this.scene.skipFrustumClipping = false;
        this.scene.autoClearDepthAndStencil = true;
        this.scene.detachControl();
        this.camera = new WorldCamera("camera", Vector3.Zero(), this.scene);
        this.camera.minZ = 0.1;
        this.camera.maxZ = 1e8;
        this.camera.fov = Math.PI / 4;
        this.camera.fovMode = Camera.FOVMODE_VERTICAL_FIXED;
        this.scene.activeCamera = this.camera;
        // Nearest first, so the early depth test spares the heavy shading of whatever is hidden.
        this.scene.setRenderingOrder(0, RenderingGroup.frontToBackSortCompare);
        const make = (name: string, o: WorldShaderOptions) => {
            const flat = q.has("flat") || (q.has("flatTerrain") && o.territory) || (q.has("flatObjects") && !o.territory);
            const src = worldShader({ ...o, fragmentDepth: q.has("fragdepth"), flat, flatAll: q.has("flatAll") });
            const m = new ShaderMaterial(name, this.scene, { vertexSource: src.vertex, fragmentSource: src.fragment }, {
                attributes: o.people ? PEOPLE_ATTRIBUTES : WORLD_ATTRIBUTES,
                uniforms: WORLD_UNIFORMS,
                samplers: WORLD_SAMPLERS,
            });
            // QuadPlanet's meshes are counter-clockwise seen from outside (the engine culled back faces).
            m.backFaceCulling = true;
            m.sideOrientation = Material.CounterClockWiseSideOrientation;
            return m;
        };
        this.materials = {
            scene: make("world-scene", { textured: true, territory: false, people: false, caster: false }),
            terrain: make("world-terrain", { textured: true, territory: true, people: false, caster: false }),
            people: make("world-people", { textured: false, territory: false, people: true, caster: false, materials: q.has("uber") ? undefined : SHADER_FAMILIES.people }),
            sceneCaster: make("world-caster", { textured: false, territory: false, people: false, caster: true }),
            peopleCaster: make("world-people-caster", { textured: false, territory: false, people: true, caster: true }),
        };
        this.receivers = [this.materials.scene, this.materials.terrain, this.materials.people];
        this.territorial = [this.materials.terrain];
        // Mesh families get a variant compiled with only their materials' branches (much faster
        // than the full shader); ?uber draws everything with the full one, for comparison.
        if (!q.has("uber")) {
            const bits = (ids: number[]) => ids.reduce((m, i) => m | (1 << i), 0);
            const fam = (group: "terrain" | "scene", name: keyof typeof SHADER_FAMILIES) => {
                const ids = SHADER_FAMILIES[name];
                const m = make(`world-${name}`, { textured: true, territory: group === "terrain", people: false, caster: false, materials: ids });
                this.families[group].push([bits(ids), m]);
                this.receivers.push(m);
                if (group === "terrain") this.territorial.push(m);
            };
            fam("terrain", "terrain");
            fam("terrain", "cityTiles");
            fam("scene", "sky");
            fam("scene", "buildings");
            fam("scene", "props");
            fam("scene", "effects");
        }
        this.all = [...this.receivers, this.materials.sceneCaster, this.materials.peopleCaster];
        window.addEventListener("resize", () => this.engine.resize());
        if (q.has("profile")) {
            const gl = (this.engine as unknown as { _gl: WebGL2RenderingContext })._gl;
            this.gpu = new GpuTimer(gl);
            // The main pass: everything after the shadow cascades (custom render targets) are drawn.
            this.scene.onBeforeRenderingGroupObservable.add(() => this.gpu?.begin("main"));
            this.scene.onAfterRenderingGroupObservable.add(() => this.gpu?.end());
        }
    }

    /**
     * The material for a mesh of `kind` whose vertices use the material ids in `mask` (a bit set):
     * the smallest family variant that draws all of them, else the full shader.
     */
    variant(kind: MaterialKind, mask: number): ShaderMaterial {
        if (kind === "people" || !mask) return this.materials[kind];
        for (const [bits, m] of this.families[kind]) if ((mask & ~bits) === 0) return m;
        return this.materials[kind];
    }

    /** Textures every receiver samples (the material maps, the cloud atlas, the shadow maps). */
    setTexture(name: string, texture: BaseTexture, materials: ShaderMaterial[] = this.receivers): void {
        for (const m of materials) m.setTexture(name, texture);
    }

    /** The sun-shadow depth maps every receiver samples (engine/shadows.ts). */
    setShadowTexture(texture: BaseTexture): void {
        this.setTexture("shadow_maps", texture);
    }

    /** Places the camera (render space) and sets its vertical field of view in degrees (0: the default 45). */
    setCamera(position: readonly number[], target: readonly number[], up: readonly number[], fovDegrees = 0): void {
        Matrix.LookAtRHToRef(new Vector3(position[0], position[1], position[2]), new Vector3(target[0], target[1], target[2]), new Vector3(up[0], up[1], up[2]), this.camera.view);
        this.camera.position.set(position[0], position[1], position[2]);
        this.eye = [position[0], position[1], position[2]];
        this.camera.fov = (fovDegrees > 0 ? fovDegrees : 45) * Math.PI / 180;
    }

    /** Uploads the per-frame uniforms to every world material. */
    private bindUniforms(): void {
        const w = this.worldArray;
        w.length = WORLD_FLOATS;
        for (let i = 0; i < WORLD_FLOATS; i++) w[i] = this.world[i];
        w[11] = this.diagnostics;
        const eye = new Vector3(this.eye[0], this.eye[1], this.eye[2]);
        const mats = this.shadow.matrices;
        const shadowMats: Matrix[] = [];
        for (let k = 0; k < 4; k++) shadowMats.push(Matrix.FromArray(mats, k * 16));
        for (const m of this.all) {
            m.setArray4("u_world", w);
            m.setVector3("u_eye", eye);
        }
        for (const m of this.receivers) {
            m.setMatrices("u_shadowMats", shadowMats);
            m.setVector4("u_shadowTexel", Vector4From(this.shadow.texel));
            m.setVector4("u_shadowParams", Vector4From(this.shadow.params));
        }
        const territory = Array.from(this.territory);
        for (const m of this.territorial) m.setArray4("u_territory", territory);
    }

    /** Draws one frame. */
    render(): void {
        const t0 = this.gpu ? performance.now() : 0;
        this.bindUniforms();
        this.scene.render();
        this.gpu?.poll();
        if (this.gpu) this.cpuRenderMs = performance.now() - t0;
    }
    cpuRenderMs = 0;
}

function Vector4From(a: Float32Array): Vector4 { return new Vector4(a[0], a[1], a[2], a[3]); }
