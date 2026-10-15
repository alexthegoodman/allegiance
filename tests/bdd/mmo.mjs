// tests/features/mmo_two_players.feature, driven in two headless Chromes. Needs, already running:
//   indie-machine:        npx prisma dev --name allegiance --detach ; npx next dev -p 3000
//   allegiance-realtime:  npx wrangler dev --port 8787
// The game's own Vite server is started here. Screenshots go to test-artifacts/mmo/.
//   node tests/bdd/mmo.mjs
import { mkdirSync } from "node:fs";
import { startServer, launch } from "./harness.mjs";

const API = "http://localhost:3000/api/allegiance";
const REALTIME = "http://localhost:8787/health";
const OUT = "test-artifacts/mmo";
mkdirSync(OUT, { recursive: true });

const LONDON = { lat: 51.5074, lon: -0.1278 };
let failures = 0;
const step = async (name, fn) => {
    const t0 = Date.now();
    try { await fn(); console.log(`  ok   ${name} (${((Date.now() - t0) / 1000).toFixed(1)} s)`); }
    catch (e) { failures++; console.log(`  FAIL ${name}: ${e.message}`); throw e; }
};
const assert = (ok, msg) => { if (!ok) throw new Error(msg); };

const tool = (page, name, args = {}) => page.evaluate(([n, a]) => window.allegiance.tool(n, a), [name, args]);
const state = page => tool(page, "allegiance_state");
async function until(page, pred, what, ms = 30000) {
    const t0 = Date.now();
    let s;
    while (Date.now() - t0 < ms) {
        s = await state(page);
        if (pred(s)) return s;
        await page.waitForTimeout(250);
    }
    throw new Error(`timed out waiting for ${what}; online=${JSON.stringify(s?.online)?.slice(0, 600)} toasts=${JSON.stringify(s?.toasts)}`);
}
async function boot(page, url) {
    await page.goto(url);
    await page.waitForFunction(() => window.allegiance?.ready, null, { timeout: 120000 });
}

// Preflight: the servers this feature needs.
for (const [name, url, init] of [["Indie Machine API", `${API}/session`, { method: "POST" }], ["allegiance-realtime", REALTIME, {}]]) {
    try { const r = await fetch(url, init); if (!r.ok) throw new Error(`HTTP ${r.status}`); } catch (e) {
        console.error(`${name} is not running at ${url} (${e.message}). See the header of this file.`);
        process.exit(2);
    }
}

