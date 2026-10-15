// Allegiance online: the session with the Indie Machine API and the realtime link, for the game
// (allegiance.ts). It founds and loads nations, keeps the campaign's territory in step with the
// server (al_net.ts), uploads saves, and holds what the screens show about the connection. There
// is no offline mode: every failure is kept in `problem` (and toasted) for the player to see.

import { Api, NetError, apiBase, localTokens, type TokenStore } from "../net/api";
import { Realtime, type NetStatus, type RealtimeHandlers } from "../net/realtime";
import type { FoundRequest, NationInfo, PlayerInfo, ServerRoomMessage, TerritoryRow, WorldEvent } from "../net/protocol";
import { isNationFaction, regionDefById } from "./al_data";
import { migrateCampaign, restoreSettlements, SAVE_VERSION, type Campaign, type RegionState } from "./al_state";
import { territoryHooks } from "./al_world";
import { applyRows, applyUnknown, holdings, previousFor, regionInfo, worldNews } from "./al_net";

export type OnlinePhase = "connecting" | "ready" | "expired" | "error";

/** What the screens show about being online. */
export interface OnlineView {
    phase: OnlinePhase;
    /** Why the last thing failed (null when all is well). */
    problem: string | null;
    player: PlayerInfo | null;
    nation: NationInfo | null;
    busy: string | null;
    net: NetStatus;
    saveError: string | null;
}

export interface OnlineHooks {
    campaign(): Campaign | null;
    toast(text: string, kind: "good" | "bad" | "info"): void;
    hit(m: Extract<ServerRoomMessage, { t: "hit" }>): void;
    shot(m: Extract<ServerRoomMessage, { t: "shot" }>): void;
    /** A region changed hands here because of the server (to refresh maps and markers). */
    territoryChanged(): void;
}

/** Saves go up at most this often (and right away on a new day or the SAVE button). */
export const SAVE_EVERY_MS = 15_000;

export class Online {
    readonly api: Api;
    readonly rt: Realtime;
    phase: OnlinePhase = "connecting";
    problem: string | null = null;
    busy: string | null = null;
    saveError: string | null = null;
    /** Set while the server's rows are applied, so the losses they cause aren't reported back. */
    readonly quiet = { on: false };
    private queue: Promise<unknown> = Promise.resolve();
    private since: string | null = null;
    private lastSave = 0;
    private saveTimer: ReturnType<typeof setTimeout> | null = null;
    private saving = false;
    private inWorld = false;

    constructor(private hooks: OnlineHooks, opts: { base?: string; tokens?: TokenStore; fetcher?: typeof fetch; Socket?: typeof WebSocket } = {}) {
        this.api = new Api(opts.base ?? apiBase(), opts.tokens ?? localTokens, opts.fetcher);
        const handlers: RealtimeHandlers = {
            territory: rows => this.onRows(rows),
            event: e => this.onEvent(e),
            hit: m => hooks.hit(m),
            shot: m => hooks.shot(m),
            problem: message => { this.problem = message; hooks.toast(message, "bad"); },
        };
        this.rt = new Realtime(this.api, handlers, opts.Socket);
        territoryHooks.taken = (c, rs, how, previous) => { if (!this.quiet.on && this.inWorld) this.enqueue(() => this.claim(c, rs, how, previous)); };
        territoryHooks.lost = (c, rs, to, why) => { if (!this.quiet.on && this.inWorld && !isNationFaction(to)) this.enqueue(() => this.release(rs, to, why)); };
    }

    view(): OnlineView {
        return { phase: this.phase, problem: this.problem, player: this.api.player, nation: this.api.nation, busy: this.busy, net: this.rt.status, saveError: this.saveError };
    }

    private fail(e: unknown, what: string): string {
        const msg = `${what}: ${(e as Error).message}`;
        this.problem = msg;
        this.hooks.toast(msg, "bad");
        return msg;
    }

