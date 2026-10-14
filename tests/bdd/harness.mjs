// Starts the Vite dev server and drives the game in the installed Chrome (Playwright), for the BDD
// features and for screenshots. Chrome runs headless with its GPU (ANGLE on D3D11 on Windows).

import { createServer } from "vite";
import { chromium } from "playwright";

export async function startServer(port = 5190) {
    const server = await createServer({ configFile: "vite.config.ts", server: { port, strictPort: true }, logLevel: "warn" });
    await server.listen();
    return { url: `http://localhost:${port}/`, close: () => server.close() };
}

export async function launch({ headless = true, width = 1600, height = 900 } = {}) {
    const args = ["--ignore-gpu-blocklist", "--enable-gpu-rasterization", "--use-angle=d3d11", "--enable-unsafe-swiftshader"];
    const browser = await chromium.launch({ channel: "chrome", headless, args });
    const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
    const page = await context.newPage();
    const logs = [];
    page.on("console", m => logs.push(`[${m.type()}] ${m.text()}`));
    page.on("pageerror", e => logs.push(`[pageerror] ${e.message}`));
    return { browser, context, page, logs };
}
