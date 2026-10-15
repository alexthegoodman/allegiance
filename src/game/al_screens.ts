// Every screen of Allegiance, drawn with the propaganda UI kit (al_ui.ts) from a GameView - the
// addon implements it; the tests use a stand-in. Buttons call `g.act(name, arg)`.

import {
    ARMORS, BLOCS, COUNTRIES, FACILITIES, IDEOLOGIES, PAMPHLETS, PARTY, PARTY_COLORS, REGIONS, SCHEMES, SKILLS, SKILL_MAX, TOPICS, WEAPONS,
    countryOf, factionById, ideologyById, regionDefById, skillCost, weaponById, type RegionDef,
} from "./al_data";
import { angularDistance, campaignRegions, regionAt, type Campaign, dateLabel, karmaTitle, partyShare, totalMembers, strongestRival, INNER_CIRCLE, type Member } from "./al_state";
import {
    ROLE_NAMES, orgReport, holder, maxHealth, xpForLevel, followers, followerLimit, ammoPrice, pamphletPrice, schemeChance,
    schemeCost, hasFacility, ARM_COST, blocOf, troopsAvailable,
} from "./al_party";
import { controlLevel, coupChance, electionCost, governedShare, travelCost, worldSupport, DAY_SECONDS, VICTORY_SHARE } from "./al_world";
import { BEATS, HECKLE_KEYS, type SpeechState } from "./al_speech";
import { opinionLabel } from "./al_street";
import { missionObjective } from "./al_mission";
import { type MiniMap, type ScreenMarker } from "./al_markers";
import { ITEMS, itemById, inventory, shopStock, carTier, type ShopKind } from "./al_items";
import { CAR_UPGRADES, carSpec } from "./al_vehicle";
import type { OnlineView } from "./al_online";
import { type ButtonOpts, type ButtonStyle, type Color, type Painter, FONT, THEME, big, fmt, money, pct, textWidth, withAlpha } from "./al_ui";

export type Mode = "title" | "setup" | "loading" | "play" | "console" | "speech" | "dialogue" | "outcome" | "shop";
export type ConsoleTab = "overview" | "organization" | "territory" | "armory" | "skills" | "inventory";

export interface SetupState {
    party: string;
    leader: string;
    ideology: string;
    color: number;
    spawn: string | null;
    focus: "party" | "leader" | "hometown" | null;
    hometownQuery?: string;
    hometown?: { name: string; lat: number; lon: number; kind?: string };
    places?: Array<{ name: string; lat: number; lon: number; kind: string }>;
}

export interface LoadingInfo {
    progress: number;
    stage: string;
    lines: string[];
    tip: string;
    place: string;
    elapsed: number;
}

export interface DialogueState {
    actorId: number;
    name: string;
    segment: string;
    opinion: number;
    lean: string;
    member: boolean;
    follower: boolean;
    orator: boolean;
    reply: string;
    recruitChance: number;
    memberId: number | null;
}

/** Land cells of the world map: runs of land in rows of a grid over lon -180..180, lat 72..-58. */
export interface LandRuns { cols: number; rows: number; runs: [number, number, number][] }
export const MAP_LAT_TOP = 72;
export const MAP_LAT_BOTTOM = -58;

export interface GameView {
    mode: Mode;
    tab: ConsoleTab;
    c: Campaign | null;
    setup: SetupState;
    loading: LoadingInfo;
    speech: SpeechState | null;
    dialogue: DialogueState | null;
    toasts: { text: string; age: number; kind: "good" | "bad" | "info" }[];
    region: string | null;
    selectedRegion: string | null;
    selectedMember: number | null;
    memberPage: number;
    settlementPage?: number;
    prompt: string | null;
    street: { civilians: number; listeners: number; soldiers: number; followers: number; rally: string | null; rallyTime: number };
    weapon: { name: string; mag: number; reserve: number; reloading: boolean; magazine: number };
    pamphlet: string;
    stamina: number;
    /** Down the sights (0..1), whether aim assist has a soldier, and its strength. */
    aim?: { ads: number; locked: boolean; assist: number };
    armor: number;
    land: LandRuns | null;
    hasSave: boolean;
    time: number;
    firstPerson: boolean;
    piloting?: boolean;
    debug: string | null;
    /** Towns, cities, compounds and HQ placed on the screen (al_markers.ts). */
    markers?: ScreenMarker[];
    /** The mini map around you (al_markers.ts). */
    minimap?: MiniMap | null;
    /** A compound assault underway: what is left, and the flag being raised (0..1). */
    capture?: { name: string; defenders: number; raise: number; state: string } | null;
    /** Flying: boost built up (0..1), speed (m/s), altitude and ceiling (m). */
    car?: { boost: number; speed: number; altitude: number; ceiling: number;
        /** Aboard the Cobra (al_cobra.ts): its hull, and the solar cells charged (each one a missile). */
        cobra?: { hull: number; maxHull: number; cells: number; maxCells: number } } | null;
    /** Inside a house (its name for the HUD). */
    indoors?: string | null;
    /** The shop you walked into. */
    shop?: { kind: ShopKind | "hq"; name: string } | null;
    /**
     * An invasion marching on a party region: where, who, how many; your troops there, those you
     * could send, and how their strength compares with what it takes to turn it back (1 = enough).
     */
    threat?: { region: string; name: string; attacker: string; force: number; defenders: number; available: number; ratio: number; here: boolean } | null;
    /** The autopilot's destination, how far it is, the time warp, and whether it is flying now. */
    autopilot?: { name: string; km: number; warp: number; on: boolean } | null;
    /** Your comrades: walking with you, holding a spot, riding in their cars; and whether they are fighting. */
    comrades?: { following: number; holding: number; riding: number; engaged: boolean };
    /** The Allegiance server: session, nation, realtime sockets and anything that failed. */
    online?: OnlineView;
    /** Other players in your room. */
    players?: number;
    act(name: string, arg?: unknown): void;
}

/** A Painter plus click handlers for the buttons drawn this frame. */
export class UiFrame {
    handlers = new Map<string, () => void>();
    constructor(public p: Painter, public W: number, public H: number) {}
    button(id: string, x: number, y: number, w: number, h: number, label: string, style: ButtonStyle, onClick: () => void, opts: ButtonOpts = {}): void {
        this.p.button(id, x, y, w, h, label, style, opts);
        if (!opts.disabled) this.handlers.set(id, onClick);
    }
    /** An invisible click area (map dots, list rows). */
    hotspot(id: string, x: number, y: number, w: number, h: number, onClick: () => void): void {
        this.p.hotspot(id, x, y, w, h);
        this.handlers.set(id, onClick);
    }
    click(x: number, y: number): string | null {
        const b = this.p.hit(x, y);
        if (!b) return null;
        this.handlers.get(b.id)?.();
        return b.id;
    }
}

const partyColor = (c: Campaign | null): Color => (c ? c.party.color : THEME.red);
const factionColor = (c: Campaign | null, id: string): Color => (id === PARTY ? partyColor(c) : factionById(id).color);
const factionName = (c: Campaign | null, id: string): string => (id === PARTY ? (c?.party.name ?? "Party") : factionById(id).name);

// --- Shared pieces -------------------------------------------------------------------------------

function backdrop(ui: UiFrame, alpha = 0.78): void {
    ui.p.rect(0, 0, ui.W, ui.H, [0.04, 0.03, 0.03, alpha]);
}

/** The red poster frame with corner stars. */
function posterFrame(ui: UiFrame, x: number, y: number, w: number, h: number): void {
    const p = ui.p;
    p.rect(x, y, w, h, [0.92, 0.86, 0.72, 0.97], 4, THEME.black);
    p.rect(x + 10, y + 10, w - 20, h - 20, THEME.clear, 2, THEME.red);
}

const territoryGrid = new WeakMap<LandRuns, Map<number, RegionDef>>();
function worldMap(ui: UiFrame, g: GameView, x: number, y: number, w: number, h: number, pick: ((id: string) => void) | null, selected: string | null): void {
    const p = ui.p;
    p.rect(x, y, w, h, [0.1, 0.16, 0.22, 1], 3, THEME.black);
    const land = g.land;
    if (land) {
        const cw = w / land.cols, ch = h / land.rows;
        let grid = territoryGrid.get(land);
        if (!grid) { grid = new Map(); territoryGrid.set(land, grid); }
        const palette: Color[] = [[0.7, 0.62, 0.35, 1], [0.55, 0.68, 0.4, 1], [0.62, 0.68, 0.76, 1], [0.72, 0.52, 0.48, 1], [0.45, 0.61, 0.73, 1], [0.6, 0.48, 0.7, 1], [0.76, 0.66, 0.5, 1], [0.45, 0.69, 0.59, 1], [0.73, 0.52, 0.62, 1], [0.55, 0.6, 0.76, 1]];
        for (const [row, a, b] of land.runs) for (let col = a; col <= b; col++) {
            const cell = row * land.cols + col;
            let def = grid.get(cell);
            if (!def) { def = regionAt(MAP_LAT_TOP - (row + 0.5) / land.rows * (MAP_LAT_TOP - MAP_LAT_BOTTOM), (col + 0.5) / land.cols * 360 - 180); grid.set(cell, def); }
            const governor = g.c?.regions[def.id]?.governor;
            const countryColor = palette[Math.max(0, COUNTRIES.findIndex(country => country.name === def!.country)) % palette.length];
            const color = governor === PARTY ? partyColor(g.c) : countryColor;
            p.rect(x + col * cw, y + row * ch, cw + 0.5, ch + 0.5, withAlpha(color, 0.75));
        }
    }
    const toXY = (lat: number, lon: number): [number, number] => [x + (lon + 180) / 360 * w, y + (MAP_LAT_TOP - lat) / (MAP_LAT_TOP - MAP_LAT_BOTTOM) * h];
    const c = g.c;
    for (const r of c ? campaignRegions(c) : REGIONS) {
        const [px, py] = toXY(r.lat, r.lon);
        if (py < y || py > y + h) continue;
        const s = 3 + Math.sqrt(r.pop) * 0.45;
        const rs = c?.regions[r.id];
        const col = rs ? factionColor(c, rs.governor) : THEME.red;
        const lvl = rs ? controlLevel(rs) : "none";
        if (lvl === "stronghold" || lvl === "presence") p.rect(px - s / 2 - 2, py - s / 2 - 2, s + 4, s + 4, partyColor(c));
        p.rect(px - s / 2, py - s / 2, s, s, col, 1, THEME.black);
        if (rs?.war) p.rect(px - 1.5, py - s / 2 - 8, 3, 6, THEME.gold);
        if (r.id === selected) p.rect(px - s / 2 - 5, py - s / 2 - 5, s + 10, s + 10, THEME.clear, 2, THEME.gold);
        if (r.id === g.region) p.rect(px - 2, py - 2, 4, 4, THEME.cream);
        if (pick) ui.hotspot(`map-${r.id}`, px - Math.max(7, s), py - Math.max(7, s), Math.max(14, s * 2), Math.max(14, s * 2), () => pick(r.id));
    }
    // Party headquarters: a flag on the map.
    const hq = c?.party.hqSite;
    if (hq) {
        const [px, py] = toXY(hq.lat, hq.lon);
        p.rect(px - 1, py - 16, 2, 16, THEME.cream);
        p.rect(px + 1, py - 16, 10, 7, partyColor(c), 1, THEME.black);
        p.text("HQ", px + 13, py - 20, 11, THEME.cream, FONT.head);
    }
}

// --- Title ---------------------------------------------------------------------------------------

export function drawTitle(g: GameView, ui: UiFrame): void {
    const { p, W, H } = ui;
    const compact = H < 600;
    if (compact) {
        p.rect(0, 0, W, 36, [0.04, 0.03, 0.03, 0.85]);
        p.rect(0, 36, W, 3, THEME.red);
        p.rect(0, H - 26, W, 26, [0.04, 0.03, 0.03, 0.85]);
        const cx = W / 2;
        p.textC("EARTH  -  ANNO 2100", cx, 10, 14, THEME.gold, FONT.head);

        const bw = Math.min(680, W - 40), bx = cx - bw / 2, by = 46;
        p.rect(bx, by, bw, 62, THEME.red, 3, THEME.black);
        p.rect(bx + 8, by + 8, bw - 16, 46, THEME.clear, 1.5, THEME.cream);
        p.textC("ALLEGIANCE", cx, by + 12, 38, THEME.cream, FONT.head);
        p.textC("SPEAK. ORGANIZE. SEIZE THE PLANET.", cx, by + 68, 12, THEME.cream, FONT.head);

        const bw2 = Math.min(320, W - 40), x0 = cx - bw2 / 2;
        let y = by + 90;
        const o = g.online;
        if (!o || o.phase === "connecting") {
            p.textC("CONNECTING TO THE ALLEGIANCE SERVER...", cx, y + 10, 14, THEME.gold, FONT.head);
        } else if (o.phase === "error" || o.phase === "expired") {
            const mw = Math.min(640, W - 40);
            p.rect(cx - mw / 2, y, mw, 64, withAlpha(THEME.redDark, 0.94), 2, THEME.gold);
            p.textC(o.phase === "expired" ? "YOUR SESSION HAS EXPIRED" : "THE ALLEGIANCE SERVER IS UNREACHABLE", cx, y + 6, 13, THEME.gold, FONT.head);
            p.text(o.problem ?? "Unknown error.", cx - mw / 2 + 10, y + 26, 11, THEME.cream, FONT.body, mw - 20, 32);
            y += 72;
            if (o.phase === "expired") {
                ui.button("title-signin", x0, y, bw2, 36, "SIGN IN", "red", () => g.act("signin"), { size: 14 });
                ui.button("title-anonymous", x0, y + 42, bw2, 32, "PLAY ANONYMOUSLY (NEW)", "dark", () => g.act("online-anonymous"), { size: 12 });
            } else ui.button("title-retry", x0, y, bw2, 36, "RETRY", "red", () => g.act("online-retry"), { size: 14 });
        } else {
            ui.button("title-new", x0, y, bw2, 42, "NEW NATION / NEW PARTY", "red", () => g.act("setup"), { size: 14, disabled: !!o.busy });
            y += 48;
            ui.button("title-continue", x0, y, bw2, 38, "CONTINUE", "dark", () => g.act("continue"), { disabled: !g.hasSave || !!o.busy, size: 13 });
            if (o.nation) p.textC(`${o.nation.name.toUpperCase()}  -  LED BY ${o.nation.leader.toUpperCase()}`, cx, y + 44, 11, THEME.gold, FONT.head);
            y += 58;
            if (o.busy) p.textC(o.busy.toUpperCase(), cx, y, 12, THEME.gold, FONT.head);
            else if (o.player?.anonymous) {
                p.textC("PLAYING ANONYMOUSLY ON THIS DEVICE", cx, y, 11, THEME.dim, FONT.head);
                ui.button("title-signin", cx - 75, y + 16, 150, 26, "SIGN IN", "ghost", () => g.act("signin"), { size: 11 });
            } else if (o.player) p.textC(`SIGNED IN AS ${(o.player.email ?? "").toUpperCase()}`, cx, y, 11, THEME.dim, FONT.head);
        }
        p.textC("Elevation: Terrain Tiles (SRTM, GMTED, ETOPO1). Map data (c) OpenStreetMap contributors (OpenFreeMap).", cx, H - 18, 10, THEME.dim, FONT.body);
        return;
    }

    p.rect(0, 0, W, H * 0.16, [0.04, 0.03, 0.03, 0.85]);
    p.rect(0, H * 0.16, W, 6, THEME.red);
    p.rect(0, H - 70, W, 70, [0.04, 0.03, 0.03, 0.85]);
    const cx = W / 2;
    // The banner.
    const bw = Math.min(980, W - 80), bx = cx - bw / 2, by = H * 0.24;
    p.rect(bx, by, bw, 170, THEME.red, 5, THEME.black);
    p.rect(bx + 14, by + 14, bw - 28, 142, THEME.clear, 2, THEME.cream);
    p.textC("ALLEGIANCE", cx, by + 30, 84, THEME.cream, FONT.head);
    p.stars(cx - 7 * 16 * 1.6 / 2, by + 132, 7, 16);
    p.textC("EARTH  -  ANNO 2100", cx, H * 0.06, 26, THEME.gold, FONT.head);
    p.textC("SPEAK. ORGANIZE. SEIZE THE PLANET.", cx, by + 200, 22, THEME.cream, FONT.head);
    const bw2 = 380, x0 = cx - bw2 / 2;
    let y = by + 250;
    const o = g.online;
    if (!o || o.phase === "connecting") {
        p.textC("CONNECTING TO THE ALLEGIANCE SERVER...", cx, y + 16, 18, THEME.gold, FONT.head);
    } else if (o.phase === "error" || o.phase === "expired") {
        // No way in without the server: say why, and offer what can fix it.
        const mw = Math.min(760, W - 80);
        p.rect(cx - mw / 2, y, mw, 92, withAlpha(THEME.redDark, 0.94), 3, THEME.gold);
        p.textC(o.phase === "expired" ? "YOUR SESSION HAS EXPIRED" : "THE ALLEGIANCE SERVER IS UNREACHABLE", cx, y + 10, 16, THEME.gold, FONT.head);
        p.text(o.problem ?? "Unknown error.", cx - mw / 2 + 20, y + 38, 14, THEME.cream, FONT.body, mw - 40, 48);
        y += 108;
        if (o.phase === "expired") {
            ui.button("title-signin", x0, y, bw2, 50, "SIGN IN", "red", () => g.act("signin"), { size: 18 });
            ui.button("title-anonymous", x0, y + 62, bw2, 44, "PLAY ANONYMOUSLY (NEW)", "dark", () => g.act("online-anonymous"), { size: 14 });
        } else ui.button("title-retry", x0, y, bw2, 50, "RETRY", "red", () => g.act("online-retry"), { size: 18 });
    } else {
        ui.button("title-new", x0, y, bw2, 58, "NEW NATION / NEW PARTY", "red", () => g.act("setup"), { size: 19, disabled: !!o.busy });
        y += 72;
        ui.button("title-continue", x0, y, bw2, 50, "CONTINUE", "dark", () => g.act("continue"), { disabled: !g.hasSave || !!o.busy, size: 18 });
        if (o.nation) p.textC(`${o.nation.name.toUpperCase()}  -  LED BY ${o.nation.leader.toUpperCase()}`, cx, y + 58, 14, THEME.gold, FONT.head);
        y += 90;
        if (o.busy) p.textC(o.busy.toUpperCase(), cx, y, 15, THEME.gold, FONT.head);
        else if (o.player?.anonymous) {
            p.textC("PLAYING ANONYMOUSLY ON THIS DEVICE", cx, y, 13, THEME.dim, FONT.head);
            ui.button("title-signin", cx - 90, y + 22, 180, 36, "SIGN IN", "ghost", () => g.act("signin"), { size: 13 });
        } else if (o.player) p.textC(`SIGNED IN AS ${(o.player.email ?? "").toUpperCase()}`, cx, y, 13, THEME.dim, FONT.head);
    }
    p.textC("Elevation: Terrain Tiles (SRTM, GMTED, ETOPO1). Map data (c) OpenStreetMap contributors (OpenFreeMap).", cx, H - 44, 13, THEME.dim, FONT.body);
}

