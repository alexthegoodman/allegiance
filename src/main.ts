// Allegiance in the browser: sets up the platform (engine/platform.ts), starts the game and runs a
// frame per animation frame. window.allegiance exposes the game's tools (the MCP tools the
// original's live tests drove) for the BDD features: allegiance.tool(name, args).

import { Platform } from "./engine/platform";
import { loadFonts } from "./engine/ui";
import { start, tick, runTool, toolList } from "./game/allegiance";

declare global {
    interface Window {
        allegiance?: { tool: (name: string, args?: Record<string, unknown>) => Promise<object>; tools: typeof toolList; ready: boolean; platform: Platform; tick: () => void };
    }
}

async function boot(): Promise<void> {
    const world = document.getElementById("world") as HTMLCanvasElement;
    const ui = document.getElementById("ui") as HTMLCanvasElement;
    if (new URLSearchParams(location.search).has("smoke")) {
        const { smoke } = await import("./smoke");
        return smoke(world);
    }
    await loadFonts();
    const platform = await Platform.create(world, ui);
    await start(platform);
    window.allegiance = { tool: runTool, tools: toolList, ready: true, platform, tick };
    platform.renderer.engine.runRenderLoop(tick);
    world.focus();
}

boot().catch(e => {
    console.error(e);
    document.body.insertAdjacentHTML("beforeend", `<pre style="position:fixed;left:16px;top:16px;color:#f66;font:14px monospace;white-space:pre-wrap">Allegiance could not start: ${String((e as Error)?.message ?? e)}</pre>`);
});
