// Everything the game runs on, in one place (what the Entropy engine and its addon API were):
// the Babylon renderer and its sun shadows, the mesh cache and mesh workers, the Earth (terrain and
// city streaming), the UI canvas, input, and the campaign save.

import { Renderer, type MaterialKind } from "./renderer";
import { SunShadows } from "./shadows";
import { Drawable, geometryMask, makeGeometry } from "./drawables";
import { MeshCache } from "./mesh_cache";
import { WorkerPool } from "./workers";
import { GeometryRegistry, babylonInstances } from "./instances";
import { TerrainMeshes } from "./terrain";
import { CanvasUi } from "./ui";
import { Input } from "./input";
import { SaveStore } from "./saves";
import { bakeClouds, loadMaterialArrays, placeholderMaterials } from "./textures";
import { EarthSystem, loadBaseTile } from "../quadplanet/earth/system";
import type { CityConfig } from "../quadplanet/earth/city";
import type { PlanetDef } from "../quadplanet/qp_planet";
import type { CityModel, HouseJob } from "../quadplanet/qp_city";
import type { InstanceEngine } from "../quadplanet/qp_instances";
import type { ModelMesh } from "../quadplanet/qp_models";
import type { MaterialLoad } from "../game/al_materials";
import type { RenderTargetTexture } from "@babylonjs/core/Materials/Textures/renderTargetTexture";

const BASE = import.meta.env.BASE_URL;

export class Platform {
    earth!: EarthSystem;
    terrain: TerrainMeshes;
    readonly geometries: GeometryRegistry;
    cloudAtlas: RenderTargetTexture | null = null;
    /** Per-phase frame timings, when the page was opened with ?profile. */
    readonly profiling = new URLSearchParams(location.search).has("profile");
    readonly profile = new Map<string, { total: number; count: number; max: number }>();
    private sweepAt = 0;

    private constructor(
        readonly renderer: Renderer,
        readonly shadows: SunShadows,
        readonly meshCache: MeshCache,
        readonly workers: WorkerPool,
        readonly ui: CanvasUi,
        readonly input: Input,
        readonly saves: SaveStore,
    ) {
        this.geometries = new GeometryRegistry(renderer.scene, meshCache);
        this.terrain = new TerrainMeshes(renderer.scene, g => renderer.variant("terrain", geometryMask(g)));
    }

    static async create(world: HTMLCanvasElement, uiCanvas: HTMLCanvasElement): Promise<Platform> {
        const renderer = new Renderer(world);
        const shadows = new SunShadows(renderer.scene, renderer);
        const workers = new WorkerPool();
        const [meshCache, saves] = await Promise.all([MeshCache.open(workers), SaveStore.open()]);
        const p = new Platform(renderer, shadows, meshCache, workers, new CanvasUi(uiCanvas), new Input(world), saves);
        for (const [map, a] of Object.entries(placeholderMaterials(renderer.engine, renderer.scene))) renderer.setTexture(`mat_${map}`, a.texture);
        p.cloudAtlas = await bakeClouds(renderer.engine, renderer.scene);
        if (p.cloudAtlas) renderer.setTexture("cloud_atlas", p.cloudAtlas);
        else {
            // No half-float target: any 2D texture keeps the sampler valid; the shader goes procedural.
            renderer.setTexture("cloud_atlas", placeholderMaterials(renderer.engine, renderer.scene).basecolor.texture);
        }
        return p;
    }

    /** Starts Earth (its worker, the elevation pyramid, the city). */
    async createEarth(config: { planet: PlanetDef; city?: CityConfig; splitFactor?: number; minLevel?: number; triangleBudget?: number }): Promise<void> {
        this.earth = new EarthSystem({ planet: config.planet, baseTile: await loadBaseTile(`${BASE}terrarium_z0.png`), city: config.city, splitFactor: config.splitFactor, minLevel: config.minLevel, triangleBudget: config.triangleBudget });
    }