// --- Setup ---------------------------------------------------------------------------------------

export function drawSetup(g: GameView, ui: UiFrame): void {
    const { p, W, H } = ui;
    const s = g.setup;
    backdrop(ui, 0.86);
    const compact = H < 600;
    if (compact) {
        p.slab(0, 0, W, "FOUND YOUR PARTY", 18);
        const lx = 20, colW = Math.min(340, Math.floor((W - 60) * 0.44));
        let y = 38;

        const field = (id: "party" | "leader", label: string, value: string) => {
            p.text(label, lx, y, 11, THEME.gold, FONT.head);
            y += 18;
            const on = s.focus === id;
            ui.button(`setup-${id}`, lx, y, colW, 30, "", "paper", () => g.act("setup-focus", id), { active: false });
            const caret = on && Math.floor(g.time * 2) % 2 === 0 ? "_" : "";
            p.text((value || (on ? "" : "click to type")) + caret, lx + 8, y + 5, 15, value ? THEME.black : THEME.grey, FONT.head, colW - 16);
            if (on) p.rect(lx - 2, y - 2, colW + 4, 34, THEME.clear, 2, THEME.red);
            y += 36;
        };
        field("party", "PARTY NAME", s.party);
        field("leader", "YOUR NAME", s.leader);

        p.text("IDEOLOGY", lx, y, 11, THEME.gold, FONT.head);
        y += 18;
        const iw = (colW - 12) / 4;
        IDEOLOGIES.forEach((ideo, i) => {
            ui.button(`setup-ideo-${ideo.id}`, lx + i * (iw + 4), y, iw, 28, ideo.name.toUpperCase(), "dark", () => g.act("setup-ideology", ideo.id), { active: s.ideology === ideo.id, size: 9 });
        });
        y += 34;
        const ideo = ideologyById(s.ideology);
        p.text(`${ideo.slogan} - ${ideo.blurb}`, lx, y, 10, THEME.cream, FONT.body, colW, 26);
        y += 30;

        p.text("PARTY COLOR", lx, y, 11, THEME.gold, FONT.head);
        y += 18;
        PARTY_COLORS.forEach((pc, i) => {
            const sx = lx + i * 44;
            p.rect(sx, y, 36, 26, pc.color, s.color === i ? 3 : 1.5, s.color === i ? THEME.gold : THEME.black);
            ui.hotspot(`setup-color-${i}`, sx, y, 36, 26, () => g.act("setup-color", i));
        });

        // Spawn / Map (Right column)
        const mx = lx + colW + 24, mw = W - mx - 20;
        const mh = Math.min(Math.floor(mw / 2.77), Math.floor((H - 96) * 0.40));
        p.text("CHOOSE WHERE YOU BEGIN", mx, 38, 11, THEME.gold, FONT.head);
        worldMap(ui, g, mx, 54, mw, mh, id => g.act("setup-spawn", id), s.spawn);
        const sy = 54 + mh + 6;
        const def = s.spawn ? regionDefById(s.spawn) : null;
        if (def) {
            const bloc = BLOCS.find(b => b.id === def.bloc)!;
            const gov = g.c?.regions[def.id]?.gov ?? def.gov ?? bloc.gov;
            p.text(def.name.toUpperCase(), mx, sy, 15, THEME.cream, FONT.head);
            p.text(`${def.country}  -  ${bloc.name}  -  ${def.pop}M people  -  ${gov.toUpperCase()}`, mx, sy + 16, 10, THEME.dim, FONT.body, mw);
        } else {
            p.text("Click a territory on map, or search hometown below.", mx, sy, 11, THEME.dim, FONT.body, mw);
        }

        const hy = sy + 32;
        p.text("HOME TOWN (name, country, lat, lon)", mx, hy, 10, THEME.gold, FONT.head);
        ui.button("setup-hometown", mx, hy + 14, Math.max(80, mw - 90), 26, (s.hometownQuery || "click to type") + (s.focus === "hometown" ? "_" : ""), "paper", () => g.act("setup-focus", "hometown"), { size: 12 });
        ui.button("setup-search", mx + mw - 82, hy + 14, 82, 26, "SEARCH", "dark", () => g.act("setup-search"), { size: 10 });
        const maxPlaces = Math.max(0, Math.min(2, Math.floor((H - 48 - (hy + 44)) / 26)));
        (s.places ?? []).slice(0, maxPlaces).forEach((place, i) => ui.button(`setup-place-${i}`, mx, hy + 44 + i * 26, mw, 24, place.name, "dark", () => g.act("setup-place", i), { size: 10 }));
        if (s.hometown) p.text(`Start: ${s.hometown.name}`, mx, Math.min(H - 48, hy + 44 + maxPlaces * 26), 11, THEME.gold, FONT.body, mw);

        // Bottom action bar
        ui.button("setup-back", lx, H - 42, 90, 36, "BACK", "ghost", () => g.act("title"), { size: 12 });
        ui.button("setup-random", lx + 100, H - 42, 150, 36, "RANDOM TERRITORY", "dark", () => g.act("setup-random"), { size: 10 });
        const ready = !!s.spawn || !!s.hometown;
        const busy = g.online?.busy ?? null;
        ui.button("setup-begin", W - 170, H - 42, 150, 36, busy ? "FOUNDING..." : "BEGIN", "red", () => g.act("begin"), { disabled: !ready || !!busy, size: 15 });
        const old = g.online?.nation;
        if (old) p.text(`Founding dissolves ${old.name}.`, lx + 260, H - 30, 10, THEME.gold, FONT.body, W - 440);
        return;
    }

    p.slab(0, 0, W, "FOUND YOUR PARTY", 24);
    const lx = 40, colW = Math.min(560, W * 0.38);
    let y = 80;
    const field = (id: "party" | "leader", label: string, value: string) => {
        p.text(label, lx, y, 14, THEME.gold, FONT.head);
        y += 24;
        const on = s.focus === id;
        ui.button(`setup-${id}`, lx, y, colW, 44, "", "paper", () => g.act("setup-focus", id), { active: false });
        const caret = on && Math.floor(g.time * 2) % 2 === 0 ? "_" : "";
        p.text((value || (on ? "" : "click to type")) + caret, lx + 12, y + 8, 22, value ? THEME.black : THEME.grey, FONT.head, colW - 24);
        if (on) p.rect(lx - 3, y - 3, colW + 6, 50, THEME.clear, 3, THEME.red);
        y += 58;
    };
    field("party", "PARTY NAME", s.party);
    field("leader", "YOUR NAME", s.leader);
    p.text("IDEOLOGY", lx, y, 14, THEME.gold, FONT.head);
    y += 24;
    const iw = (colW - 18) / 4;
    IDEOLOGIES.forEach((ideo, i) => {
        ui.button(`setup-ideo-${ideo.id}`, lx + i * (iw + 6), y, iw, 40, ideo.name.toUpperCase(), "dark", () => g.act("setup-ideology", ideo.id), { active: s.ideology === ideo.id, size: 12 });
    });
    y += 50;
    const ideo = ideologyById(s.ideology);
    p.text(ideo.slogan, lx, y, 18, THEME.red, FONT.head);
    y += 28;
    p.text(ideo.blurb, lx, y, 15, THEME.cream, FONT.body, colW, 48);
    y += 46;
    const strong = ideo.strong.map(t => TOPICS.find(x => x.id === t)!.name).join(", "), weak = ideo.weak.map(t => TOPICS.find(x => x.id === t)!.name).join(", ");
    p.text(`Strong on ${strong}. Weak on ${weak}.`, lx, y, 14, THEME.dim, FONT.body, colW);
    y += 34;
    p.text("PARTY COLOR", lx, y, 14, THEME.gold, FONT.head);
    y += 24;
    PARTY_COLORS.forEach((pc, i) => {
        const sx = lx + i * 58;
        p.rect(sx, y, 48, 36, pc.color, s.color === i ? 4 : 2, s.color === i ? THEME.gold : THEME.black);
        ui.hotspot(`setup-color-${i}`, sx, y, 48, 36, () => g.act("setup-color", i));
    });
    y += 56;
    // Spawn.
    const mx = lx + colW + 40, mw = W - mx - 40, mh = Math.min(mw / 2.77, H - 260);
    p.text("CHOOSE WHERE YOU BEGIN", mx, 80, 14, THEME.gold, FONT.head);
    worldMap(ui, g, mx, 104, mw, mh, id => g.act("setup-spawn", id), s.spawn);
    const sy = 104 + mh + 16;
    const def = s.spawn ? regionDefById(s.spawn) : null;
    if (def) {
        const bloc = BLOCS.find(b => b.id === def.bloc)!;
        p.text(def.name.toUpperCase(), mx, sy, 26, THEME.cream, FONT.head);
        p.text(`${def.country}  -  ${bloc.name}  -  ${def.pop}M people  -  wealth ${def.wealth.toFixed(1)}x`, mx, sy + 38, 15, THEME.dim, FONT.body, mw);
        const gov = g.c?.regions[def.id]?.gov ?? def.gov ?? bloc.gov;
        p.text(`Government: ${gov.toUpperCase()}. ${gov === "democracy" ? "Win it at the ballot box." : "No elections here: a coup or a war."}`, mx, sy + 62, 15, THEME.cream, FONT.body, mw);
    } else {
        p.text("Choose a territory, or search for your own town below.", mx, sy, 15, THEME.dim, FONT.body, mw);
    }
    const hy = sy + 98;
    p.text("HOME TOWN (name, region/country, or lat, lon)", mx, hy, 13, THEME.gold, FONT.head);
    ui.button("setup-hometown", mx, hy + 24, Math.max(100, mw - 116), 38, (s.hometownQuery || "click to type") + (s.focus === "hometown" ? "_" : ""), "paper", () => g.act("setup-focus", "hometown"), { size: 15 });
    ui.button("setup-search", mx + mw - 108, hy + 24, 108, 38, "SEARCH", "dark", () => g.act("setup-search"));
    (s.places ?? []).slice(0, 3).forEach((place, i) => ui.button(`setup-place-${i}`, mx, hy + 70 + i * 36, mw, 32, place.name, "dark", () => g.act("setup-place", i), { size: 12 }));
    if (s.hometown) p.text(`Start: ${s.hometown.name}`, mx, Math.min(H - 112, hy + 184), 15, THEME.gold, FONT.body, mw);
    ui.button("setup-random", mx, H - 80, 200, 50, "RANDOM TERRITORY", "dark", () => g.act("setup-random"));
    ui.button("setup-back", lx, H - 80, 160, 50, "BACK", "ghost", () => g.act("title"));
    const ready = !!s.spawn || !!s.hometown;
    const busy = g.online?.busy ?? null;
    ui.button("setup-begin", W - 300, H - 86, 260, 62, busy ? "FOUNDING..." : "BEGIN", "red", () => g.act("begin"), { disabled: !ready || !!busy, size: 24 });
    const old = g.online?.nation;
    if (old) p.text(`Founding a new party dissolves ${old.name}: its territory returns to the regimes.`, W - 760, H - 120, 13, THEME.gold, FONT.body, 460, 34);
}

// --- Loading -------------------------------------------------------------------------------------

export function drawLoading(g: GameView, ui: UiFrame): void {
    const { p, W, H } = ui;
    const L = g.loading;
    p.rect(0, 0, W, H, [0.06, 0.04, 0.04, 0.94]);
    const compact = H < 600;
    const pw = Math.min(900, W - (compact ? 24 : 80)), ph = Math.min(560, H - (compact ? 24 : 80)), px = (W - pw) / 2, py = (H - ph) / 2;
    posterFrame(ui, px, py, pw, ph);
    p.rect(px + (compact ? 12 : 24), py + (compact ? 10 : 24), pw - (compact ? 24 : 48), compact ? 48 : 96, THEME.red);
    p.textC("ALLEGIANCE", W / 2, py + (compact ? 14 : 34), compact ? 26 : 46, THEME.cream, FONT.head);
    p.textC(`DESTINATION: ${L.place.toUpperCase()}`, W / 2, py + (compact ? 42 : 88), compact ? 12 : 16, THEME.gold, FONT.head);
    let y = py + (compact ? 70 : 150);
    p.text(L.stage.toUpperCase(), px + (compact ? 20 : 40), y, compact ? 13 : 18, THEME.black, FONT.head);
    y += compact ? 18 : 34;
    const barH = compact ? 22 : 34;
    p.bar(px + (compact ? 20 : 40), y, pw - (compact ? 40 : 80), barH, L.progress, THEME.red, [0.1, 0.08, 0.08, 0.9]);
    p.textC(`${Math.round(L.progress * 100)}%`, W / 2, y + (compact ? 2 : 4), compact ? 15 : 20, THEME.cream, FONT.head);
    y += compact ? 30 : 54;
    const maxLines = compact ? Math.max(1, Math.floor((py + ph - (compact ? 60 : 120) - y) / 20)) : L.lines.length;
    for (const line of L.lines.slice(0, maxLines)) { p.text(line, px + (compact ? 20 : 40), y, compact ? 12 : 15, THEME.black, FONT.mono, pw - (compact ? 40 : 80)); y += compact ? 18 : 24; }
    p.rect(px + (compact ? 20 : 40), py + ph - (compact ? 56 : 120), pw - (compact ? 40 : 80), compact ? 1.5 : 2, THEME.black);
    p.text("COMRADE'S HANDBOOK", px + (compact ? 20 : 40), py + ph - (compact ? 48 : 108), compact ? 10 : 13, THEME.red, FONT.head);
    p.text(L.tip, px + (compact ? 20 : 40), py + ph - (compact ? 34 : 84), compact ? 11 : 16, THEME.black, FONT.body, pw - (compact ? 40 : 80), compact ? 30 : 60);
    p.textR(`${L.elapsed.toFixed(0)} s`, px + pw - (compact ? 20 : 40), py + ph - (compact ? 48 : 108), compact ? 10 : 13, THEME.inkSoft, FONT.mono);
}