    /** Opens (or resumes) this device's session. */
    async connect(): Promise<void> {
        this.phase = "connecting";
        this.problem = null;
        try {
            await this.api.session();
            this.phase = "ready";
        } catch (e) {
            this.phase = e instanceof NetError && e.status === 401 ? "expired" : "error";
            this.problem = (e as Error).message;
        }
    }

    /** Leaves an expired session behind and plays as a new anonymous player. */
    async startAnonymous(): Promise<void> {
        this.phase = "connecting";
        try {
            await this.api.anonymous();
            this.phase = "ready";
            this.problem = null;
        } catch (e) {
            this.phase = "error";
            this.problem = (e as Error).message;
        }
    }

    async signIn(email: string, password: string): Promise<void> {
        await this.api.signIn(email, password);
        this.phase = "ready";
        this.problem = null;
    }

    async createAccount(email: string, password: string): Promise<void> {
        await this.api.createAccount(email, password);
        this.hooks.toast(`Account created: ${email}. Your nation is saved to it.`, "good");
    }

    /** Founds a nation on the server (dissolving any old one). */
    async found(req: FoundRequest): Promise<NationInfo> {
        this.busy = "Founding your nation...";
        try {
            const r = await this.api.found(req);
            if (r.pushError) this.hooks.toast(`Founded, but players online weren't told: ${r.pushError}`, "bad");
            return r.nation;
        } finally {
            this.busy = null;
        }
    }

    /** Your nation's saved campaign. */
    async loadCampaign(): Promise<Campaign> {
        this.busy = "Loading your nation...";
        try {
            const r = await this.api.loadNation();
            if (!r.save) throw new NetError(404, "no-save", `${r.nation.name} has no saved campaign on the server yet.`);
            if (r.saveVersion !== SAVE_VERSION) throw new NetError(409, "save-version", `${r.nation.name}'s save is version ${r.saveVersion}; this game reads version ${SAVE_VERSION}.`);
            return migrateCampaign(restoreSettlements(r.save as Campaign));
        } finally {
            this.busy = null;
        }
    }

    /**
     * Brings the campaign in step with the server's territory map, reports what it holds, and
     * joins the realtime world. Throws (with the reason) when the map can't be loaded.
     */
    async enterWorld(c: Campaign): Promise<void> {
        const nation = this.api.nation;
        if (!nation) throw new NetError(409, "no-nation", "No nation to play.");
        this.busy = "Reading the world's territory...";
        try {
            const { rows, now } = await this.api.territories(null);
            this.since = now;
            this.applyServerRows(c, rows);
            this.inWorld = true;
            await this.report(c);
        } finally {
            this.busy = null;
        }
        this.rt.start();
    }

    leaveWorld(): void {
        this.inWorld = false;
        this.rt.stop();
        if (this.saveTimer) clearTimeout(this.saveTimer);
        this.saveTimer = null;
    }

    private applyServerRows(c: Campaign, rows: TerritoryRow[]): void {
        const r = applyRows(c, rows, this.api.nation!.id, this.quiet);
        if (r.changed.length) this.hooks.territoryChanged();
        if (r.unknown.length) console.warn(`[allegiance] ${r.unknown.length} territory rows name places this client can't rebuild: ${r.unknown.slice(0, 5).join(", ")}`);
    }

    private onRows(rows: TerritoryRow[]): void {
        const c = this.hooks.campaign();
        if (!c || !this.inWorld) return;
        const mine = this.api.nation!.id;
        for (const row of rows) {
            const rs = c.regions[row.regionId];
            if (rs?.governor === "party" && row.nation && row.nation.id !== mine) this.hooks.toast(`${row.nation.name} has seized ${row.name}!`, "bad");
        }
        this.applyServerRows(c, rows);
        for (const row of rows) if (!this.since || row.updatedAt > this.since) this.since = row.updatedAt;
    }

    private onEvent(e: WorldEvent): void {
        const c = this.hooks.campaign();
        if (!c) return;
        worldNews(c, e.text, e.nationId === this.api.nation?.id);
    }

    private enqueue(job: () => Promise<void>): void {
        this.queue = this.queue.then(job, job);
    }

