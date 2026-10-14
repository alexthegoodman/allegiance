// A rendering smoke test: Earth from orbit through the world shader (no game).
import { Renderer } from "./engine/renderer";
import { SunShadows } from "./engine/shadows";
import { TerrainMeshes } from "./engine/terrain";
import { Drawable, makeGeometry } from "./engine/drawables";
import { bakeClouds, placeholderMaterials } from "./engine/textures";
import { EarthSystem, loadBaseTile } from "./quadplanet/earth/system";
import { PLANETS, isEarth, type PlanetDef } from "./quadplanet/qp_planet";
import { packWorld } from "./quadplanet/qp_shader";
import { buildSky } from "./quadplanet/qp_models";
import { normalize, scale, sub } from "./quadplanet/qp_math";

export async function smoke(canvas: HTMLCanvasElement): Promise<void> {
    const r = new Renderer(canvas);
    (window as any).BABYLON_SCENE = r.scene;
    const noShadow = new URLSearchParams(location.search).has("noshadow");
    const shadows = noShadow ? null : new SunShadows(r.scene, r);
    if (new URLSearchParams(location.search).has("nortt")) r.scene.customRenderTargets.length = 0;
    const mats = placeholderMaterials(r.engine, r.scene);
    for (const [k, a] of Object.entries(mats)) r.setTexture(`mat_${k}`, a.texture);
    const clouds = await bakeClouds(r.engine, r.scene);
    if (clouds) r.setTexture("cloud_atlas", clouds);
    const earthDef: PlanetDef = { ...PLANETS.find(isEarth)!, center: [0, 0, 0] };
    const earth = new EarthSystem({ planet: earthDef, baseTile: await loadBaseTile("/terrarium_z0.png") });
    const terrain = new TerrainMeshes(r.scene, () => r.materials.terrain);
    const sky = buildSky();
    const skyD = new Drawable(r.scene, "sky", makeGeometry(r.scene, "sky", new Float32Array(sky.vertexData), new Uint32Array(sky.indexData)), { material: r.materials.scene, ownsGeometry: true });
    skyD.setItem([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], [1, 1, 1, 0], [0, 0, 0, 0]);
    skyD.setBounds(null, -1);
    skyD.setCount(1);
    let angle = 0.6;
    let u0: unknown = null;
    const errors: string[] = [];
    (window as unknown as { smokeState: unknown }).smokeState = () => ({ tex: Object.entries((r.materials.scene as any)._textures).map(([k, t]: any) => [k, t.isReady(), t.getClassName(), !!t._texture, t._texture?.isReady]), mats: Object.entries(r.materials).map(([k, m]) => [k, m.isReady(skyD.mesh, true), (m as any)._drawWrapper?.effect?.isReady(), (m as any)._drawWrapper?.effect?.getCompilationError?.()?.slice(0, 600)]), glError: (r.engine as any)._gl.getError(), meshes: r.scene.meshes.length, active: r.scene.getActiveMeshes().length, chunks: terrain.chunkCount, errors, stats: u0, elevation: earth.workerElevation, err: earth.lastError });
    r.engine.runRenderLoop(() => {
        angle += 0.002;
        const dir = normalize([Math.sin(angle), 0.35, Math.cos(angle)]);
        const sun = normalize([dir[0] + 0.4, dir[1] + 0.3, dir[2]]);
        const pos = scale(dir, earthDef.radius * 2.7);
        const origin: [number, number, number] = [Math.round(pos[0]), Math.round(pos[1]), Math.round(pos[2])];
        const u = earth.update(pos, { maxBuilds: 20 });
        terrain.apply(u, origin);
        u0 = u.stats;
        r.world = packWorld({ sunDir: sun, time: performance.now() / 1000, sunColor: [1, 0.96, 0.9], exposure: 1.05, debugLod: new URLSearchParams(location.search).has("dbg"),
            planets: [{ center: sub(earthDef.center, origin), radius: earthDef.radius, atmosphere: earthDef.atmosphereColor, atmosphereHeight: earthDef.atmosphereHeight }] });
        r.world[9] = Number(new URLSearchParams(location.search).get("dbg") ?? 0);
        shadows?.update(null);
        r.setCamera(sub(pos, origin), sub([0, 0, 0], origin), [0, 1, 0]);
        r.render();
    });
}