export const LOADING_TIPS = [
    "A speech is five beats. Read the crowd: workers want Jobs and anger, elders want Security and fear, students want Liberty and hope.",
    "Answer a rival orator's topic with the same topic to tear their argument apart in front of the crowd.",
    "Members nobody organizes drift away. Appoint Region Chiefs and Cell Leaders before the party outgrows you.",
    "Democracies can be won with votes. Juntas and oligarchies need a coup or a war.",
    "A coup needs no majority - but minority rule breeds unrest, and unrest breeds insurgents.",
    "Every soldier you drop in a street battle stands for a whole platoon in the region's war.",
    "Kindness wins donations and loyalty. Fear wins obedience. Both can win the planet.",
    "Lead from inside for better schemes and dues; lead from the field and your troops fight harder.",
    "Pamphlets cost little. The Printing Press makes them cheaper and stronger.",
];

// --- HUD -----------------------------------------------------------------------------------------

/** What to do next: a running objective that teaches the game as it goes. */
export function objective(c: Campaign, region: string | null): string {
    const def = region ? regionDefById(region) : null;
    const rs = region ? c.regions[region] : null;
    const mission = missionObjective(c);
    if (mission) return mission;
    const report = orgReport(c);
    if (c.stats.speeches === 0) return "Give your first speech: find people and press B.";
    if (c.stats.recruits < 3) return `Talk to sympathetic people (E) and invite them to join (${c.stats.recruits}/3).`;
    if (!report.inner.treasurer && !report.inner.propaganda) return "Open COMMAND (TAB) > ORGANIZATION and appoint your officers.";
    if (!def || !rs) return "Open COMMAND (TAB) > TERRITORY and choose where to go next.";
    const share = partyShare(rs);
    if (rs.governor !== PARTY) {
        if (rs.war) return `WAR in ${def.name}: fight in the streets, or reinforce from COMMAND > TERRITORY.`;
        if (rs.gov === "democracy") return share < 0.2
            ? `Raise support in ${def.name} to 20% (now ${pct(share)}): speeches, pamphlets, schemes.`
            : `Call a snap election in ${def.name} (COMMAND > TERRITORY) - or wait for the vote in ${rs.electionIn} days.`;
        return rs.army < 10
            ? `${def.name} holds no elections. Arm members (COMMAND > TERRITORY) for a coup or a war.`
            : `Strike in ${def.name}: a coup (${Math.round(coupChance(c, def.id) * 100)}%) or a war.`;
    }
    return `You govern ${def.name}. Humanity governed: ${pct(governedShare(c))} of ${pct(VICTORY_SHARE, 0)}. Travel and take the next region.`;
}

export function drawHud(g: GameView, ui: UiFrame): void {
    const { p, W, H } = ui;
    const c = g.c;
    if (!c) return;
    drawMarkers(g, ui);
    // Top-left: the party.
    const tw = 430;
    p.rect(0, 0, tw, 92, [0.04, 0.035, 0.035, 0.86]);
    p.rect(0, 92, tw, 4, partyColor(c));
    p.text(c.party.name.toUpperCase(), 14, 8, 20, THEME.cream, FONT.head, tw - 20);
    p.text(`${dateLabel(c.day)}  ${clockLabel(c.dayClock)}`, 14, 40, 15, THEME.gold, FONT.head);
    p.text(money(c.party.funds), 14, 64, 18, c.party.funds < 0 ? THEME.red : THEME.cream, FONT.num);
    p.text(`${big(totalMembers(c))} MEMBERS`, 150, 64, 18, THEME.cream, FONT.num);
    p.text(`WORLD ${pct(worldSupport(c), 2)}`, 290, 64, 18, THEME.cream, FONT.num);
    p.textR(karmaTitle(c.party.karma), tw - 12, 40, 13, c.party.karma >= 0 ? THEME.green : THEME.red, FONT.head);
    // The objective strip.
    const obj = objective(c, g.region);
    p.rect(0, 100, tw, 46, [0.6, 0.05, 0.07, 0.88]);
    p.text("OBJECTIVE", 14, 104, 11, THEME.gold, FONT.head);
    p.text(obj, 14, 118, 13, THEME.cream, FONT.body, tw - 24, 28);
    drawThreat(g, ui, tw);
    // Top-right: where you are.
    const def = g.region ? regionDefById(g.region) : null;
    if (def) {
        const rs = c.regions[def.id];
        const rw = 360, rx = W - rw;
        p.rect(rx, 0, rw, 132, [0.04, 0.035, 0.035, 0.86]);
        p.rect(rx, 132, rw, 4, factionColor(c, rs.governor));
        p.text(def.name.toUpperCase(), rx + 14, 8, 20, THEME.cream, FONT.head, rw - 20);
        p.text(`${def.country} - ${BLOCS.find(b => b.id === def.bloc)!.short} - ${rs.gov.toUpperCase()}`, rx + 14, 38, 13, THEME.dim, FONT.body, rw - 20);
        p.text(`RULED BY ${factionName(c, rs.governor).toUpperCase()}`, rx + 14, 58, 13, factionColor(c, rs.governor), FONT.head, rw - 20);
        const share = partyShare(rs);
        p.text(`PARTY ${pct(share)}`, rx + 14, 80, 15, THEME.cream, FONT.num);
        p.bar(rx + 110, 84, rw - 124, 12, share, partyColor(c));
        const rival = strongestRival(rs);
        p.text(`${factionById(rival).short} ${pct(rs.support[rival] ?? 0)}`, rx + 14, 102, 15, THEME.dim, FONT.num);
        p.bar(rx + 110, 106, rw - 124, 12, rs.support[rival] ?? 0, factionById(rival).color);
        let ty = 142;
        if (rs.war) {
            p.rect(rx, ty, rw, 30, THEME.red);
            p.text(`WAR  ${fmt(rs.army)} vs ${fmt(rs.garrison)}`, rx + 12, ty + 6, 15, THEME.cream, FONT.head);
            ty += 34;
        }
        if (rs.heat > 0.4 && rs.governor !== PARTY) {
            p.rect(rx, ty, rw, 24, [0.3, 0.05, 0.05, 0.85]);
            p.text(`REGIME HEAT ${Math.round(rs.heat * 100)}%`, rx + 12, ty + 4, 13, THEME.gold, FONT.head);
            ty += 28;
        }
        if (g.street.rally) {
            p.rect(rx, ty, rw, 44, [0.1, 0.1, 0.1, 0.85], 2, THEME.gold);
            p.text(`RIVAL RALLY: ${g.street.rally}`, rx + 12, ty + 4, 13, THEME.gold, FONT.head, rw - 20);
            p.text(`${Math.ceil(g.street.rallyTime)} s - find them and press E to debate`, rx + 12, ty + 24, 12, THEME.cream, FONT.body, rw - 20);
        }
    }
    // Bottom-left: body and gear.
    const by = H - 118;
    p.rect(0, by, 380, 118, [0.04, 0.035, 0.035, 0.86]);
    p.rect(0, by - 4, 380, 4, THEME.red);
    p.text("HEALTH", 14, by + 10, 11, THEME.dim, FONT.head);
    p.bar(90, by + 10, 270, 14, c.player.health / maxHealth(c), [0.8, 0.15, 0.12, 1]);
    p.text("ARMOR", 14, by + 30, 11, THEME.dim, FONT.head);
    p.bar(90, by + 30, 270, 10, g.armor, [0.5, 0.65, 0.85, 1]);
    p.text("STAMINA", 14, by + 46, 11, THEME.dim, FONT.head);
    p.bar(90, by + 47, 270, 8, g.stamina, THEME.gold);
    const w = g.weapon;
    p.text(w.name.toUpperCase(), 14, by + 64, 16, THEME.cream, FONT.head, 240);
    if (Number.isFinite(w.magazine)) p.textR(w.reloading ? "RELOADING" : `${w.mag} / ${w.reserve}`, 366, by + 64, 20, w.mag === 0 ? THEME.red : THEME.cream, FONT.num);
    const pam = PAMPHLETS.find(x => x.id === g.pamphlet)!;
    p.text(`PAMPHLETS: ${pam.name.toUpperCase()} x${c.player.pamphlets[pam.id] ?? 0}`, 14, by + 92, 12, THEME.gold, FONT.head, 360);
    // Followers.
    const cm = g.comrades;
    if (g.street.followers) {
        const how = cm ? [cm.holding ? `${cm.holding} HOLDING` : "", cm.riding ? `${cm.riding} IN THEIR CARS` : "", cm.engaged ? "FIGHTING" : "HOLDING FIRE"].filter(Boolean).join("  ") : "";
        p.text(`COMRADES ${g.street.followers}/${followerLimit(c)}${how ? `  ${how}` : ""}   T ${cm?.holding ? "CALL BACK" : "HOLD THERE"}`, 14, by - 26, 13, THEME.cream, FONT.head, 520);
    }
    // Crosshair: it tightens as the sights come up (the gun's own sights take over), and turns gold
    // while aim assist has a soldier.
    const cx = W / 2, cy = H / 2;
    const ads = g.aim?.ads ?? 0;
    const hair = g.aim?.locked ? THEME.gold : THEME.cream;
    if (ads < 0.9) {
        const gap = 4 + 6 * (1 - ads), len = 8 * (1 - ads * 0.6);
        p.rect(cx - gap - len, cy - 1, len, 2, hair);
        p.rect(cx + gap, cy - 1, len, 2, hair);
        p.rect(cx - 1, cy - gap - len, 2, len, hair);
        p.rect(cx - 1, cy + gap, 2, len, hair);
    } else p.rect(cx - 1.5, cy - 1.5, 3, 3, hair);
    // Prompt.
    if (g.prompt) {
        const tw2 = Math.min(W - 40, textWidth(g.prompt, 17, FONT.head) + 40);
        p.rect(cx - tw2 / 2, H - 190, tw2, 40, THEME.black, 2, THEME.gold);
        p.textC(g.prompt, cx, H - 182, 17, THEME.cream, FONT.head);
    }
    // News ticker.
    const news = c.news[0];
    if (news) {
        const nx = 400, nw = W - 420;
        p.rect(nx, H - 40, nw, 32, [0.04, 0.035, 0.035, 0.86]);
        p.rect(nx, H - 40, 110, 32, news.kind === "bad" || news.kind === "war" ? THEME.red : THEME.gold);
        p.text(news.kind === "war" ? "WAR" : news.kind === "bad" ? "ALERT" : "BULLETIN", nx + 8, H - 34, 14, THEME.black, FONT.head);
        p.text(news.text, nx + 122, H - 34, 15, THEME.cream, FONT.body, nw - 130, 28);
    }
    // Toasts.
    let ty = 156;
    for (const t of g.toasts.slice(0, 4)) {
        const tw3 = Math.min(W * 0.6, textWidth(t.text, 16, FONT.mono) + 40);
        p.rect(cx - tw3 / 2, ty, tw3, 34, t.kind === "bad" ? withAlpha(THEME.redDark, 0.92) : t.kind === "good" ? [0.1, 0.3, 0.12, 0.92] : [0.05, 0.05, 0.05, 0.9], 2, THEME.gold);
        p.textC(t.text, cx, ty + 7, 16, THEME.cream, FONT.mono);
        ty += 40;
    }
    // Controls hint and org warnings.
    const report = orgReport(c);
    const hint = g.car?.cobra ? "WASD FLY  SPACE RISE  C DESCEND  SHIFT BOOST  LMB / RT SOLAR MISSILES (AT THE CROSSHAIR)  L LAND  E EXIT" : g.piloting ? "WASD / LEFT STICK FLY  SPACE / A / CROSS RISE  C / B / CIRCLE DESCEND  HOLD SHIFT BOOST (BUILDS UP)  L / D-PAD DOWN LAND (GROUND OR FLAT ROOF)" : `WASD MOVE  SHIFT RUN  RMB LOOK  LMB SHOOT  E TALK/ENTER  F PAMPHLET  B SPEECH  H HEAL  T COMRADES HOLD/FOLLOW  I INVENTORY  TAB COMMAND${report.warnings.length ? `  (${report.warnings.length} ORG ALERTS)` : ""}`;
    p.rect(436, 4, W - 436 - 370, 26, [0.04, 0.035, 0.035, 0.7]);
    p.text(hint, 444, 9, 12, report.warnings.length ? THEME.gold : THEME.cream, FONT.head, W - 440 - 380);
    drawOnlineStrip(g, ui);
    if (g.debug) p.text(g.debug, 440, 76, 12, THEME.dim, FONT.mono, W - 840);
    drawMiniMap(g, ui);
    drawCaptureAndFlight(g, ui);
}

/**
 * The connection under the controls hint: players online and in your room, or, in red, what is
 * wrong (a dropped socket, a failed save). Anonymous players get the button to keep their nation.
 */
function drawOnlineStrip(g: GameView, ui: UiFrame): void {
    const o = g.online;
    if (!o) return;
    const { p, W } = ui;
    const x = 436, w = W - 436 - 370, y = 46;
    const net = o.net;
    const down = net.world !== "open" || net.room !== "open";
    const trouble = o.saveError ? `SAVE FAILED: ${o.saveError}` : down && net.error ? net.error : null;
    const accountW = o.player?.anonymous ? 170 : 0;
    if (trouble) {
        p.rect(x, y, w, 26, withAlpha(THEME.redDark, 0.94), 2, THEME.gold);
        p.text(trouble.toUpperCase(), x + 8, y + 5, 12, THEME.cream, FONT.head, w - 16 - accountW);
    } else {
        p.rect(x, y, w, 26, [0.04, 0.035, 0.035, 0.7]);
        const state = down ? `CONNECTING (WORLD ${net.world.toUpperCase()}, ROOM ${net.room.toUpperCase()})` : `ONLINE ${net.online}  -  ${g.players ?? 0} NEARBY`;
        p.text(state, x + 8, y + 6, 12, down ? THEME.gold : THEME.cream, FONT.head, w - 16 - accountW);
    }
    if (accountW) ui.button("hud-account", x + w - accountW, y, accountW, 26, "CREATE ACCOUNT", "red", () => g.act("create-account"), { size: 11 });
}

/**
 * An invasion on the march: who, where, how strong against the troops standing there, and one
 * click (or J for half) sends help from everywhere else.
 */
function drawThreat(g: GameView, ui: UiFrame, tw: number): void {
    const t = g.threat;
    if (!t) return;
    const { p } = ui;
    const y = 150, h = 92;
    p.rect(0, y, tw, h, [0.35, 0.04, 0.05, 0.92], 2, THEME.gold);
    p.text(`INVASION: ${t.attacker} MARCH ON ${t.name.toUpperCase()}`, 12, y + 6, 14, THEME.gold, FONT.head, tw - 20);
    p.text(`${fmt(t.force)} troops at dawn vs ${fmt(t.defenders)} there (${Math.round(t.ratio * 100)}% of what turns them back). ${fmt(t.available)} you can send.${t.here ? "" : " You are away."}`,
        12, y + 28, 12, THEME.cream, FONT.body, tw - 20, 30);
    const shares: [string, number][] = [["SEND 25%", 0.25], ["SEND 50% (J)", 0.5], ["SEND ALL", 1]];
    const bw = (tw - 36) / 3;
    shares.forEach(([label, share], i) => ui.button(`threat-send-${Math.round(share * 100)}`, 12 + i * (bw + 6), y + 60, bw, 26, label, i === 2 ? "red" : "dark",
        () => g.act("threat-send", share), { size: 11, disabled: t.available <= 0 }));
}