const server = await startServer(Number(process.env.BDD_PORT ?? 5190));
const a = await launch({ width: 1280, height: 720 });
const b = await launch({ width: 1280, height: 720 });
try {
    console.log("Scenario: The title says plainly when the server can't be reached");
    await step("title shows the outage and RETRY", async () => {
        const c = await launch({ width: 1280, height: 720 });
        try {
            await c.page.route("http://localhost:3000/**", r => r.abort("connectionrefused"));
            await boot(c.page, server.url);
            const s = await until(c.page, x => x.online?.phase === "error" && x.ui.buttons.includes("title-retry"), "the error title");
            assert(/Can't reach the Allegiance server/.test(s.online.problem), `problem: ${s.online.problem}`);
            assert(s.ui.buttons.includes("title-retry") && !s.ui.buttons.includes("title-new"), `buttons: ${s.ui.buttons}`);
            await c.page.waitForTimeout(500);
            await c.page.screenshot({ path: `${OUT}/00-unreachable.png` });
        } finally { await c.browser.close(); }
    });

    console.log("Scenario: An anonymous player founds a nation");
    await step("Ada's title offers New Nation / New Party", async () => {
        await boot(a.page, server.url);
        const s = await until(a.page, x => x.online?.phase === "ready" && x.ui.buttons.includes("title-new"), "Ada's title");
        assert(s.online.player.anonymous && !s.online.nation, `player ${JSON.stringify(s.online.player)}`);
        assert(s.ui.buttons.includes("title-new"), `buttons ${s.ui.buttons}`);
        await a.page.waitForTimeout(800);
        await a.page.screenshot({ path: `${OUT}/01-title.png` });
    });
    await step("Ada founds Dawn Front in London and joins its room", async () => {
        await tool(a.page, "allegiance_new", { hometown: "London", ...LONDON, party: "Dawn Front", leader: "Ada", mission: false, color: 0 });
        await tool(a.page, "allegiance_settle", { timeoutMs: 180000 });
        const s = await until(a.page, x => x.online?.net.room === "open" && x.online?.net.world === "open", "Ada's sockets", 30000);
        assert(s.online.nation.name === "Dawn Front", `nation ${s.online.nation?.name}`);
    });

    console.log("Scenario: A second player arrives and they see each other");
    await step("Mara founds Iron Choir in London and walks 14 m north", async () => {
        await boot(b.page, server.url);
        await until(b.page, x => x.online?.phase === "ready", "Mara's session");
        await tool(b.page, "allegiance_new", { hometown: "London", ...LONDON, party: "Iron Choir", leader: "Mara", mission: false, color: 3 });
        await tool(b.page, "allegiance_settle", { timeoutMs: 180000 });
        await until(b.page, x => x.online?.net.room === "open", "Mara's room");
        await tool(b.page, "allegiance_act", { action: "walk", dx: 0, dz: 14 });
    });
    await step("Ada sees Mara, and Mara sees Ada", async () => {
        await tool(a.page, "allegiance_act", { action: "face", yaw: 0, pitch: -0.05 });
        await tool(a.page, "allegiance_act", { action: "view", distance: 5, firstPerson: false });
        const sa = await until(a.page, x => x.online?.remotes.some(r => r.leader === "Mara" && r.nation === "Iron Choir"), "Mara in Ada's room");
        await until(b.page, x => x.online?.remotes.some(r => r.leader === "Ada"), "Ada in Mara's room");
        assert(sa.online.net.online >= 2, `online count ${sa.online.net.online}`);
        await a.page.waitForTimeout(1500);
        await a.page.screenshot({ path: `${OUT}/02-ada-sees-mara.png` });
    });

    console.log("Scenario: A street fight is refereed by the room");
    await step("Mara fires a rifle at Ada; Ada is hit", async () => {
        const before = (await state(a.page)).campaign.health;
        await tool(b.page, "allegiance_act", { action: "equip", weapon: "rifle" });
        await tool(b.page, "allegiance_act", { action: "face", yaw: Math.PI, pitch: 0 });
        await tool(b.page, "allegiance_act", { action: "view", distance: 0, firstPerson: true });
        await b.page.waitForTimeout(400);
        let hit = null;
        for (let i = 0; i < 6 && !hit; i++) {
            await tool(b.page, "allegiance_act", { action: "shoot" });
            await b.page.waitForTimeout(400);
            const s = await state(a.page);
            if (s.toasts.some(t => /Mara shot you/.test(t))) hit = s;
        }
        assert(hit, "Ada was never told she was shot");
        await b.page.screenshot({ path: `${OUT}/03-mara-fires.png` });
        await a.page.screenshot({ path: `${OUT}/04-ada-hit.png` });
        const after = await until(a.page, x => x.campaign.health < before, "Ada's health to drop", 5000);
        console.log(`       Ada's health ${before} -> ${after.campaign.health}`);
    });

    console.log("Scenario: Territory taken from another player");
    let home;
    await step("Ada takes her home town; Mara's map shows it ruled by Dawn Front", async () => {
        const s = await state(a.page);
        home = s.settlements.find(d => d.name === "London");
        assert(home, `no London settlement in ${JSON.stringify(s.settlements)}`);
        await tool(a.page, "allegiance_online", { action: "claim-test", region: home.id, army: 300 });
        await until(b.page, x => x.settlements.some(d => d.id === home.id && d.governor.startsWith("nation-")), "Dawn Front on Mara's map");
    });
    await step("Mara seizes it with a far larger army; Ada is told", async () => {
        await tool(b.page, "allegiance_online", { action: "claim-test", region: home.id, army: 300000 });
        const s = await until(a.page, x => x.toasts.some(t => /Iron Choir has seized London/.test(t)), "Ada's seized toast", 15000);
        assert(s.settlements.find(d => d.id === home.id).governor.startsWith("nation-"), "Ada's map still shows her party");
        await a.page.screenshot({ path: `${OUT}/05-ada-loses-london.png` });
    });

    console.log("Scenario: An anonymous player keeps their nation with an account");
    await step("Ada creates an account from the HUD", async () => {
        await tool(a.page, "allegiance_click", { id: "hud-account" });
        await a.page.waitForSelector("#allegiance-account form", { timeout: 5000 });
        const email = `ada-${Date.now()}@example.com`;
        await a.page.fill("#al-email", email);
        await a.page.fill("#al-password", "dawn front forever");
        await a.page.screenshot({ path: `${OUT}/06-account-dialog.png` });
        await a.page.click("[data-submit]");
        await a.page.waitForSelector("#allegiance-account", { state: "detached", timeout: 10000 });
        const s = await until(a.page, x => x.online?.player && !x.online.player.anonymous, "Ada's account");
        assert(s.online.player.email === email && s.online.nation.name === "Dawn Front", JSON.stringify(s.online.player));
    });
} catch {
    // The failing step has printed why.
} finally {
    for (const [who, x] of [["Ada", a], ["Mara", b]]) {
        const errors = x.logs.filter(l => /error|pageerror/i.test(l));
        if (errors.length) console.log(`--- ${who}'s console errors ---\n${errors.slice(-15).join("\n")}`);
    }
    await a.browser.close();
    await b.browser.close();
    await server.close();
}
console.log(failures ? `${failures} step(s) failed` : "all steps passed");
process.exit(failures ? 1 : 0);
