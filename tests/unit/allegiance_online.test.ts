// Allegiance online: the campaign follows the server's territory map (al_net.ts), the session
// claims what the party takes and puts back what a claim lost (al_online.ts), remote players are
// interpolated (net/realtime.ts), and the title screen says plainly when the server is down.
import { describe, expect, it } from "vitest";
import { newCampaign } from "../../src/game/al_state";
import { PARTY, factionById, isNationFaction } from "../../src/game/al_data";
import { takeRegion, advanceDay } from "../../src/game/al_world";
import { applyRows, applyUnknown, hexToRgba, holdings, nationFaction, rgbaToHex } from "../../src/game/al_net";
import { Online } from "../../src/game/al_online";
import { Realtime, RENDER_DELAY_MS } from "../../src/net/realtime";
import type { ClaimRequest, ClaimResponse, NationSummary, TerritoryRow } from "../../src/net/protocol";
import { Painter } from "../../src/game/al_ui";
import { UiFrame, drawScreen, type GameView } from "../../src/game/al_screens";

const ME = "me";
const RIVAL: NationSummary = { id: "rival", name: "Iron Choir", leader: "Mara", ideology: "order", color: "#3355aa" };

function row(regionId: string, nation: NationSummary | null, extra: Partial<TerritoryRow> = {}): TerritoryRow {
    return { regionId, name: regionId, kind: "city", lat: 51.5, lon: -0.12, pop: 70, nation, aiGovernor: "concordat", gov: "democracy", army: 4000, support: 0.4, takenAt: null, updatedAt: new Date().toISOString(), ...extra };
}

const campaign = () => newCampaign({ seed: 7, spawn: "london", partyName: "Dawn Front", leader: "Ada" });

describe("the territory map", () => {
    it("colors convert both ways", () => {
        expect(rgbaToHex(hexToRgba("#3355aa"))).toBe("#3355aa");
    });

    it("another nation's row takes the region from the party, quietly, with its troops and support", () => {
        const c = campaign();
        const rs = c.regions.paris;
        rs.army = 500;
        takeRegion(c, rs, "war");
        expect(rs.governor).toBe(PARTY);
        const quiet = { on: false };
        const r = applyRows(c, [row("paris", RIVAL)], ME, quiet);
        expect(r.changed).toEqual(["paris"]);
        expect(rs.governor).toBe(nationFaction("rival"));
        expect(isNationFaction(rs.governor)).toBe(true);
        expect(factionById(rs.governor).name).toBe("Iron Choir");
        expect(rs.garrison).toBe(4000);
        expect(rs.support[rs.governor]).toBeCloseTo(0.4, 5);
        expect(Object.values(rs.support).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6);
        expect(c.news[0].text).toMatch(/seized by Iron Choir/);
        expect(quiet.on).toBe(false);
    });

    it("your own row makes you governor; a regime row hands a nation's region back", () => {
        const c = campaign();
        applyRows(c, [row("berlin", { ...RIVAL, id: ME, name: "Dawn Front" })], ME, { on: false });
        expect(c.regions.berlin.governor).toBe(PARTY);
        applyRows(c, [row("madrid", RIVAL)], ME, { on: false });
        applyRows(c, [row("madrid", null, { aiGovernor: "vanguard" })], ME, { on: false });
        expect(c.regions.madrid.governor).toBe("vanguard");
        expect(c.regions.madrid.support[nationFaction("rival")]).toBeUndefined();
    });

    it("holdings report troops and support; unknown ids go back to the regime", () => {
        const c = campaign();
        const rs = c.regions.rome;
        rs.army = 120;
        takeRegion(c, rs, "war");
        expect(holdings(c)).toEqual([{ id: "rome", army: 120, support: expect.any(Number), gov: rs.gov }]);
        expect(applyUnknown(c, ["rome"], { on: false })).toEqual(["Rome"]);
        expect(rs.governor).toBe("concordat");
    });

    it("a regime's election never unseats another nation in your sim", () => {
        const c = campaign();
        applyRows(c, [row("london", RIVAL, { support: 0.01 })], ME, { on: false });
        const rs = c.regions.london;
        rs.electionIn = 1;
        advanceDay(c, null);
        expect(rs.governor).toBe(nationFaction("rival"));
    });
});