    /** Loads the material maps and binds them to every world material. */
    async loadMaterials(progress?: (done: number, total: number) => void): Promise<MaterialLoad> {
        const { arrays, load } = await loadMaterialArrays(this.renderer.engine, this.renderer.scene, BASE, undefined, progress);
        for (const [map, a] of Object.entries(arrays)) this.renderer.setTexture(`mat_${map}`, a.texture);
        return load;
    }

    /** A single object (the engine's Model.createMesh): its own geometry, one record, always drawn while shown. */
    spawn(id: string, mesh: ModelMesh, kind: MaterialKind, casterCascades: number): Drawable {
        const r = this.renderer;
        const g = makeGeometry(r.scene, `${id}-geometry`, new Float32Array(mesh.vertexData), new Uint32Array(mesh.indexData));
        const d = new Drawable(r.scene, id, g, { material: r.variant(kind, geometryMask(g)), ownsGeometry: true, casterCascades });
        d.setBounds(null, -1);
        if (casterCascades > 0) this.shadows.addCaster(d, kind === "people" ? r.materials.peopleCaster : r.materials.sceneCaster);
        return d;
    }

    /** Instanced batches of a cached-mesh namespace (the engine's MeshCache.createMesh with instances). */
    instances(namespace: string, kind: MaterialKind, casterCascades: number, recordFloats: number): InstanceEngine {
        const r = this.renderer;
        return babylonInstances(r.scene, this.geometries, this.shadows, () => ({
            namespace, material: g => r.variant(kind, geometryMask(g)), caster: kind === "people" ? r.materials.peopleCaster : r.materials.sceneCaster, casterCascades, recordFloats,
        }));
    }

    /**
     * Evaluates a city model in a mesh worker and caches the LODs a job wants (qp_city.ts
     * generateInBackground): returns the job id CityHouses polls.
     */
    generateCity(model: CityModel, job: HouseJob): number | null {
        const { id, done } = this.workers.run({ kind: "city", model: model.kind, values: job.values, lod0: !!job.lod0Key, lod1: !!job.lod1Key });
        done.then(r => {
            if (r.kind !== "city") return;
            if (r.lod0 && job.lod0Key) this.meshCache.store(model.namespace, job.lod0Key, r.lod0.vertexData, r.lod0.indexData, { generator: model.generator });
            if (r.lod1 && job.lod1Key) this.meshCache.store(model.namespace, job.lod1Key, r.lod1.vertexData, r.lod1.indexData, { generator: model.generator, simplifiedFrom: r.lod1.sourceTriangles });
        }, () => undefined);
        return id;
    }

    /** The view ray through a screen point (CSS pixels on a W x H window), in world directions. */
    screenToWorldRay(x: number, y: number, W: number, H: number): [number, number, number] {
        const cam = this.renderer.camera;
        const tanY = Math.tan(cam.fov / 2), tanX = tanY * (W / Math.max(1, H));
        const cx = (2 * x / W - 1) * tanX, cy = (1 - 2 * y / H) * tanY;
        // The view matrix's rows are the camera's right, up and back axes (right-handed, looking down -Z).
        const m = cam.view.m;
        const right = [m[0], m[4], m[8]], up = [m[1], m[5], m[9]], back = [m[2], m[6], m[10]];
        const d = [right[0] * cx + up[0] * cy - back[0], right[1] * cx + up[1] * cy - back[1], right[2] * cx + up[2] * cy - back[2]];
        const l = Math.hypot(d[0], d[1], d[2]);
        return [d[0] / l, d[1] / l, d[2] / l];
    }

    profileRecord(phase: string, ms: number): void {
        const e = this.profile.get(phase) ?? { total: 0, count: 0, max: 0 };
        e.total += ms; e.count++; e.max = Math.max(e.max, ms);
        this.profile.set(phase, e);
    }

    /** Draws the frame. */
    render(): void {
        const t0 = this.profiling ? performance.now() : 0;
        this.renderer.render();
        if (this.profiling) this.profileRecord("render", performance.now() - t0);
        const now = performance.now();
        if (now > this.sweepAt) { this.sweepAt = now + 5000; this.geometries.sweep(); }
    }
}