    private async claim(c: Campaign, rs: RegionState, how: "election" | "coup" | "war", previous: string): Promise<void> {
        const name = regionDefById(rs.id)?.name ?? rs.id;
        try {
            const r = await this.api.claim({ region: regionInfo(c, rs), how, previous: previousFor(previous), army: Math.round(rs.army), support: Math.max(0, Math.min(1, rs.support.party ?? 0)) });
            // A repelled claim puts the region back first; the survivors stay in it after.
            if (!r.ok) this.applyServerRows(c, [r.row]);
            if (isNationFaction(previous) || !r.ok) {
                rs.army = r.army;
                this.hooks.toast(r.message, r.ok ? "good" : "bad");
            }
            if (r.pushError) this.hooks.toast(`${name} is recorded, but players online weren't told: ${r.pushError}`, "bad");
        } catch (e) {
            this.fail(e, `The server didn't record ${name}`);
            // The server's record stands: read it back so the map shows the truth.
            await this.refresh(c);
        }
    }

    private async release(rs: RegionState, to: string, why: string): Promise<void> {
        const name = regionDefById(rs.id)?.name ?? rs.id;
        try {
            const r = await this.api.release({ regionId: rs.id, to: to as never, why: why.slice(0, 120) });
            if (r.pushError) this.hooks.toast(`${name}'s fall is recorded, but players online weren't told: ${r.pushError}`, "bad");
        } catch (e) {
            this.fail(e, `The server didn't record the loss of ${name}`);
            const c = this.hooks.campaign();
            if (c) await this.refresh(c);
        }
    }

    /** Re-reads territory changed since the last read. */
    async refresh(c: Campaign): Promise<void> {
        try {
            const { rows, now } = await this.api.territories(this.since);
            this.since = now;
            this.applyServerRows(c, rows);
        } catch (e) {
            this.fail(e, "Couldn't read the territory map");
        }
    }

    /** The daily report: troops and support where you rule; the server answers with any differences. */
    report(c: Campaign): Promise<void> {
        return new Promise(resolve => this.enqueue(async () => {
            try {
                const r = await this.api.report({ holdings: holdings(c) });
                if (r.rows.length) this.applyServerRows(c, r.rows);
                const lost = applyUnknown(c, r.unknown, this.quiet);
                if (lost.length) this.hooks.toast(`The server has no record of the party holding ${lost.join(", ")}.`, "bad");
            } catch (e) {
                this.fail(e, "The daily territory report failed");
            }
            resolve();
        }));
    }

    /** Uploads the campaign: now, or within SAVE_EVERY_MS of the last upload. */
    save(c: Campaign, now = false): void {
        if (!this.api.nation) return;
        const wait = now ? 0 : Math.max(0, this.lastSave + SAVE_EVERY_MS - Date.now());
        if (this.saveTimer) { if (!now) return; clearTimeout(this.saveTimer); }
        this.saveTimer = setTimeout(() => { this.saveTimer = null; void this.upload(c); }, wait);
    }

    /** Uploads now and throws when it fails (founding a nation waits on its first save). */
    async saveNow(c: Campaign): Promise<void> {
        this.lastSave = Date.now();
        await this.api.save(JSON.parse(JSON.stringify(c)), SAVE_VERSION);
        this.saveError = null;
    }

    private async upload(c: Campaign): Promise<void> {
        if (this.saving) { this.save(c); return; }
        this.saving = true;
        this.lastSave = Date.now();
        try {
            await this.api.save(JSON.parse(JSON.stringify(c)), SAVE_VERSION);
            if (this.saveError) this.hooks.toast("Saving works again.", "good");
            this.saveError = null;
        } catch (e) {
            this.saveError = (e as Error).message;
            this.hooks.toast(`SAVE FAILED: ${this.saveError}`, "bad");
        } finally {
            this.saving = false;
        }
    }

    /** Waits for queued territory requests (tests, and before leaving). */
    settled(): Promise<unknown> { return this.queue; }
}