/** A stand-in for the Indie Machine API. */
function fakeServer(decide: (req: ClaimRequest) => ClaimResponse) {
    const calls: { path: string; body: unknown }[] = [];
    const fetcher = (async (url: string, init?: RequestInit) => {
        const path = String(url).replace("http://api", "");
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        calls.push({ path, body });
        const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
        if (path === "/session") return json({ token: "t", player: { id: "p", email: null, anonymous: true }, nation: { ...RIVAL, id: ME, name: "Dawn Front", homeName: "London", homeLat: 51.5, homeLon: -0.12, foundedAt: "", savedAt: null } });
        if (path.startsWith("/territories?") || path === "/territories") return json({ rows: [], now: new Date().toISOString(), more: false });
        if (path === "/territories/report") return json({ rows: [], unknown: [] });
        if (path === "/territories/claim") return json(decide(body));
        if (path === "/ticket") return json({ error: { code: "x", message: "no realtime in this test" } }, 503);
        return json({ error: { code: "nf", message: "not found" } }, 404);
    }) as typeof fetch;
    let token: string | null = null;
    return { calls, fetcher, tokens: { get: () => token, set: (t: string | null) => { token = t; } } };
}

class NoSocket { constructor() { throw new Error("no sockets in unit tests"); } }

describe("the online session", () => {
    it("claims what the party takes, and puts back a claim another nation repelled", async () => {
        const c = campaign();
        const toasts: string[] = [];
        const srv = fakeServer(req => ({ ok: false, message: "Iron Choir holds Paris. Your army was beaten back.", army: Math.round(req.army * 0.4), row: row("paris", RIVAL, { army: 900 }) }));
        const online = new Online({ campaign: () => c, toast: t => toasts.push(t), hit: () => {}, shot: () => {}, territoryChanged: () => {} },
            { base: "http://api", tokens: srv.tokens, fetcher: srv.fetcher, Socket: NoSocket as never });
        await online.connect();
        expect(online.phase).toBe("ready");
        await online.enterWorld(c);
        const rs = c.regions.paris;
        rs.army = 1000;
        takeRegion(c, rs, "war");
        await online.settled();
        const claim = srv.calls.find(x => x.path === "/territories/claim")!.body as ClaimRequest;
        expect(claim).toMatchObject({ how: "war", previous: "concordat", army: 1000, region: { id: "paris", name: "Paris" } });
        expect(rs.governor).toBe(nationFaction("rival"));
        expect(rs.army).toBe(400);
        expect(toasts).toContain("Iron Choir holds Paris. Your army was beaten back.");
        online.leaveWorld();
    });

    it("an unreachable server is an error the title screen shows, with a retry", async () => {
        const fetcher = (async () => { throw new TypeError("Failed to fetch"); }) as typeof fetch;
        const online = new Online({ campaign: () => null, toast: () => {}, hit: () => {}, shot: () => {}, territoryChanged: () => {} },
            { base: "http://api", tokens: { get: () => null, set: () => {} }, fetcher, Socket: NoSocket as never });
        await online.connect();
        expect(online.phase).toBe("error");
        expect(online.problem).toMatch(/Can't reach the Allegiance server at http:\/\/api/);
        const { ids, strings } = renderTitle(online.view());
        expect(ids).toContain("title-retry");
        expect(ids).not.toContain("title-new");
        expect(strings).toContain("THE ALLEGIANCE SERVER IS UNREACHABLE");
    });

    it("an expired session offers sign-in or a fresh anonymous start", async () => {
        const fetcher = (async () => new Response(JSON.stringify({ error: { code: "unauthorized", message: "This session has expired. Sign in again." } }), { status: 401 })) as typeof fetch;
        const online = new Online({ campaign: () => null, toast: () => {}, hit: () => {}, shot: () => {}, territoryChanged: () => {} },
            { base: "http://api", tokens: { get: () => "old", set: () => {} }, fetcher, Socket: NoSocket as never });
        await online.connect();
        expect(online.phase).toBe("expired");
        expect(renderTitle(online.view()).ids).toEqual(expect.arrayContaining(["title-signin", "title-anonymous"]));
    });

    it("ready: New Nation / New Party, and Continue when the player has a nation", async () => {
        const srv = fakeServer(() => { throw new Error("unused"); });
        const online = new Online({ campaign: () => null, toast: () => {}, hit: () => {}, shot: () => {}, territoryChanged: () => {} },
            { base: "http://api", tokens: srv.tokens, fetcher: srv.fetcher, Socket: NoSocket as never });
        await online.connect();
        const { strings, painter } = renderTitle(online.view(), true);
        expect(strings).toContain("NEW NATION / NEW PARTY");
        expect(strings).not.toContain("NEW CAMPAIGN");
        expect(painter.buttons.find(b => b.id === "title-continue")!.disabled).toBeFalsy();
        expect(strings).toContain("PLAYING ANONYMOUSLY ON THIS DEVICE");
    });
});

function renderTitle(online: GameView["online"], hasSave = false) {
    const log = { strings: [] as string[] };
    const painter = new Painter({ clear: () => { log.strings = []; }, rect: () => {}, text: o => { log.strings.push(o.s); } });
    const ui = new UiFrame(painter, 1600, 900);
    const g = { mode: "title", tab: "overview", c: null, setup: { party: "", leader: "", ideology: "solidarity", color: 0, spawn: null, focus: null },
        loading: { progress: 0, stage: "", lines: [], tip: "", place: "", elapsed: 0 }, speech: null, dialogue: null, toasts: [], region: null, selectedRegion: null,
        selectedMember: null, memberPage: 0, prompt: null, street: { civilians: 0, listeners: 0, soldiers: 0, followers: 0, rally: null, rallyTime: 0 },
        weapon: { name: "", mag: 0, reserve: 0, reloading: false, magazine: 0 }, pamphlet: "propaganda", stamina: 1, armor: 0, land: null, hasSave, time: 0,
        firstPerson: false, debug: null, online, act: () => {} } as GameView;
    painter.begin();
    drawScreen(g, ui);
    painter.flush();
    return { ids: painter.buttons.map(b => b.id), strings: log.strings, painter };
}

describe("remote players", () => {
    it("are drawn between the two states around 150 ms ago", () => {
        let now = 0;
        const sockets: { listeners: Record<string, ((e: unknown) => void)[]> }[] = [];
        class FakeSocket {
            listeners: Record<string, ((e: unknown) => void)[]> = {};
            constructor() { sockets.push(this); }
            addEventListener(k: string, f: (e: unknown) => void) { (this.listeners[k] ??= []).push(f); }
            send() {}
            close() {}
        }
        const api = { ticket: async () => ({ ticket: "x", url: "ws://rt", expiresAt: "" }) } as never;
        const rt = new Realtime(api, { territory() {}, event() {}, hit() {}, shot() {}, problem() {} }, FakeSocket as never, () => now);
        // Drive the room socket by hand.
        (rt as unknown as { stopped: boolean }).stopped = false;
        const link = { ws: new FakeSocket(), status: "open" as const, cell: "1_1" };
        (rt as unknown as { room: unknown }).room = link;
        const msg = (m: unknown) => (rt as unknown as { onMessage: (k: string, l: unknown, t: string) => void }).onMessage("room", link, JSON.stringify(m));
        const p = (lat: number, at: number) => ({ id: "b", nid: "n", leader: "Mara", nation: "Iron Choir", color: "#3355aa", lat, lon: 0, alt: 0, yaw: 0, mode: "foot", speed: 4, health: 100, weapon: "rifle", at });
        msg({ t: "welcome", you: "a", room: "1_1", players: [] });
        now = 1000; msg({ t: "state", p: p(10, 1000) });
        now = 1100; msg({ t: "state", p: p(11, 1100) });
        now = 1100 + RENDER_DELAY_MS - 50;
        const [r] = rt.remotes();
        expect(r.leader).toBe("Mara");
        expect(r.lat).toBeCloseTo(10.5, 5);
        msg({ t: "leave", id: "b" });
        expect(rt.remotes()).toEqual([]);
    });
});