export function clockLabel(dayClock: number): string {
    const minutes = Math.floor(7 * 60 + (dayClock / DAY_SECONDS) * 12 * 60);
    return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

// --- Speech --------------------------------------------------------------------------------------

const TONE_COLOR: Record<string, Color> = { hope: [0.95, 0.8, 0.25, 1], anger: [0.85, 0.12, 0.12, 1], fear: [0.45, 0.35, 0.6, 1] };

export function drawSpeech(g: GameView, ui: UiFrame): void {
    const { p, W, H } = ui;
    const s = g.speech;
    if (!s) return;
    // Top: beat counter and the crowd.
    p.rect(0, 0, W, 64, [0.04, 0.035, 0.035, 0.88]);
    p.rect(0, 64, W, 4, THEME.red);
    p.text("THE SPEECH", 20, 14, 26, THEME.cream, FONT.head);
    for (let i = 0; i < BEATS; i++) {
        const done = i < s.grades.length;
        const g2 = s.grades[i];
        p.rect(250 + i * 46, 18, 38, 28, done ? (g2 === "perfect" ? THEME.gold : g2 === "good" ? THEME.green : g2 === "weak" ? THEME.grey : THEME.red) : i === s.beat ? THEME.cream : [0.2, 0.2, 0.2, 1], 2, THEME.black);
    }
    p.text(`CROWD ${s.crowd}`, 500, 16, 24, THEME.cream, FONT.num);
    p.text(`FERVOR`, 640, 12, 11, THEME.dim, FONT.head);
    p.bar(640, 30, 200, 16, s.fervor, THEME.red);
    if (s.combo > 1) p.text(`COMBO x${s.combo}`, 860, 18, 20, THEME.gold, FONT.head);
    if (s.rival) {
        p.rect(W - 380, 0, 380, 64, [0.15, 0.12, 0.05, 0.9]);
        p.text(`VS ${s.rival.name.toUpperCase()}`, W - 368, 8, 16, factionById(s.rival.faction).color, FONT.head, 360);
        p.text(`Next they argue: ${s.rival.topic.toUpperCase()}`, W - 368, 34, 15, THEME.cream, FONT.body, 360);
    }
    // Right: segments.
    const sx = W - 300;
    let sy = 90;
    p.rect(sx - 10, sy - 10, 300, 30 + s.segments.length * 44, [0.04, 0.035, 0.035, 0.8]);
    for (const seg of s.segments) {
        p.text(`${seg.name.toUpperCase()} ${Math.round(seg.share * 100)}%`, sx, sy, 12, THEME.cream, FONT.head);
        const v = (seg.approval + 1) / 2;
        p.bar(sx, sy + 18, 270, 12, v, seg.approval >= 0 ? partyColor(g.c) : [0.35, 0.35, 0.35, 1]);
        p.rect(sx + 135, sy + 16, 2, 16, THEME.cream);
        if (s.rival) p.rect(sx + 1 + 268 * (seg.rival + 1) / 2 - 1, sy + 31, 3, 6, factionById(s.rival.faction).color);
        sy += 44;
    }
    // Log.
    let ly = 90;
    p.rect(10, ly - 10, 520, 30 + Math.min(5, s.log.length) * 26, [0.04, 0.035, 0.035, 0.8]);
    for (const line of s.log.slice(0, 5)) { p.text(line, 22, ly, 15, ly === 90 ? THEME.cream : THEME.dim, FONT.body, 500); ly += 26; }
    // Bottom: the cards, the delivery bar or the heckler.
    const compact = H < 600;
    if (s.phase === "choose") {
        const cw = Math.min(330, (W - 120) / 3), ch = compact ? Math.min(180, H - 120) : 210, total = cw * 3 + 40, x0 = (W - total) / 2, y0 = H - ch - (compact ? 28 : 40);
        p.rect(W / 2 - (compact ? 190 : 260), y0 - (compact ? 30 : 48), compact ? 380 : 520, compact ? 26 : 36, THEME.black, 2, THEME.red);
        p.textC("CHOOSE YOUR NEXT LINE  [1] [2] [3]", W / 2, y0 - (compact ? 24 : 42), compact ? 13 : 18, THEME.cream, FONT.head);
        s.hand.forEach((card, i) => {
            const x = x0 + i * (cw + 20);
            const id = `card-${i}`;
            const hot = g.mode === "speech" && p.hover === id;
            p.rect(x, y0, cw, ch, hot ? [1, 0.96, 0.86, 1] : THEME.paper, 4, THEME.black);
            p.rect(x, y0, cw, compact ? 30 : 42, TONE_COLOR[card.tone]);
            p.text(`${i + 1}  ${TOPICS.find(t => t.id === card.topic)!.name.toUpperCase()}`, x + 12, y0 + (compact ? 6 : 9), compact ? 14 : 18, card.tone === "hope" ? THEME.black : THEME.cream, FONT.head);
            p.textR(card.tone.toUpperCase(), x + cw - 12, y0 + (compact ? 8 : 12), compact ? 10 : 13, card.tone === "hope" ? THEME.black : THEME.cream, FONT.head);
            p.text(card.title.toUpperCase(), x + 12, y0 + (compact ? 36 : 54), compact ? 13 : 16, THEME.red, FONT.head, cw - 24, compact ? 32 : 44);
            p.text(`"${card.line}"`, x + 12, y0 + (compact ? 70 : 100), compact ? 12 : 15, THEME.black, FONT.body, cw - 24, compact ? 50 : 80);
            p.text(`POWER ${card.power.toFixed(1)}${s.usedTopics.includes(card.topic) ? "  - REPEATED" : ""}${s.rival && s.rival.topic === card.topic ? "  - REBUTS!" : ""}`, x + 12, y0 + ch - (compact ? 18 : 26), compact ? 10 : 12, THEME.inkSoft, FONT.head);
            ui.hotspot(id, x, y0, cw, ch, () => g.act("speech-card", i));
        });
        p.rect(W / 2 - 22, H - (compact ? 26 : 36), 44, compact ? 24 : 30, THEME.black);
        p.textC(`${Math.max(0, Math.ceil(9 - s.phaseTime))}`, W / 2, H - (compact ? 24 : 34), compact ? 17 : 22, THEME.gold, FONT.num);
    } else if (s.phase === "deliver" && s.hand) {
        const bw = Math.min(900, W - 200), bx = (W - bw) / 2, by = H - (compact ? 90 : 150);
        p.rect(W / 2 - (compact ? 200 : 290), by - (compact ? 36 : 58), compact ? 400 : 580, compact ? 28 : 38, THEME.black, 2, THEME.red);
        p.textC("DELIVER IT!  PRESS SPACE IN THE GOLD", W / 2, by - (compact ? 30 : 52), compact ? 14 : 20, THEME.cream, FONT.head);
        p.rect(bx - 6, by - 6, bw + 12, compact ? 42 : 56, THEME.black);
        p.rect(bx, by, bw, compact ? 30 : 44, [0.25, 0.2, 0.18, 1]);
        p.rect(bx + (s.sweet - s.sweetHalf) * bw, by, s.sweetHalf * 2 * bw, compact ? 30 : 44, [0.85, 0.65, 0.15, 1]);
        p.rect(bx + (s.sweet - s.sweetHalf * 0.35) * bw, by, s.sweetHalf * 0.7 * bw, compact ? 30 : 44, [1, 0.92, 0.5, 1]);
        p.rect(bx + s.marker * bw - 4, by - (compact ? 6 : 10), 8, compact ? 42 : 64, THEME.red, 2, THEME.cream);
    } else if (s.phase === "heckle" && s.heckler) {
        const hw = Math.min(560, W - 40), hx = (W - hw) / 2, hy = H - (compact ? 150 : 230);
        p.rect(hx, hy, hw, compact ? 120 : 170, THEME.red, compact ? 3 : 5, THEME.black);
        p.textC(`HECKLER: "${s.heckler.line}"`, W / 2, hy + (compact ? 12 : 18), compact ? 14 : 18, THEME.cream, FONT.head);
        p.textC(`PRESS  ${s.heckler.key.toUpperCase()}  TO REBUT`, W / 2, hy + (compact ? 42 : 60), compact ? 22 : 30, THEME.gold, FONT.head);
        p.bar(hx + 40, hy + (compact ? 80 : 120), hw - 80, compact ? 12 : 16, 1 - s.phaseTime / s.heckler.window, THEME.gold);
        void HECKLE_KEYS;
    } else if (s.phase === "react" && s.lastGrade) {
        p.textC(s.lastGrade.toUpperCase() + "!", W / 2, H - (compact ? 110 : 170), compact ? 38 : 54, s.lastGrade === "perfect" ? THEME.gold : s.lastGrade === "good" ? THEME.green : s.lastGrade === "weak" ? THEME.cream : THEME.red, FONT.head);
    } else if (s.phase === "done" && s.result) {
        const r = s.result;
        const pw = Math.min(640, W - 40), ph = compact ? Math.min(230, H - 40) : 260, px = (W - pw) / 2, py = H - ph - (compact ? 16 : 40);
        posterFrame(ui, px, py, pw, ph);
        p.textC(r.score >= 0.8 ? "TRIUMPH" : r.score >= 0.6 ? "WELL SPOKEN" : r.score >= 0.45 ? "POLITE APPLAUSE" : "THEY WALKED AWAY", W / 2, py + (compact ? 18 : 26), compact ? 24 : 34, THEME.red, FONT.head);
        p.textC(`SCORE ${Math.round(r.score * 100)}   CROWD ${r.crowd}   JOINED ${r.joined}`, W / 2, py + (compact ? 56 : 82), compact ? 16 : 22, THEME.black, FONT.head);
        if (r.rival) p.textC(r.rival.won ? `You out-argued ${s.rival?.name ?? "the rival"}.` : `${s.rival?.name ?? "The rival"} won the crowd.`, W / 2, py + (compact ? 84 : 120), compact ? 14 : 18, r.rival.won ? THEME.black : THEME.red, FONT.body);
        p.textC(r.karma > 0 ? "Hope spreads. (+karma)" : r.karma < 0 ? "Fear takes root. (-karma)" : "", W / 2, py + (compact ? 108 : 150), compact ? 12 : 15, THEME.inkSoft, FONT.body);
        ui.button("speech-close", W / 2 - 100, py + ph - (compact ? 46 : 70), 200, compact ? 36 : 48, "STEP DOWN", "red", () => g.act("speech-close"), { size: compact ? 13 : 15 });
    }
}

// --- Street dialogue -----------------------------------------------------------------------------

export function drawDialogue(g: GameView, ui: UiFrame): void {
    const { p, W, H } = ui;
    const d = g.dialogue;
    const c = g.c;
    if (!d || !c) return;
    const compact = H < 600;
    const pw = Math.min(560, W - 40), ph = Math.min(300, H - (compact ? 16 : 60)), px = W / 2 - pw / 2, py = Math.max(8, H - ph - (compact ? 8 : 60));
    posterFrame(ui, px, py, pw, ph);
    p.text(d.name.toUpperCase(), px + (compact ? 18 : 30), py + (compact ? 14 : 26), compact ? 18 : 24, THEME.black, FONT.head, pw - (compact ? 36 : 60));
    const seg = d.segment[0].toUpperCase() + d.segment.slice(1);
    p.text(d.orator ? `Orator for ${factionById(d.lean).name}` : `${seg.replace(/s$/, "")}${d.member ? " - PARTY MEMBER" : ""} - leans ${factionById(d.lean).short}`, px + (compact ? 18 : 30), py + (compact ? 36 : 62), compact ? 11 : 14, THEME.inkSoft, FONT.body, pw - (compact ? 36 : 60));
    if (!d.orator) {
        p.text(opinionLabel(d.opinion), px + (compact ? 18 : 30), py + (compact ? 54 : 88), compact ? 11 : 14, d.opinion >= 0.15 ? THEME.red : THEME.black, FONT.head);
        p.bar(px + (compact ? 140 : 180), py + (compact ? 56 : 90), pw - (compact ? 160 : 210), compact ? 10 : 14, (d.opinion + 1) / 2, partyColor(c), [0.3, 0.3, 0.3, 1]);
    }
    p.text(`"${d.reply}"`, px + (compact ? 18 : 30), py + (compact ? 74 : 118), compact ? 13 : 16, THEME.black, FONT.body, pw - (compact ? 36 : 60), compact ? 40 : 60);
    const bw = (pw - (compact ? 44 : 70)) / 2;
    let y = py + (compact ? 122 : 186);
    const opts: [string, string, boolean][] = d.orator
        ? [["dlg-debate", "1  CHALLENGE TO DEBATE", true], ["dlg-leave", "ESC  WALK AWAY", true]]
        : d.member
            ? [["dlg-follow", d.follower ? "1  STAY HERE" : "1  FOLLOW ME", true], ["dlg-pamphlet", "2  GIVE PAMPHLETS", true], ["dlg-leave", "ESC  GOODBYE", true]]
            : [["dlg-persuade", "1  PERSUADE", true], ["dlg-pamphlet", "2  GIVE PAMPHLET", (c.player.pamphlets[g.pamphlet] ?? 0) > 0],
                ["dlg-recruit", `3  JOIN US (${Math.round(d.recruitChance * 100)}%)`, d.recruitChance > 0], ["dlg-leave", "ESC  GOODBYE", true]];
    opts.forEach(([id, label, enabled], i) => {
        const x = px + (compact ? 16 : 25) + (i % 2) * (bw + (compact ? 12 : 20));
        ui.button(id, x, y + Math.floor(i / 2) * (compact ? 36 : 50), bw, compact ? 30 : 42, label, i === opts.length - 1 ? "ghost" : "dark", () => g.act(id), { disabled: !enabled, size: compact ? 10 : 13 });
    });
}

// --- Command console -----------------------------------------------------------------------------

const TABS: [ConsoleTab, string][] = [["overview", "OVERVIEW"], ["organization", "ORGANIZATION"], ["territory", "TERRITORY"], ["armory", "ARMORY"], ["inventory", "INVENTORY"], ["skills", "SKILLS"]];

export function drawConsole(g: GameView, ui: UiFrame): void {
    const { p, W, H } = ui;
    const c = g.c;
    if (!c) return;
    p.rect(0, 0, W, H, [0.07, 0.05, 0.05, 0.985]);
    const compact = H < 600 || W < 1000;
    if (compact) {
        p.rect(0, 0, W, 42, THEME.black);
        p.rect(0, 42, W, 3, partyColor(c));
        const tabW = Math.min(130, Math.floor((W - 54) / TABS.length) - 4);
        TABS.forEach(([id, label], i) => ui.button(`tab-${id}`, 8 + i * (tabW + 4), 6, tabW, 30, label, "dark", () => g.act("tab", id), { active: g.tab === id, size: 10 }));
        ui.button("console-close", W - 38, 6, 30, 30, "X", "red", () => g.act("close-console"), { size: 14 });
        const top = 52;
        switch (g.tab) {
            case "overview": drawOverview(g, ui, c, top); break;
            case "organization": drawOrganization(g, ui, c, top); break;
            case "territory": drawTerritory(g, ui, c, top); break;
            case "armory": drawArmory(g, ui, c, top); break;
            case "skills": drawSkills(g, ui, c, top); break;
            case "inventory": drawInventory(g, ui, c, top); break;
        }
        return;
    }
    p.rect(0, 0, W, 64, THEME.black);
    p.rect(0, 64, W, 5, partyColor(c));
    p.text(`${c.party.name.toUpperCase()}  -  COMMAND`, 20, 16, 24, THEME.cream, FONT.head);
    const tw = 150;
    TABS.forEach(([id, label], i) => ui.button(`tab-${id}`, W - (TABS.length - i) * (tw + 6) - 10, 12, tw, 42, label, "dark", () => g.act("tab", id), { active: g.tab === id, size: 13 }));
    ui.button("console-close", W - 60, H - 60, 44, 44, "X", "red", () => g.act("close-console"));
    const top = 90;
    switch (g.tab) {
        case "overview": drawOverview(g, ui, c, top); break;
        case "organization": drawOrganization(g, ui, c, top); break;
        case "territory": drawTerritory(g, ui, c, top); break;
        case "armory": drawArmory(g, ui, c, top); break;
        case "skills": drawSkills(g, ui, c, top); break;
        case "inventory": drawInventory(g, ui, c, top); break;
    }
}

function drawOverview(g: GameView, ui: UiFrame, c: Campaign, top: number): void {
    const { p, W, H } = ui;
    const compact = H < 600;
    const col = (W - 60) / 3;
    let x = 20, y = top;
    p.text("THE PARTY", x, y, compact ? 13 : 16, THEME.gold, FONT.head);
    y += compact ? 18 : 30;
    const ideo = ideologyById(c.party.ideology);
    const rows: [string, string][] = [
        ["Leader", c.party.leader], ["Ideology", `${ideo.name} - ${ideo.slogan}`], ["Date", `${dateLabel(c.day)} (day ${c.day})`],
        ["Funds", money(c.party.funds)], ["Members", fmt(totalMembers(c))], ["Named members", fmt(c.members.length)],
        ["World support", pct(worldSupport(c), 2)], ["Humanity governed", `${pct(governedShare(c))} of ${pct(VICTORY_SHARE, 0)} needed`],
        ["Reputation", `${karmaTitle(c.party.karma)} (${Math.round(c.party.karma)})`], ["Level", `${c.party.level} (${fmt(c.party.xp)}/${fmt(xpForLevel(c.party.level))} XP)`],
        ["Headquarters", regionDefById(c.party.hq)?.name ?? c.party.hq],
        ["Outlawed", c.outlawedDay ? `since day ${c.outlawedDay}` : "not yet"],
    ];
    const shownRows = compact ? rows.slice(0, 7) : rows;
    for (const [k, v] of shownRows) {
        p.text(k.toUpperCase(), x, y, compact ? 10 : 12, THEME.dim, FONT.head);
        p.text(v, x + (compact ? 120 : 170), y - 2, compact ? 12 : 15, THEME.cream, FONT.body, col - (compact ? 130 : 180));
        y += compact ? 17 : 26;
    }
    y += compact ? 4 : 10;
    p.text("LEADERSHIP POSTURE", x, y, compact ? 11 : 13, THEME.gold, FONT.head);
    y += compact ? 16 : 24;
    const postW = (col - 16) / 3;
    (["inside", "mixed", "field"] as const).forEach((ps, i) => ui.button(`posture-${ps}`, x + i * (postW + 4), y, postW, compact ? 26 : 38, ps.toUpperCase(), "dark", () => g.act("posture", ps), { active: c.party.posture === ps, size: compact ? 9 : 12 }));
    y += compact ? 30 : 46;
    if (!compact) {
        p.text(c.party.posture === "inside" ? "From headquarters: schemes and dues improve." : c.party.posture === "field" ? "At the front: your troops fight harder when you are there." : "Half and half.", x, y, 13, THEME.dim, FONT.body, col);
        y += 34;
    }
    p.text(`DUES ${c.party.duesRate.toFixed(2)} CR / MEMBER / DAY`, x, y, compact ? 10 : 13, THEME.gold, FONT.head);
    ui.button("dues-down", x + col - 76, y - (compact ? 3 : 6), 34, compact ? 22 : 30, "-", "dark", () => g.act("dues", -0.05), { size: compact ? 11 : 13 });
    ui.button("dues-up", x + col - 38, y - (compact ? 3 : 6), 34, compact ? 22 : 30, "+", "dark", () => g.act("dues", 0.05), { size: compact ? 11 : 13 });
    y += compact ? 26 : 40;
    const restW = compact ? col - 90 : 260;
    ui.button("rest", x, y, restW, compact ? 30 : 46, "REST UNTIL TOMORROW", "red", () => g.act("rest"), { size: compact ? 11 : 14 });
    ui.button("save", x + restW + 8, y, compact ? 82 : 120, compact ? 30 : 46, "SAVE", "dark", () => g.act("save"), { size: compact ? 11 : 14 });
    y += compact ? 36 : 62;
    const o = g.online;
    if (!compact) {
        p.text("ACCOUNT", x, y, 13, THEME.gold, FONT.head);
        y += 22;
        if (o?.player?.anonymous) {
            p.text("Playing anonymously: this nation lives only in this browser's session until you give it an account.", x, y, 13, THEME.cream, FONT.body, col - 10, 36);
            ui.button("console-account", x, y + 40, 220, 38, "CREATE ACCOUNT", "red", () => g.act("create-account"), { size: 13 });
        } else if (o?.player) p.text(`Signed in as ${o.player.email}. Your nation is saved to your account.`, x, y, 13, THEME.cream, FONT.body, col - 10, 36);
    }
    // Ledger.
    x = 40 + col;
    y = top;
    p.text("YESTERDAY'S LEDGER", x, y, compact ? 13 : 16, THEME.gold, FONT.head);
    y += compact ? 18 : 30;
    const l = c.ledger;
    const ledger: [string, number][] = [["Party dues", l.dues], ["Taxes", l.taxes], ["Donations", l.donations], ["Schemes", l.schemes], ["Officer salaries", -l.salaries], ["Armed forces", -l.army], ["Facilities", -l.facilities], ["Governing", -l.admin]];
    const shownLedger = compact ? ledger.slice(0, 5) : ledger;
    for (const [k, v] of shownLedger) {
        p.text(k, x, y, compact ? 11 : 15, THEME.cream, FONT.body);
        p.textR(money(v), x + col - 20, y, compact ? 12 : 16, v < 0 ? [0.95, 0.45, 0.4, 1] : THEME.cream, FONT.num);
        y += compact ? 18 : 26;
    }
    p.rect(x, y, col - 20, compact ? 1 : 2, THEME.cream);
    y += compact ? 4 : 8;
    p.text("NET PER DAY", x, y, compact ? 11 : 14, THEME.gold, FONT.head);
    p.textR(money(l.net), x + col - 20, y, compact ? 14 : 20, l.net < 0 ? THEME.red : THEME.green, FONT.num);
    y += compact ? 24 : 44;
    p.text("SCHEMES UNDERWAY", x, y, compact ? 11 : 14, THEME.gold, FONT.head);
    y += compact ? 18 : 26;
    if (!c.schemes.length) { p.text("None. Plot from Territory tab.", x, y, compact ? 11 : 14, THEME.dim, FONT.body); y += compact ? 16 : 22; }
    for (const s of c.schemes.slice(0, compact ? 3 : 6)) {
        p.text(`${SCHEMES.find(x2 => x2.id === s.scheme)?.name} in ${regionDefById(s.region)?.name}: ${s.daysLeft}d, ${Math.round(s.chance * 100)}%`, x, y, compact ? 11 : 14, THEME.cream, FONT.body, col - 20);
        y += compact ? 16 : 22;
    }
    // News.
    x = 60 + col * 2;
    y = top;
    p.text("BULLETINS", x, y, compact ? 13 : 16, THEME.gold, FONT.head);
    y += compact ? 18 : 30;
    const newsH = compact ? 32 : 44;
    for (const n of c.news.slice(0, Math.floor((H - top - (compact ? 20 : 80)) / newsH))) {
        p.rect(x, y + 2, 4, compact ? 24 : 34, n.kind === "good" ? THEME.green : n.kind === "bad" ? THEME.red : n.kind === "war" ? THEME.gold : THEME.grey);
        p.text(`${dateLabel(n.day)}`, x + 10, y, 10, THEME.dim, FONT.head);
        p.text(n.text, x + 10, y + 11, compact ? 11 : 13, THEME.cream, FONT.body, col - 24, compact ? 22 : 30);
        y += newsH;
    }
}

function memberLine(m: Member): string {
    return `${m.name}`;
}

function drawOrganization(g: GameView, ui: UiFrame, c: Campaign, top: number): void {
    const { p, W, H } = ui;
    const compact = H < 600;
    const report = orgReport(c);
    let x = 20, y = top;
    // The chain of command.
    p.text("CHAIN OF COMMAND", x, y, compact ? 13 : 16, THEME.gold, FONT.head);
    p.text(`You direct ${report.directReports} of ${report.leaderSpan} officers. ${fmt(report.organized)} of ${fmt(report.total)} members organized.`, x + (compact ? 150 : 250), y + 2, compact ? 11 : 14, THEME.cream, FONT.body, W - (compact ? 180 : 300));
    y += compact ? 20 : 30;
    const leadW = compact ? 160 : 300, boxH = compact ? 34 : 50;
    p.rect(x, y, leadW, boxH, partyColor(c), compact ? 2 : 3, THEME.black);
    p.text(c.party.leader.toUpperCase(), x + 8, y + (compact ? 3 : 6), compact ? 13 : 18, THEME.cream, FONT.head, leadW - 16);
    p.text("THE LEADER", x + 8, y + (compact ? 18 : 30), compact ? 9 : 11, THEME.cream, FONT.head);
    const inW = compact ? Math.min(140, Math.floor((W - x - leadW - 40) / 3)) : 225;
    INNER_CIRCLE.forEach((role, i) => {
        const m = report.inner[role];
        const bx = x + leadW + (compact ? 10 : 20) + i * (inW + (compact ? 6 : 10));
        p.rect(bx, y, inW, boxH, m ? THEME.black : [0.25, 0.08, 0.08, 1], compact ? 1.5 : 2, THEME.gold);
        p.text(ROLE_NAMES[role].toUpperCase(), bx + 6, y + (compact ? 3 : 5), compact ? 9 : 11, THEME.gold, FONT.head, inW - 12);
        p.text(m ? m.name : "VACANT", bx + 6, y + (compact ? 16 : 22), compact ? 11 : 15, m ? THEME.cream : THEME.red, FONT.head, inW - 12);
    });
    y += compact ? 42 : 64;
    ui.button("auto-organize", x, y, compact ? 160 : 260, compact ? 26 : 40, "AUTO-ORGANIZE", "red", () => g.act("auto-organize"), { size: compact ? 10 : 14 });
    let wy = y + (compact ? 4 : 0);
    for (const w of report.warnings.slice(0, compact ? 1 : 3)) { p.text(`! ${w}`, x + (compact ? 174 : 280), wy, compact ? 11 : 13, THEME.gold, FONT.body, W - (compact ? 200 : 320)); wy += 18; }
    y += compact ? 34 : 56;
    // Members list.
    const lw = compact ? Math.min(480, Math.floor((W - 60) * 0.52)) : Math.min(900, W * 0.58);
    const rowH = compact ? 22 : 30;
    const perPage = Math.max(3, compact ? Math.min(5, Math.floor((H - y - 48) / rowH)) : Math.floor((H - y - 100) / rowH));
    const list = [...c.members].sort((a, b) => (a.role === "none" ? 1 : 0) - (b.role === "none" ? 1 : 0) || b.admin + b.charisma + b.combat - (a.admin + a.charisma + a.combat));
    const pages = Math.max(1, Math.ceil(list.length / perPage));
    const page = Math.min(g.memberPage, pages - 1);
    p.rect(x, y, lw, compact ? 20 : 28, THEME.black);
    const cols: [string, number][] = compact
        ? [["NAME", 6], ["HOME", 140], ["CHA", 240], ["ADM", 275], ["CMB", 310], ["LOYAL", 345], ["ROLE", 390]]
        : [["NAME", 10], ["HOME", 240], ["CHA", 400], ["ADM", 450], ["CMB", 500], ["LOYAL", 550], ["ROLE", 620]];
    for (const [h, cx] of cols) p.text(h, x + cx, y + (compact ? 4 : 6), compact ? 9 : 11, THEME.gold, FONT.head);
    y += compact ? 22 : 30;
    list.slice(page * perPage, page * perPage + perPage).forEach(m => {
        const sel = g.selectedMember === m.id;
        p.rect(x, y, lw, rowH - (compact ? 2 : 2), sel ? [0.35, 0.08, 0.08, 1] : [0.12, 0.1, 0.1, 0.9]);
        p.text(memberLine(m) + (m.follower ? " *" : ""), x + cols[0][1], y + (compact ? 3 : 5), compact ? 11 : 14, THEME.cream, FONT.body, compact ? 130 : 225);
        p.text(regionDefById(m.region)?.name ?? m.region, x + cols[1][1], y + (compact ? 3 : 5), compact ? 10 : 13, THEME.dim, FONT.body, compact ? 95 : 150);
        p.text(String(m.charisma), x + cols[2][1], y + (compact ? 2 : 4), compact ? 11 : 15, THEME.cream, FONT.num);
        p.text(String(m.admin), x + cols[3][1], y + (compact ? 2 : 4), compact ? 11 : 15, THEME.cream, FONT.num);
        p.text(String(m.combat), x + cols[4][1], y + (compact ? 2 : 4), compact ? 11 : 15, THEME.cream, FONT.num);
        p.text(String(Math.round(m.loyalty)), x + cols[5][1], y + (compact ? 2 : 4), compact ? 11 : 15, m.loyalty < 30 ? THEME.red : THEME.cream, FONT.num);
        const post = m.post ? (m.role === "commissioner" ? BLOCS.find(b => b.id === m.post)?.short : regionDefById(m.post)?.name) : "";
        p.text(m.role === "none" ? (m.follower ? "Follower" : "-") : `${ROLE_NAMES[m.role]}${post ? `, ${post}` : ""}`, x + cols[6][1], y + (compact ? 3 : 5), compact ? 10 : 13, m.role === "none" ? THEME.dim : THEME.gold, FONT.body, lw - cols[6][1] - 4);
        ui.hotspot(`member-${m.id}`, x, y, lw, rowH, () => g.act("select-member", m.id));
        y += rowH;
    });
    const pagY = H - (compact ? 34 : 70);
    ui.button("members-prev", x, pagY, compact ? 70 : 100, compact ? 26 : 40, "PREV", "dark", () => g.act("member-page", -1), { disabled: page === 0, size: compact ? 10 : 12 });
    p.text(`PAGE ${page + 1} / ${pages}`, x + (compact ? 80 : 120), pagY + (compact ? 6 : 10), compact ? 11 : 14, THEME.cream, FONT.head);
    ui.button("members-next", x + (compact ? 170 : 260), pagY, compact ? 70 : 100, compact ? 26 : 40, "NEXT", "dark", () => g.act("member-page", 1), { disabled: page >= pages - 1, size: compact ? 10 : 12 });
    // Selected member's posts.
    const m = c.members.find(mm => mm.id === g.selectedMember);
    const ax = x + lw + (compact ? 14 : 30), aw = W - ax - (compact ? 16 : 80);
    let ay = top + (compact ? 18 : 150);
    if (!m) { p.text("Select a member to give them a post.", ax, ay, compact ? 12 : 15, THEME.dim, FONT.body, aw); return; }
    p.text(m.name.toUpperCase(), ax, ay, compact ? 15 : 20, THEME.cream, FONT.head, aw);
    ay += compact ? 18 : 30;
    p.text(`${regionDefById(m.region)?.name}. Charisma ${m.charisma}, Admin ${m.admin}, Combat ${m.combat}, Loyalty ${Math.round(m.loyalty)}.`, ax, ay, compact ? 11 : 14, THEME.dim, FONT.body, aw);
    ay += compact ? 22 : 40;
    const appointCols = compact ? 2 : 1;
    const apBw = appointCols === 2 ? Math.floor((aw - 6) / 2) : aw;
    const apRowH = compact ? 26 : 42;
    const apBtnH = compact ? 24 : 36;
    let btnIndex = 0;
    const btn = (id: string, label: string, action: string, arg: unknown, active = false) => {
        const bx = ax + (btnIndex % appointCols) * (apBw + 6);
        const by = ay + Math.floor(btnIndex / appointCols) * apRowH;
        ui.button(id, bx, by, apBw, apBtnH, label, "dark", () => g.act(action, arg), { size: compact ? 9 : 12, active });
        btnIndex++;
    };
    for (const role of INNER_CIRCLE) btn(`appoint-${role}`, ROLE_NAMES[role].toUpperCase(), "appoint", { id: m.id, role, post: null }, m.role === role);
    const home = regionDefById(m.region)?.name ?? "";
    btn("appoint-chief", `CHIEF OF ${home.toUpperCase()}`, "appoint", { id: m.id, role: "chief", post: m.region }, m.role === "chief");
    btn("appoint-cell", `CELL LEADER, ${home.toUpperCase()}`, "appoint", { id: m.id, role: "cell", post: m.region }, m.role === "cell");
    const bloc = BLOCS.find(b => b.id === blocOf(m.region));
    btn("appoint-commissioner", `COMMISSIONER OF ${bloc?.short ?? ""}`, "appoint", { id: m.id, role: "commissioner", post: bloc?.id }, m.role === "commissioner");
    btn("appoint-follower", m.follower ? "STOP FOLLOWING ME" : `FOLLOW ME (${followers(c).length}/${followerLimit(c)})`, "follower", m.id, m.follower);
    btn("appoint-armed", m.armed ? "ARMED FORCES: SERVING" : `JOIN THE ARMED FORCES (${money(ARM_COST)})`, "armed", m.id, m.armed);
    btn("appoint-none", "RELIEVE OF DUTY", "appoint", { id: m.id, role: "none", post: null });
}

function drawTerritory(g: GameView, ui: UiFrame, c: Campaign, top: number): void {
    const { p, W, H } = ui;
    const compact = H < 600;
    if (compact) {
        const mw = Math.min(W - 460, (H - top - 30) * 2.5), mh = mw / 2.77;
        worldMap(ui, g, 14, top, mw, mh, id => g.act("select-region", id), g.selectedRegion);
        let lx = 14;
        const ly = top + mh + 6;
        for (const f of ["party", "concordat", "vanguard", "verdant", "current"]) {
            p.rect(lx, ly + 2, 10, 10, factionColor(c, f), 1, THEME.black);
            const name = factionName(c, f);
            p.text(name, lx + 14, ly, 10, THEME.cream, FONT.body);
            lx += textWidth(name, 10) + 16;
        }
        let sy = ly + 18;
        p.text("STRONGEST REGIONS", 14, sy, 10, THEME.gold, FONT.head);
        sy += 16;
        const best = campaignRegions(c).map(r => ({ r, rs: c.regions[r.id] })).filter(x => x.rs.members > 0 || partyShare(x.rs) > 0.005)
            .sort((a, b) => partyShare(b.rs) - partyShare(a.rs)).slice(0, 2);
        for (const { r, rs } of best) {
            const lvl = controlLevel(rs);
            p.text(r.name, 14, sy, 11, THEME.cream, FONT.body);
            p.text(`${pct(partyShare(rs))} ${big(rs.members)} ${lvl.toUpperCase()}`, 100, sy, 11, lvl === "governed" ? THEME.gold : THEME.dim, FONT.body, mw - 100);
            ui.hotspot(`best-${r.id}`, 14, sy, mw, 16, () => g.act("select-region", r.id));
            sy += 16;
        }
        sy += 4;
        p.text("DISCOVERED PLACES", 14, sy, 10, THEME.gold, FONT.head);
        sy += 16;
        const locals = [...(c.settlements ?? [])].sort((a, b) => angularDistance(c.player.lat, c.player.lon, a.lat, a.lon) - angularDistance(c.player.lat, c.player.lon, b.lat, b.lon));
        const rows = Math.max(1, Math.min(3, Math.floor((H - sy - 40) / 22)));
        const page = Math.min(g.settlementPage ?? 0, Math.max(0, Math.ceil(locals.length / rows) - 1));
        for (const d of locals.slice(page * rows, (page + 1) * rows)) {
            const rs = c.regions[d.id];
            ui.button(`settlement-${d.id}`, 14, sy, mw, 20, `${d.name} - ${pct(partyShare(rs))} - ${factionName(c, rs.governor)}`, "dark", () => g.act("select-region", d.id), { size: 9, active: g.selectedRegion === d.id });
            sy += 22;
        }
        if (!locals.length) { p.text("Search hometown when founding party.", 14, sy, 10, THEME.dim, FONT.body, mw); sy += 18; }
        ui.button("settlements-prev", 14, sy + 2, 70, 22, "PREV", "dark", () => g.act("settlement-page", -1), { size: 9, disabled: page === 0 });
        ui.button("settlements-next", 90, sy + 2, 70, 22, "NEXT", "dark", () => g.act("settlement-page", 1), { size: 9, disabled: (page + 1) * rows >= locals.length });

        // Detail.
        const id = g.selectedRegion ?? g.region ?? c.party.hq;
        const def = regionDefById(id);
        if (!def) return;
        const rs = c.regions[id];
        const dx = 24 + mw, dw = W - dx - 14;
        let y = top;
        p.rect(dx, y, dw, 24, factionColor(c, rs.governor));
        const headCol = rs.governor === PARTY || factionById(rs.governor).id === "current" ? THEME.black : THEME.cream;
        p.text(def.name.toUpperCase(), dx + 8, y + 4, 15, headCol, FONT.head, 130);
        p.text(`${def.country} - ${rs.gov.toUpperCase()} (${fmt(Math.round(def.pop * 1e6))}) - ${factionName(c, rs.governor)}`, dx + 140, y + 5, 10, headCol, FONT.body, dw - 146);
        y += 28;
        const rival = strongestRival(rs);
        p.text(`SUPPORT: PARTY ${pct(partyShare(rs))}  -  ${factionById(rival).short} ${pct(rs.support[rival] ?? 0)}  -  UNDECIDED ${pct(rs.support.undecided ?? 0)}`, dx, y, 10, THEME.cream, FONT.body, dw);
        y += 15;
        p.text(`MEMBERS ${fmt(rs.members)}  ARMED ${fmt(rs.army)}  ${rs.governor === PARTY ? "INSURGENTS" : "GARRISON"} ${fmt(rs.garrison)}  HEAT ${pct(rs.heat, 0)}  UNREST ${pct(rs.unrest, 0)}`, dx, y, 10, THEME.dim, FONT.body, dw);
        y += 17;
        if (rs.war) {
            p.rect(dx, y, dw, 18, [0.25, 0.05, 0.05, 1]);
            p.text(`WAR vs ${factionName(c, rs.war.attacker === PARTY ? rs.war.defender : rs.war.attacker)} - day ${rs.war.days}`, dx + 6, y + 2, 10, THEME.gold, FONT.body, dw - 12);
            y += 22;
        }
        const actions: [string, string, string, boolean][] = [];
        const t = travelCost(c, c.player.lat, c.player.lon, id);
        actions.push(["act-travel", id === g.region ? "YOU ARE HERE" : `TRAVEL (${t.cost ? money(t.cost) : "FREE"}${t.days ? `, ${t.days}D` : ""})`, "travel", id !== g.region]);
        actions.push(["act-hq", id === c.party.hq ? "HEADQUARTERS" : "MOVE HQ HERE", "move-hq", id !== c.party.hq]);
        actions.push(["act-autopilot", `AUTOPILOT HERE (${Math.round(angularDistance(c.player.lat, c.player.lon, def.lat, def.lon) * 6371)} KM)`, "autopilot", id !== g.region]);
        if (rs.governor !== PARTY) {
            actions.push(["act-election", rs.gov === "democracy" ? `SNAP ELECTION (${money(electionCost(rs))})` : "NO ELECTIONS", "election", rs.gov === "democracy"]);
            actions.push(["act-coup", `COUP (${Math.round(coupChance(c, id) * 100)}%)`, "coup", rs.army >= 10 && !rs.war]);
            actions.push(rs.war ? ["act-peace", "SUE FOR PEACE", "peace", true] : ["act-war", "DECLARE WAR", "war", rs.army >= 10]);
        } else {
            actions.push(["act-tax-down", `TAX ${Math.round(rs.taxRate * 100)}%  -`, "tax", true]);
            actions.push(["act-tax-up", `TAX ${Math.round(rs.taxRate * 100)}%  +`, "tax-up", true]);
            if (rs.gov === "democracy") actions.push(["act-suspend", "SUSPEND ELECTIONS", "suspend", true]);
            if (rs.war) actions.push(["act-peace", "SUE FOR PEACE", "peace", true]);
        }
        const armN = Math.max(0, Math.min(rs.members - 1, Math.floor(c.party.funds / ARM_COST), Math.max(10, Math.round(rs.members * 0.25))));
        actions.push(["act-arm", `ARM ${fmt(armN)} (${money(armN * ARM_COST)})`, "arm", armN > 0]);
        actions.push(["act-disarm", "STAND DOWN 25%", "disarm", rs.army > 0]);
        const hereArmy = g.region ? c.regions[g.region].army : 0;
        actions.push(["act-march", `MARCH ${fmt(Math.floor(hereArmy / 2))} HERE`, "march", !!g.region && g.region !== id && hereArmy >= 2]);

        const actCols = dw >= 400 ? 3 : 2;
        const abw = Math.floor((dw - (actCols - 1) * 6) / actCols);
        actions.forEach(([bid, label, action], i) => {
            const enabled = actions[i][3];
            const bx = dx + (i % actCols) * (abw + 6);
            const by = y + Math.floor(i / actCols) * 28;
            ui.button(bid, bx, by, abw, 24, label, action === "war" || action === "coup" ? "red" : "dark", () => g.act(action, id), { disabled: !enabled, size: 9 });
        });
        y += Math.ceil(actions.length / actCols) * 28 + 6;

        const avail = troopsAvailable(c, id);
        const verb = rs.governor === PARTY ? "DEFEND" : "TAKE";
        p.text(`SEND TROOPS: ${fmt(avail)} AVAILABLE ELSEWHERE`, dx, y, 10, rs.threat ? THEME.red : THEME.gold, FONT.head, dw);
        y += 14;
        const sw3 = Math.floor((dw - 12) / 3);
        ([["25%", 0.25], ["50%", 0.5], ["ALL", 1]] as [string, number][]).forEach(([label, share], i) => {
            ui.button(`dispatch-${Math.round(share * 100)}`, dx + i * (sw3 + 6), y, sw3, 22, `${verb} ${label}`, rs.governor === PARTY ? "dark" : "red",
                () => g.act("dispatch", { region: id, share }), { disabled: avail <= 0, size: 9 });
        });
        y += 28;

        p.text("SCHEMES", dx, y, 10, THEME.gold, FONT.head);
        y += 14;
        const sCols = dw >= 400 ? 3 : 2;
        const sbw = Math.floor((dw - (sCols - 1) * 6) / sCols);
        SCHEMES.forEach((s, i) => {
            const label = `${s.name.toUpperCase()} ${Math.round(schemeChance(c, s.id, id) * 100)}%`;
            const enabled = rs.members > 0 || id === c.party.hq;
            ui.button(`scheme-${s.id}`, dx + (i % sCols) * (sbw + 6), y + Math.floor(i / sCols) * 24, sbw, 20, label, s.karma < -5 ? "red" : "dark", () => g.act("scheme", { scheme: s.id, region: id }), { disabled: !enabled, size: 9 });
        });
        return;
    }

    const mw = Math.min(W - 520, (H - top - 40) * 2.77), mh = mw / 2.77;
    worldMap(ui, g, 20, top, mw, mh, id => g.act("select-region", id), g.selectedRegion);
    // Legend.
    let lx = 20;
    const ly = top + mh + 12;
    for (const f of ["party", "concordat", "vanguard", "verdant", "current"]) {
        p.rect(lx, ly + 2, 14, 14, factionColor(c, f), 1, THEME.black);
        const name = factionName(c, f);
        p.text(name, lx + 20, ly, 13, THEME.cream, FONT.body);
        lx += textWidth(name, 13) + 50;
    }
    // Strongest regions.
    let sy = ly + 30;
    p.text("YOUR STRONGEST REGIONS", 20, sy, 13, THEME.gold, FONT.head);
    sy += 22;
    const best = campaignRegions(c).map(r => ({ r, rs: c.regions[r.id] })).filter(x => x.rs.members > 0 || partyShare(x.rs) > 0.005)
        .sort((a, b) => partyShare(b.rs) - partyShare(a.rs)).slice(0, 3);
    for (const { r, rs } of best) {
        const lvl = controlLevel(rs);
        p.text(`${r.name}`, 20, sy, 14, THEME.cream, FONT.body);
        p.text(`${pct(partyShare(rs))}  ${big(rs.members)} members  ${rs.army ? `${big(rs.army)} armed` : ""}  ${lvl.toUpperCase()}${rs.war ? "  AT WAR" : ""}`, 200, sy, 14, lvl === "governed" ? THEME.gold : THEME.dim, FONT.body, mw - 200);
        ui.hotspot(`best-${r.id}`, 20, sy, mw, 20, () => g.act("select-region", r.id));
        sy += 22;
    }
    sy += 10;
    p.text("DISCOVERED TOWNS AND VILLAGES", 20, sy, 13, THEME.gold, FONT.head); sy += 24;
    const locals = [...(c.settlements ?? [])].sort((a, b) => angularDistance(c.player.lat, c.player.lon, a.lat, a.lon) - angularDistance(c.player.lat, c.player.lon, b.lat, b.lon));
    const rows = Math.max(1, Math.min(8, Math.floor((H - sy - 64) / 26)));
    const page = Math.min(g.settlementPage ?? 0, Math.max(0, Math.ceil(locals.length / rows) - 1));
    for (const d of locals.slice(page * rows, (page + 1) * rows)) {
        const rs = c.regions[d.id];
        ui.button(`settlement-${d.id}`, 20, sy, mw, 24, `${d.name}  -  ${d.kind}  -  ${pct(partyShare(rs))} support  -  ${factionName(c, rs.governor)}`, "dark", () => g.act("select-region", d.id), { size: 12, active: g.selectedRegion === d.id });
        sy += 26;
    }
    if (!locals.length) { p.text("Places appear as their map tiles load. Search a hometown when founding your party.", 20, sy, 13, THEME.dim, FONT.body, mw); sy += 26; }
    ui.button("settlements-prev", 20, sy + 4, 100, 28, "PREVIOUS", "dark", () => g.act("settlement-page", -1), { size: 11, disabled: page === 0 });
    ui.button("settlements-next", 130, sy + 4, 100, 28, "NEXT", "dark", () => g.act("settlement-page", 1), { size: 11, disabled: (page + 1) * rows >= locals.length });
    // Region detail.
    const id = g.selectedRegion ?? g.region ?? c.party.hq;
    const def = regionDefById(id);
    if (!def) return;
    const rs = c.regions[id];
    const dx = 40 + mw, dw = W - dx - 20;
    let y = top;
    p.rect(dx, y, dw, 48, factionColor(c, rs.governor));
    p.text(def.name.toUpperCase(), dx + 12, y + 10, 22, rs.governor === PARTY || factionById(rs.governor).id === "current" ? THEME.black : THEME.cream, FONT.head, dw - 20);
    y += 58;
    p.text(`${def.country}  -  ruling ideology: ${ideologyById(countryOf(def).ideology).name}`, dx, y, 14, THEME.dim, FONT.body, dw);
    y += 22;
    p.text(`${fmt(Math.round(def.pop * 1e6))} people  -  ${rs.gov.toUpperCase()}  -  ruled by ${factionName(c, rs.governor)}`, dx, y, 14, THEME.cream, FONT.body, dw);
    y += 30;
    const shares = Object.entries(rs.support).sort((a, b) => b[1] - a[1]);
    for (const [f, v] of shares) {
        p.text(f === "undecided" ? "Undecided" : factionName(c, f), dx, y, 13, THEME.cream, FONT.body, 150);
        p.bar(dx + 150, y + 3, dw - 220, 12, v, f === "undecided" ? [0.5, 0.5, 0.5, 1] : factionColor(c, f));
        p.textR(pct(v), dx + dw, y, 14, THEME.cream, FONT.num);
        y += 20;
    }
    y += 8;
    const stat: [string, string][] = [["Members", fmt(rs.members)], ["Armed", fmt(rs.army)], [rs.governor === PARTY ? "Insurgents" : "Garrison", fmt(rs.garrison)],
        ["Unrest", pct(rs.unrest, 0)], ["Heat", pct(rs.heat, 0)], ["Election", rs.gov === "democracy" ? `in ${rs.electionIn} days` : "none"]];
    stat.forEach(([k, v], i) => {
        const sx = dx + (i % 3) * (dw / 3);
        const syy = y + Math.floor(i / 3) * 40;
        p.text(k.toUpperCase(), sx, syy, 11, THEME.dim, FONT.head);
        p.text(v, sx, syy + 14, 17, THEME.cream, FONT.num);
    });
    y += 88;
    if (rs.war) {
        p.rect(dx, y, dw, 24 + Math.min(4, rs.war.log.length) * 18, [0.25, 0.05, 0.05, 1]);
        p.text(`WAR vs ${factionName(c, rs.war.attacker === PARTY ? rs.war.defender : rs.war.attacker)} - day ${rs.war.days}, next: ${rs.war.phase === "offensive" ? (rs.war.attacker === PARTY ? "your offensive" : "their offensive") : (rs.war.attacker === PARTY ? "their counterattack" : "your counterattack")}`, dx + 8, y + 4, 13, THEME.gold, FONT.body, dw - 16);
        let wy = y + 22;
        for (const line of rs.war.log.slice(0, 4)) { p.text(line, dx + 8, wy, 12, THEME.cream, FONT.mono, dw - 16); wy += 18; }
        y = wy + 8;
    }
    // Actions.
    const bw = (dw - 10) / 2;
    const actions: [string, string, string, boolean][] = [];
    const t = travelCost(c, c.player.lat, c.player.lon, id);
    actions.push(["act-travel", id === g.region ? "YOU ARE HERE" : `TRAVEL (${t.cost ? money(t.cost) : "FREE"}${t.days ? `, ${t.days}D` : ""})`, "travel", id !== g.region]);
    actions.push(["act-hq", id === c.party.hq ? "HEADQUARTERS" : "MOVE HQ HERE", "move-hq", id !== c.party.hq]);
    actions.push(["act-autopilot", `AUTOPILOT HERE (${Math.round(angularDistance(c.player.lat, c.player.lon, def.lat, def.lon) * 6371)} KM)`, "autopilot", id !== g.region]);
    if (rs.governor !== PARTY) {
        actions.push(["act-election", rs.gov === "democracy" ? `SNAP ELECTION (${money(electionCost(rs))})` : "NO ELECTIONS", "election", rs.gov === "democracy"]);
        actions.push(["act-coup", `COUP (${Math.round(coupChance(c, id) * 100)}%)`, "coup", rs.army >= 10 && !rs.war]);
        actions.push(rs.war ? ["act-peace", "SUE FOR PEACE", "peace", true] : ["act-war", "DECLARE WAR", "war", rs.army >= 10]);
    } else {
        actions.push(["act-tax-down", `TAX ${Math.round(rs.taxRate * 100)}%  -`, "tax", true]);
        actions.push(["act-tax-up", `TAX ${Math.round(rs.taxRate * 100)}%  +`, "tax-up", true]);
        if (rs.gov === "democracy") actions.push(["act-suspend", "SUSPEND ELECTIONS", "suspend", true]);
        if (rs.war) actions.push(["act-peace", "SUE FOR PEACE", "peace", true]);
    }
    const armN = Math.max(0, Math.min(rs.members - 1, Math.floor(c.party.funds / ARM_COST), Math.max(10, Math.round(rs.members * 0.25))));
    actions.push(["act-arm", `ARM ${fmt(armN)} (${money(armN * ARM_COST)})`, "arm", armN > 0]);
    actions.push(["act-disarm", "STAND DOWN 25%", "disarm", rs.army > 0]);
    const hereArmy = g.region ? c.regions[g.region].army : 0;
    actions.push(["act-march", `MARCH ${fmt(Math.floor(hereArmy / 2))} HERE`, "march", !!g.region && g.region !== id && hereArmy >= 2]);
    actions.forEach(([bid, label, action], i) => {
        const enabled = actions[i][3];
        ui.button(bid, dx + (i % 2) * (bw + 10), y + Math.floor(i / 2) * 44, bw, 38, label, action === "war" || action === "coup" ? "red" : "dark", () => g.act(action, id), { disabled: !enabled, size: 11 });
    });
    y += Math.ceil(actions.length / 2) * 44 + 10;
    // Send troops from every other region: to hold a party region, or to take this one (war).
    const avail = troopsAvailable(c, id);
    const verb = rs.governor === PARTY ? "DEFEND" : "TAKE";
    p.text(`SEND TROOPS: ${fmt(avail)} AVAILABLE ELSEWHERE${rs.threat ? `  -  ${factionById(rs.threat.attacker).short} ARRIVE AT DAWN WITH ${fmt(rs.threat.force)}` : ""}`, dx, y, 12, rs.threat ? THEME.red : THEME.gold, FONT.head, dw);
    y += 20;
    const sw3 = (dw - 20) / 3;
    ([["25%", 0.25], ["50%", 0.5], ["ALL", 1]] as [string, number][]).forEach(([label, share], i) => {
        ui.button(`dispatch-${Math.round(share * 100)}`, dx + i * (sw3 + 10), y, sw3, 34, `${verb} WITH ${label}`, rs.governor === PARTY ? "dark" : "red",
            () => g.act("dispatch", { region: id, share }), { disabled: avail <= 0, size: 11 });
    });
    y += 44;
    p.text("SCHEMES", dx, y, 13, THEME.gold, FONT.head);
    y += 22;
    const sw = (dw - 10) / 2;
    SCHEMES.forEach((s, i) => {
        const label = `${s.name.toUpperCase()} ${schemeCost(c, s.id) ? money(schemeCost(c, s.id)) : ""} ${Math.round(schemeChance(c, s.id, id) * 100)}%`;
        const enabled = rs.members > 0 || id === c.party.hq;
        ui.button(`scheme-${s.id}`, dx + (i % 2) * (sw + 10), y + Math.floor(i / 2) * 38, sw, 32, label, s.karma < -5 ? "red" : "dark", () => g.act("scheme", { scheme: s.id, region: id }), { disabled: !enabled, size: 10 });
    });
}

function drawArmory(g: GameView, ui: UiFrame, c: Campaign, top: number): void {
    const { p, W, H } = ui;
    const compact = H < 600;
    const col = (W - 80) / 3;
    let x = 20, y = top;
    p.text(`WEAPONS  -  ${money(c.party.funds)}`, x, y, compact ? 13 : 16, THEME.gold, FONT.head);
    y += compact ? 16 : 30;
    const wH = compact ? 34 : 62, wRowH = compact ? 38 : 68;
    for (const w of WEAPONS) {
        const owned = c.player.weapons.includes(w.id);
        p.rect(x, y, col, wH, c.player.weapon === w.id ? [0.3, 0.08, 0.08, 1] : [0.12, 0.1, 0.1, 0.95], 1, [1, 1, 1, 0.15]);
        p.text(w.name.toUpperCase(), x + 6, y + (compact ? 3 : 6), compact ? 11 : 15, THEME.cream, FONT.head, col - (compact ? 94 : 150));
        p.text(`DMG ${w.damage}${w.pellets > 1 ? `x${w.pellets}` : ""}  RATE ${w.rate}/s  RNG ${w.range}m${Number.isFinite(w.magazine) ? `  MAG ${w.magazine}` : ""}`, x + 6, y + (compact ? 17 : 28), compact ? 9 : 12, THEME.dim, FONT.mono, col - (compact ? 94 : 150));
        if (!compact) p.text(w.blurb, x + 10, y + 44, 12, THEME.dim, FONT.body, col - 150);
        const bw = compact ? 84 : 120, bh = compact ? 22 : 24;
        if (owned) {
            if (compact && Number.isFinite(w.magazine)) {
                ui.button(`equip-${w.id}`, x + col - 88, y + 6, 40, bh, c.player.weapon === w.id ? "EQUIP" : "USE", "dark", () => g.act("equip", w.id), { size: 8, active: c.player.weapon === w.id });
                ui.button(`ammo-${w.id}`, x + col - 44, y + 6, 40, bh, `+AMMO`, "dark", () => g.act("buy-ammo", w.id), { size: 8 });
            } else {
                ui.button(`equip-${w.id}`, x + col - bw - 6, y + (compact ? 6 : 6), bw, bh, c.player.weapon === w.id ? "EQUIPPED" : "EQUIP", "dark", () => g.act("equip", w.id), { size: compact ? 9 : 11, active: c.player.weapon === w.id });
                if (Number.isFinite(w.magazine)) ui.button(`ammo-${w.id}`, x + col - bw - 8, y + bh + 4, bw, bh, `AMMO ${money(ammoPrice(w.id))}`, "dark", () => g.act("buy-ammo", w.id), { size: 10 });
            }
        } else ui.button(`buy-${w.id}`, x + col - bw - 6, y + (compact ? 6 : 18), bw, compact ? 22 : 28, money(w.price), "red", () => g.act("buy-weapon", w.id), { size: compact ? 9 : 12, disabled: c.party.funds < w.price });
        y += wRowH;
    }
    x = 40 + col;
    y = top;
    p.text("ARMOR", x, y, compact ? 13 : 16, THEME.gold, FONT.head);
    y += compact ? 16 : 30;
    const aH = compact ? 34 : 56, aRowH = compact ? 38 : 62;
    for (const a of ARMORS) {
        const worn = c.player.armorId === a.id;
        p.rect(x, y, col, aH, worn ? [0.3, 0.08, 0.08, 1] : [0.12, 0.1, 0.1, 0.95], 1, [1, 1, 1, 0.15]);
        p.text(a.name.toUpperCase(), x + 6, y + (compact ? 3 : 6), compact ? 11 : 15, THEME.cream, FONT.head, col - (compact ? 94 : 150));
        p.text(`${a.armor} ARMOR, ${Math.round(a.absorb * 100)}% ABSORB.`, x + 6, y + (compact ? 17 : 28), compact ? 9 : 12, THEME.dim, FONT.body, col - (compact ? 94 : 150));
        const bw = compact ? 84 : 120;
        if (a.price) ui.button(`armor-${a.id}`, x + col - bw - 6, y + (compact ? 6 : 14), bw, compact ? 22 : 28, worn ? (c.player.armor < a.armor ? `REPAIR ${money(a.price / 4)}` : "WORN") : money(a.price), worn ? "dark" : "red", () => g.act("buy-armor", a.id), { size: compact ? 9 : 11, disabled: worn && c.player.armor >= a.armor });
        y += aRowH;
    }
    y += compact ? 6 : 14;
    p.text("PAMPHLETS (10)", x, y, compact ? 13 : 16, THEME.gold, FONT.head);
    y += compact ? 16 : 30;
    const pmH = compact ? 32 : 50, pmRowH = compact ? 36 : 56;
    for (const pm of PAMPHLETS) {
        p.rect(x, y, col, pmH, g.pamphlet === pm.id ? [0.3, 0.08, 0.08, 1] : [0.12, 0.1, 0.1, 0.95], 1, [1, 1, 1, 0.15]);
        p.text(`${pm.name.toUpperCase()} x${c.player.pamphlets[pm.id] ?? 0}`, x + 6, y + (compact ? 3 : 6), compact ? 11 : 14, THEME.cream, FONT.head, col - (compact ? 94 : 150));
        if (!compact) p.text(pm.blurb, x + 10, y + 28, 12, THEME.dim, FONT.body, col - 150);
        const bw = compact ? 84 : 120;
        if (compact) {
            ui.button(`pamphlet-${pm.id}`, x + col - 88, y + 5, 40, 22, "BUY", "red", () => g.act("buy-pamphlets", pm.id), { size: 8 });
            ui.button(`pamphlet-use-${pm.id}`, x + col - 44, y + 5, 40, 22, g.pamphlet === pm.id ? "ON" : "USE", "dark", () => g.act("select-pamphlet", pm.id), { size: 8, active: g.pamphlet === pm.id });
        } else {
            ui.button(`pamphlet-${pm.id}`, x + col - bw - 8, y + 4, bw, 20, `BUY ${money(pamphletPrice(c, pm.id))}`, "red", () => g.act("buy-pamphlets", pm.id), { size: 10 });
            ui.button(`pamphlet-use-${pm.id}`, x + col - bw - 8, y + 27, bw, 20, g.pamphlet === pm.id ? "CARRYING" : "CARRY", "dark", () => g.act("select-pamphlet", pm.id), { size: 10, active: g.pamphlet === pm.id });
        }
        y += pmRowH;
    }
    x = 60 + col * 2;
    y = top;
    p.text("PARTY FACILITIES", x, y, compact ? 13 : 16, THEME.gold, FONT.head);
    y += compact ? 16 : 30;
    const fH = compact ? 36 : 70, fRowH = compact ? 40 : 76;
    for (const f of FACILITIES) {
        const built = hasFacility(c, f.id);
        p.rect(x, y, col, fH, built ? [0.12, 0.25, 0.12, 1] : [0.12, 0.1, 0.1, 0.95], 1, [1, 1, 1, 0.15]);
        p.text(f.name.toUpperCase(), x + 6, y + (compact ? 3 : 6), compact ? 11 : 15, THEME.cream, FONT.head, col - (compact ? 80 : 130));
        p.text(`${f.blurb} Upkeep ${money(f.upkeep)}/d.`, x + 6, y + (compact ? 17 : 28), compact ? 8.5 : 12, THEME.dim, FONT.body, col - (compact ? 80 : 130), compact ? 16 : 40);
        const bw = compact ? 72 : 120;
        ui.button(`facility-${f.id}`, x + col - bw - 6, y + (compact ? 6 : 20), bw, compact ? 22 : 28, built ? "BUILT" : money(f.price), built ? "dark" : "red", () => g.act("buy-facility", f.id), { size: compact ? 8.5 : 11, disabled: built || c.party.funds < f.price });
        y += fRowH;
    }
}

function drawSkills(g: GameView, ui: UiFrame, c: Campaign, top: number): void {
    const { p, W, H } = ui;
    const compact = H < 600;
    let y = top;
    p.text(`LEVEL ${c.party.level}  -  ${c.party.skillPoints} SKILL POINT${c.party.skillPoints === 1 ? "" : "S"}`, 20, y, compact ? 15 : 20, THEME.gold, FONT.head);
    y += compact ? 20 : 34;
    const barW = compact ? Math.min(300, W * 0.4) : 500;
    p.bar(20, y, barW, compact ? 12 : 16, c.party.xp / xpForLevel(c.party.level), THEME.gold);
    p.text(`${fmt(c.party.xp)} / ${fmt(xpForLevel(c.party.level))} XP. Earned from speeches, recruits & victories.`, compact ? barW + 30 : 540, y - 2, compact ? 11 : 14, THEME.dim, FONT.body, W - (compact ? barW + 50 : 560));
    y += compact ? 24 : 40;
    const cw = (W - 60) / 2;
    const cardH = compact ? 62 : 108, rowStep = compact ? 66 : 120;
    SKILLS.forEach((s, i) => {
        const x = 20 + (i % 2) * (cw + 20), yy = y + Math.floor(i / 2) * rowStep;
        const lvl = c.party.skills[s.id];
        p.rect(x, yy, cw, cardH, [0.12, 0.1, 0.1, 0.95], compact ? 1 : 2, THEME.black);
        p.text(s.name.toUpperCase(), x + 10, yy + (compact ? 6 : 10), compact ? 14 : 20, THEME.cream, FONT.head);
        p.text(s.blurb, x + 10, yy + (compact ? 24 : 42), compact ? 10 : 14, THEME.dim, FONT.body, cw - (compact ? 120 : 200));
        const pipW = compact ? 20 : 28, pipH = compact ? 12 : 18;
        for (let k = 0; k < SKILL_MAX; k++) p.rect(x + 10 + k * (pipW + 4), yy + (compact ? 42 : 74), pipW, pipH, k < lvl ? partyColor(c) : [0.25, 0.22, 0.2, 1], 1, THEME.black);
        const cost = skillCost(lvl);
        const bw = compact ? 110 : 150, bh = compact ? 26 : 44;
        ui.button(`skill-${s.id}`, x + cw - bw - 10, yy + (compact ? 16 : 30), bw, bh, lvl >= SKILL_MAX ? "MASTERED" : `RAISE (${cost} SP)`, "red", () => g.act("raise-skill", s.id), { size: compact ? 9 : 12, disabled: lvl >= SKILL_MAX || c.party.skillPoints < cost });
    });
}

// --- Ending --------------------------------------------------------------------------------------

export function drawOutcome(g: GameView, ui: UiFrame): void {
    const { p, W, H } = ui;
    const c = g.c;
    if (!c?.outcome) return;
    const o = c.outcome;
    backdrop(ui, 0.8);
    const compact = H < 600;
    const pw = Math.min(980, W - 80), ph = Math.min(460, H - 36), px = (W - pw) / 2, py = Math.max(8, (H - ph) / 2);
    posterFrame(ui, px, py, pw, ph);
    p.rect(px + 24, py + 24, pw - 48, compact ? 70 : 110, o.kind === "victory" ? partyColor(c) : THEME.black);
    p.textC(o.kind === "victory" ? "VICTORY" : "DEFEAT", W / 2, py + (compact ? 28 : 36), compact ? 36 : 52, THEME.cream, FONT.head);
    p.textC(o.title, W / 2, py + (compact ? 66 : 100), compact ? 15 : 20, THEME.gold, FONT.head);
    p.text(o.text, px + 50, py + (compact ? 104 : 160), compact ? 13 : 20, THEME.black, FONT.body, pw - 100, compact ? 70 : 120);
    p.textC(`Day ${o.day}. ${c.stats.speeches} speeches, ${c.stats.recruits} recruited in person, ${c.stats.regionsTaken} regions taken, ${c.stats.kills} enemies fallen.`, W / 2, py + (compact ? 180 : 300), compact ? 11 : 15, THEME.inkSoft, FONT.body);
    ui.button("outcome-title", W / 2 - 150, py + ph - (compact ? 50 : 90), 300, compact ? 40 : 54, "RETURN TO TITLE", "red", () => g.act("title"), { size: compact ? 15 : 18 });
}

export function drawScreen(g: GameView, ui: UiFrame): void {
    ui.handlers.clear();
    switch (g.mode) {
        case "title": drawTitle(g, ui); break;
        case "setup": drawSetup(g, ui); break;
        case "loading": drawLoading(g, ui); break;
        case "play": drawHud(g, ui); break;
        case "speech": drawSpeech(g, ui); break;
        case "dialogue": drawHud(g, ui); drawDialogue(g, ui); break;
        case "console": drawConsole(g, ui); break;
        case "outcome": drawOutcome(g, ui); break;
        case "shop": backdrop(ui, 0.55); drawShop(g, ui); break;
    }
}

// --- Inventory, shops ----------------------------------------------------------------------------

function drawInventory(g: GameView, ui: UiFrame, c: Campaign, top: number): void {
    const { p, W, H } = ui;
    const compact = H < 600;
    const col = (W - 80) / 3;
    let x = 20, y = top;
    p.text(`SUPPLIES  -  ${money(c.party.funds)}`, x, y, compact ? 13 : 16, THEME.gold, FONT.head);
    y += compact ? 18 : 30;
    const inv = inventory(c);
    const held = ITEMS.filter(it => (inv[it.id] ?? 0) > 0);
    if (!held.length) { p.text("Nothing but pamphlets. Search houses (E at front door) or visit a shop.", x, y, compact ? 11 : 14, THEME.dim, FONT.body, col); y += 30; }
    const iH = compact ? 42 : 54, iRowH = compact ? 46 : 60;
    for (const it of held) {
        p.rect(x, y, col, iH, [0.12, 0.1, 0.1, 0.95], 1, [1, 1, 1, 0.15]);
        p.text(`${it.name.toUpperCase()} x${inv[it.id]}`, x + 8, y + 4, compact ? 12 : 15, THEME.cream, FONT.head, col - 110);
        p.text(it.blurb, x + 8, y + (compact ? 20 : 28), compact ? 10 : 12, THEME.dim, FONT.body, col - 110);
        if (it.usable) ui.button(`use-${it.id}`, x + col - (compact ? 90 : 130), y + (compact ? 8 : 13), compact ? 82 : 120, compact ? 24 : 28, "USE", "red", () => g.act("use-item", it.id), { size: compact ? 10 : 12 });
        y += iRowH;
    }
    y += compact ? 4 : 10;
    p.text("H uses best healing. Shops buy salvage.", x, y, compact ? 10 : 12, THEME.dim, FONT.body, col);

    x = 40 + col; y = top;
    p.text("FLYING CAR", x, y, compact ? 13 : 16, THEME.gold, FONT.head);
    y += compact ? 18 : 30;
    const spec = carSpec(c.player.carUpgrades);
    const rows: [string, string][] = [["Cruise", `${spec.cruise} m/s`], ["Boost", `${spec.boostStart} -> ${spec.boostMax} m/s over ${spec.boostRamp} s`],
        ["Climb", `${spec.climb} m/s`], ["Ceiling", `${fmt(spec.ceiling)} m`]];
    for (const [k, v] of rows) { p.text(k.toUpperCase(), x, y, compact ? 10 : 12, THEME.dim, FONT.head); p.text(v, x + (compact ? 80 : 110), y - 2, compact ? 11 : 15, THEME.cream, FONT.body, col - (compact ? 90 : 120)); y += compact ? 18 : 26; }
    y += compact ? 4 : 8;
    for (const u of CAR_UPGRADES) {
        const t = carTier(c, u.id);
        p.text(`${u.name.toUpperCase()}`, x, y, compact ? 10 : 13, THEME.cream, FONT.head);
        for (let k = 0; k < 3; k++) p.rect(x + (compact ? 150 : 200) + k * (compact ? 18 : 26), y + 2, compact ? 14 : 20, compact ? 9 : 12, k < t ? partyColor(c) : [0.25, 0.22, 0.2, 1], 1, THEME.black);
        y += compact ? 16 : 24;
    }
    p.text("Fitted at Hover Garages (blue awnings) and HQ.", x, y + 4, compact ? 10 : 12, THEME.dim, FONT.body, col);

    x = 60 + col * 2; y = top;
    p.text("HEADQUARTERS", x, y, compact ? 13 : 16, THEME.gold, FONT.head);
    y += compact ? 18 : 30;
    const hq = c.party.hqSite;
    p.text(hq ? `${hq.name}: quartermaster (every shop), safehouse and respawn point.` : "None yet. Take regime outpost near hometown (gold marker).", x, y, compact ? 11 : 14, THEME.cream, FONT.body, col, compact ? 40 : 80);
    y += compact ? 44 : 110;
    p.text("CONTROLS", x, y, compact ? 13 : 16, THEME.gold, FONT.head);
    y += compact ? 18 : 30;
    const k = c.player.controls ?? { aimAssist: 0.5, lookSensitivity: 1 };
    const setting = (id: string, label: string, value: string, step: number) => {
        p.text(label, x, y + (compact ? 4 : 6), compact ? 11 : 13, THEME.cream, FONT.head);
        ui.button(`${id}-down`, x + col - (compact ? 120 : 150), y, compact ? 32 : 40, compact ? 24 : 30, "-", "dark", () => g.act(id, -step), { size: compact ? 11 : 14 });
        p.textC(value, x + col - (compact ? 68 : 85), y + (compact ? 3 : 4), compact ? 14 : 18, THEME.gold, FONT.num);
        ui.button(`${id}-up`, x + col - (compact ? 38 : 50), y, compact ? 32 : 40, compact ? 24 : 30, "+", "dark", () => g.act(id, step), { size: compact ? 11 : 14 });
        y += compact ? 28 : 38;
    };
    setting("aim-assist", "AIM ASSIST", `${Math.round(k.aimAssist * 100)}%`, 0.1);
    setting("look-sensitivity", "LOOK SPEED", `${k.lookSensitivity.toFixed(1)}x`, 0.1);
    p.text("ADS: hold middle mouse / Z / LT. Call car: G / View.", x, y + 2, compact ? 10 : 12, THEME.dim, FONT.body, col, 30);
}

function drawShop(g: GameView, ui: UiFrame): void {
    const { p, W, H } = ui;
    const c = g.c, shop = g.shop;
    if (!c || !shop) return;
    const compact = H < 600;
    const pw = Math.min(1180, W - (compact ? 24 : 60)), ph = Math.min(720, H - (compact ? 20 : 120)), px = (W - pw) / 2, py = (H - ph) / 2;
    p.rect(px, py, pw, ph, [0.07, 0.05, 0.05, 0.97], compact ? 2 : 3, THEME.gold);
    p.rect(px, py, pw, compact ? 38 : 56, THEME.black);
    p.text(shop.name.toUpperCase(), px + (compact ? 12 : 18), py + (compact ? 8 : 12), compact ? 18 : 24, THEME.cream, FONT.head);
    p.textR(money(c.party.funds), px + pw - (compact ? 50 : 80), py + (compact ? 10 : 16), compact ? 16 : 22, THEME.gold, FONT.num);
    ui.button("shop-close", px + pw - (compact ? 36 : 60), py + (compact ? 4 : 8), compact ? 30 : 44, compact ? 30 : 40, "X", "red", () => g.act("shop-close"), { size: compact ? 12 : 14 });
    const stock = shopStock(c, shop.kind);
    const cols = 2, cw = (pw - (compact ? 36 : 60)) / 3, rowH = compact ? 36 : 46;
    const perCol = Math.max(1, Math.floor((ph - (compact ? 60 : 110)) / rowH));
    stock.slice(0, perCol * cols).forEach((line, i) => {
        const x = px + (compact ? 12 : 20) + Math.floor(i / perCol) * (cw + 10), y = py + (compact ? 46 : 70) + (i % perCol) * rowH;
        p.rect(x, y, cw, rowH - 6, [0.12, 0.1, 0.1, 0.95], 1, [1, 1, 1, 0.15]);
        p.text(line.name.toUpperCase(), x + 6, y + 2, compact ? 11 : 13, THEME.cream, FONT.head, cw - (compact ? 98 : 130));
        p.text(line.blurb, x + 6, y + (compact ? 16 : 21), compact ? 9 : 11, THEME.dim, FONT.body, cw - (compact ? 98 : 130), compact ? 14 : 18);
        const bw = compact ? 92 : 108, bh = compact ? 22 : 28;
        ui.button(`shop-buy-${line.kind}-${line.id}`, x + cw - bw - 6, y + (compact ? 4 : 6), bw, bh, line.blocked ?? money(line.price), "red", () => g.act("shop-buy", { kind: line.kind, id: line.id }),
            { size: compact ? 9 : 11, disabled: !!line.blocked || c.party.funds < line.price });
    });
    // What you carry, and what this shop will buy.
    const sx = px + (compact ? 24 : 40) + cw * 2, sw = pw - (sx - px) - (compact ? 12 : 20);
    let y = py + (compact ? 46 : 70);
    p.text("YOUR SUPPLIES", sx, y, compact ? 12 : 15, THEME.gold, FONT.head);
    y += compact ? 20 : 26;
    const inv = inventory(c);
    const sRowH = compact ? 26 : 32;
    for (const [id, n] of Object.entries(inv)) {
        const it = itemById(id);
        if (!it || n <= 0) continue;
        if (y + sRowH > py + ph - (compact ? 22 : 30)) break;
        p.text(`${it.name} x${n}`, sx, y + (compact ? 3 : 4), compact ? 11 : 14, THEME.cream, FONT.body, sw - (compact ? 80 : 120));
        if (it.sell > 0) {
            const sbw = compact ? 76 : 104, sbh = compact ? 20 : 26;
            ui.button(`shop-sell-${id}`, sx + sw - sbw, y, sbw, sbh, `SELL ${money(it.sell)}`, "dark", () => g.act("shop-sell", id), { size: compact ? 9 : 10 });
        }
        y += sRowH;
    }
    p.text("ESC / B / CIRCLE TO LEAVE", px + (compact ? 12 : 20), py + ph - (compact ? 18 : 30), compact ? 10 : 12, THEME.dim, FONT.head);
}

// --- HUD overlays: sky markers, the mini map, capture and flight ---------------------------------

const MARKER_PRIORITY: Record<string, number> = { mission: 0, hq: 1, compound: 2, city: 3, town: 4, shop: 5 };

/**
 * Sky markers, most important first. Markers pinned to the screen's edge stay clear of the HUD's
 * corner panels, and a label that would overlap one already placed slides down (or is left off,
 * keeping its square).
 */
export function layoutMarkers(markers: readonly ScreenMarker[], W: number, H: number): { m: ScreenMarker; x: number; y: number; label: { x: number; y: number; w: number; text: string } | null }[] {
    const placed: { x: number; y: number; w: number; h: number }[] = [];
    const out: ReturnType<typeof layoutMarkers> = [];
    const top = 160, bottom = H - 190;
    const order = [...markers].sort((a, b) => (MARKER_PRIORITY[a.kind] ?? 5) - (MARKER_PRIORITY[b.kind] ?? 5));
    for (const m of order) {
        let { x, y } = m;
        if (!m.onScreen) { y = Math.max(top, Math.min(bottom, y)); x = Math.max(12, Math.min(W - 12, x)); }
        const text = `${m.label}  ${m.distance}`;
        const w = textWidth(text, 12, FONT.head) + 12, h = 18;
        let lx = Math.max(4, Math.min(W - w - 4, x - w / 2)), ly = y + 10;
        let ok = false;
        for (let t = 0; t < 6 && !ok; t++) {
            ok = !placed.some(r => lx < r.x + r.w && lx + w > r.x && ly < r.y + r.h && ly + h > r.y);
            if (!ok) ly += h + 2;
        }
        if (ok) placed.push({ x: lx, y: ly, w, h });
        out.push({ m, x, y, label: ok ? { x: lx, y: ly, w, text } : null });
    }
    return out;
}

function drawMarkers(g: GameView, ui: UiFrame): void {
    const p = ui.p;
    for (const { m, x, y, label } of layoutMarkers(g.markers ?? [], ui.W, ui.H)) {
        const s = m.kind === "hq" || m.kind === "mission" ? 14 : m.kind === "city" ? 12 : m.kind === "shop" ? 11 : 9;
        const edge = m.onScreen ? 1 : 0.8;
        // Shops: their awning's color in a gold ring, so they stand out from towns.
        if (m.kind === "shop") p.rect(x - s / 2 - 3, y - s / 2 - 3, s + 6, s + 6, withAlpha(THEME.gold, 0.9 * edge), 1, THEME.black);
        p.rect(x - s / 2, y - s / 2, s, s, withAlpha(m.color, 0.95 * edge), 2, THEME.black);
        if (m.kind === "hq") p.rect(x - 2, y - s / 2 - 10, 4, 10, m.color);
        if (label) p.text(label.text, label.x, label.y, 12, m.kind === "compound" ? [1, 0.75, 0.7, 1] : THEME.cream, FONT.head, label.w, 18, [0.04, 0.035, 0.035, 0.6]);
    }
}

export const MINIMAP_SIZE = 220;

function drawMiniMap(g: GameView, ui: UiFrame): void {
    const m = g.minimap;
    if (!m) return;
    const { p, W, H } = ui;
    const size = MINIMAP_SIZE, x0 = W - size - 16, y0 = H - size - 56, k = size / m.cells;
    p.rect(x0 - 3, y0 - 3, size + 6, size + 6, [0.04, 0.035, 0.035, 0.9], 2, THEME.gold);
    p.rect(x0, y0, size, size, [0.2, 0.24, 0.18, 0.85]);
    for (const [row, a, b, what] of m.runs)
        p.rect(x0 + a * k, y0 + row * k, (b - a + 1) * k, k, what === 2 ? [0.15, 0.3, 0.5, 0.95] : [0.55, 0.52, 0.46, 0.95]);
    for (const d of m.dots) p.rect(x0 + d.x * k - d.size / 2, y0 + d.y * k - d.size / 2, d.size, d.size, d.color, 1, THEME.black);
    // You: a dot and three ticks toward where you face.
    const cx = x0 + size / 2, cy = y0 + size / 2;
    for (let i = 1; i <= 3; i++) p.rect(cx + Math.sin(m.heading) * i * 5 - 1.5, cy - Math.cos(m.heading) * i * 5 - 1.5, 3, 3, THEME.cream);
    p.rect(cx - 4, cy - 4, 8, 8, THEME.gold, 2, THEME.black);
    p.text("N", x0 + size / 2 - 5, y0 - 2, 12, THEME.gold, FONT.head);
    p.text(`${Math.round(m.cells * m.cellMeters)} m`, x0 + 4, y0 + size - 18, 11, THEME.cream, FONT.head);
}

function drawCaptureAndFlight(g: GameView, ui: UiFrame): void {
    const { p, W } = ui;
    const cap = g.capture;
    if (cap) {
        const w = 420, x = (W - w) / 2, y = 64;
        p.rect(x, y, w, 52, [0.3, 0.05, 0.05, 0.88], 2, THEME.gold);
        p.textC(cap.state === "raising" ? `RAISING THE FLAG OVER ${cap.name.toUpperCase()}` : cap.defenders > 0 ? `${cap.name.toUpperCase()}: ${cap.defenders} DEFENDER${cap.defenders === 1 ? "" : "S"} LEFT` : `${cap.name.toUpperCase()} IS CLEAR - GO TO THE FLAG`, W / 2, y + 6, 14, THEME.cream, FONT.head);
        p.bar(x + 14, y + 30, w - 28, 12, cap.raise, THEME.gold);
    }
    const car = g.car;
    if (car) {
        const x = 14, y = ui.H - 160;
        p.text(`BOOST ${Math.round(car.boost * 100)}%   ${Math.round(car.speed * 3.6)} KM/H   ALT ${Math.round(car.altitude)} / ${fmt(car.ceiling)} M`, x, y - 22, 13, THEME.gold, FONT.head);
        p.bar(x, y, 352, 12, car.boost, [0.2, 0.7, 1, 1]);
        const cb = car.cobra;
        if (cb) {
            // The Cobra: hull (red when failing) and the solar cells, one box per missile.
            const hy = y - 64;
            p.text(`COBRA HULL ${Math.round(cb.hull)} / ${cb.maxHull}`, x, hy - 20, 13, cb.hull < cb.maxHull * 0.3 ? THEME.red : THEME.cream, FONT.head);
            p.bar(x, hy, 352, 12, cb.hull / cb.maxHull, cb.hull < cb.maxHull * 0.3 ? THEME.red : [0.55, 0.75, 0.35, 1]);
            p.text(`SOLAR MISSILES ${Math.floor(cb.cells)}`, x + 372, hy - 20, 13, THEME.gold, FONT.head);
            const cw = 22;
            for (let i = 0; i < cb.maxCells; i++) {
                const fill = Math.max(0, Math.min(1, cb.cells - i));
                p.rect(x + 372 + i * (cw + 4), hy, cw, 12, [0.08, 0.1, 0.18, 0.9], 1, THEME.gold);
                if (fill > 0) p.rect(x + 372 + i * (cw + 4), hy + 12 * (1 - fill), cw, 12 * fill, fill >= 1 ? [1, 0.8, 0.25, 1] : [0.35, 0.5, 0.9, 1]);
            }
        }
    }
    if (g.indoors) p.text(`INSIDE ${g.indoors.toUpperCase()}  -  E AT THE DOOR TO LEAVE`, 444, 34, 12, THEME.gold, FONT.head);
    const ap = g.autopilot;
    if (ap) {
        const text = ap.on ? `AUTOPILOT: ${ap.name.toUpperCase()}  ${ap.km >= 10 ? Math.round(ap.km) : ap.km.toFixed(1)} KM${ap.warp > 1.05 ? `  TIME x${Math.round(ap.warp)}` : ""}   P / ANY CONTROL TAKES OVER`
            : `DESTINATION: ${ap.name.toUpperCase()}  ${Math.round(ap.km)} KM   P ENGAGES THE AUTOPILOT${g.piloting ? "" : " ONCE ABOARD"}`;
        const w = Math.min(W - 40, textWidth(text, 14, FONT.head) + 30);
        p.rect((W - w) / 2, 124, w, 28, ap.on ? [0.05, 0.2, 0.35, 0.9] : [0.04, 0.035, 0.035, 0.8], 2, [0.3, 0.7, 1, 1]);
        p.textC(text, W / 2, 129, 14, THEME.cream, FONT.head);
    }
}

export { holder, weaponById, type RegionDef };
