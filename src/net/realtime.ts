// The live link to allegiance-realtime: a socket to the World hub (territory changes, world news,
// players online) and one to the Room of the map cell you stand in (others' moves, street fights).
// Rooms change as you cross cells. A dropped socket reconnects with a fresh ticket while the HUD
// says so; being signed in elsewhere stops it for good. Remote players are drawn 150 ms in the
// past, between the two states around that moment.

import type { Api } from "./api";
import { CELL_DEG, cellBounds, cellOf, type ClientRoomMessage, type Mode, type Pellet, type PlayerState, type ServerRoomMessage, type ServerWorldMessage, type TerritoryRow, type WorldEvent } from "./protocol";

export type SocketStatus = "off" | "connecting" | "open" | "retrying" | "stopped";

export interface NetStatus { world: SocketStatus; room: SocketStatus; cell: string | null; online: number; error: string | null }

export interface LocalState { lat: number; lon: number; alt: number; yaw: number; mode: Mode; speed: number; health: number; weapon: string }

export interface RealtimeHandlers {
    territory(rows: TerritoryRow[]): void;
    event(e: WorldEvent): void;
    hit(m: Extract<ServerRoomMessage, { t: "hit" }>): void;
    shot(m: Extract<ServerRoomMessage, { t: "shot" }>): void;
    /** Something the player must see: refused moves, a socket that dropped and why. */
    problem(message: string): void;
}

/** A remote player, interpolated for drawing. */
export interface RemotePlayer extends PlayerState { stale: boolean }

export const RENDER_DELAY_MS = 150;
/** States are sent at most this often while moving, and at least this often while still. */
export const SEND_MS = 100;
export const IDLE_SEND_MS = 1000;
/** Leave a room only this far (degrees) past its edge, so standing on a border doesn't flap. */
export const ROOM_HYSTERESIS_DEG = 0.01;

type Sample = { t: number; s: PlayerState };

interface Link { ws: WebSocket; cell?: string; status: SocketStatus }

export class Realtime {
    status: NetStatus = { world: "off", room: "off", cell: null, online: 0, error: null };
    private world: Link | null = null;
    private room: Link | null = null;
    private stopped = true;
    private last: { at: number; s: LocalState } | null = null;
    private local: LocalState | null = null;
    private samples = new Map<string, Sample[]>();
    private me: string | null = null;
    /** Failed attempts in a row per socket (backoff), and the pending retry. */
    private tries = { world: 0, room: 0 };
    private timers: { world: ReturnType<typeof setTimeout> | null; room: ReturnType<typeof setTimeout> | null } = { world: null, room: null };

    constructor(private api: Api, private h: RealtimeHandlers, private Socket: typeof WebSocket = WebSocket, private now: () => number = () => performance.now()) {}

    start(): void {
        this.stopped = false;
        this.status.error = null;
        void this.openWorld();
    }

    stop(): void {
        this.stopped = true;
        for (const k of ["world", "room"] as const) { const tm = this.timers[k]; if (tm) clearTimeout(tm); this.timers[k] = null; this.tries[k] = 0; }
        for (const l of [this.world, this.room]) if (l) { try { l.ws.close(1000, "Leaving."); } catch { /* closed */ } }
        this.world = this.room = null;
        this.samples.clear();
        this.status = { world: "off", room: "off", cell: null, online: 0, error: null };
    }

    /** Called every frame with where you are (null: not on the map, e.g. on a menu). */
    update(state: LocalState | null): void {
        if (this.stopped) return;
        this.local = state;
        if (!state) return;
        const cell = this.status.cell;
        const b = cell ? cellBounds(cell) : null;
        const outside = !b || state.lat < b.lat0 - ROOM_HYSTERESIS_DEG || state.lat > b.lat1 + ROOM_HYSTERESIS_DEG || state.lon < b.lon0 - ROOM_HYSTERESIS_DEG || state.lon > b.lon1 + ROOM_HYSTERESIS_DEG;
        if (outside) { this.moveRoom(cellOf(state.lat, state.lon)); return; }
        if (this.room?.status !== "open") return;
        const t = this.now();
        const prev = this.last;
        const changed = !prev || Math.abs(prev.s.lat - state.lat) > 5e-7 || Math.abs(prev.s.lon - state.lon) > 5e-7 || Math.abs(prev.s.alt - state.alt) > 0.05
            || Math.abs(prev.s.yaw - state.yaw) > 0.03 || prev.s.mode !== state.mode || prev.s.health !== state.health || prev.s.weapon !== state.weapon;
        if (prev && (t - prev.at < SEND_MS || (!changed && t - prev.at < IDLE_SEND_MS))) return;
        this.send({ t: "state", ...state });
        this.last = { at: t, s: { ...state } };
    }

    /** Jumped somewhere (respawn, travel): rejoin so the room doesn't take it for a speed hack. */
    teleported(): void {
        if (this.stopped || !this.room) return;
        const cell = this.local ? cellOf(this.local.lat, this.local.lon) : this.status.cell;
        this.closeRoom();
        if (cell) this.moveRoom(cell);
    }

    shoot(weapon: string, at: { lat: number; lon: number; alt: number }, pellets: Pellet[]): void {
        if (this.room?.status !== "open" || !pellets.length) return;
        this.send({ t: "shot", weapon, ...at, pellets });
    }

    /** Remote players in your room as they stood RENDER_DELAY_MS ago. */
    remotes(): RemotePlayer[] {
        const t = this.now() - RENDER_DELAY_MS;
        const out: RemotePlayer[] = [];
        for (const [id, list] of this.samples) {
            if (id === this.me || !list.length) continue;
            const newest = list[list.length - 1];
            let a = list[0], b = list[0];
            for (let i = 0; i < list.length; i++) {
                if (list[i].t <= t) a = list[i];
                if (list[i].t >= t) { b = list[i]; break; }
                b = list[i];
            }
            const k = b.t > a.t ? Math.max(0, Math.min(1, (t - a.t) / (b.t - a.t))) : 1;
            let dyaw = b.s.yaw - a.s.yaw;
            dyaw -= Math.round(dyaw / (Math.PI * 2)) * Math.PI * 2;
            out.push({
                ...b.s,
                lat: a.s.lat + (b.s.lat - a.s.lat) * k, lon: a.s.lon + (b.s.lon - a.s.lon) * k, alt: a.s.alt + (b.s.alt - a.s.alt) * k,
                yaw: a.s.yaw + dyaw * k, speed: a.s.speed + (b.s.speed - a.s.speed) * k,
                stale: this.now() - newest.t > 5000,
            });
        }
        return out;
    }

    // --- Sockets ---------------------------------------------------------------------------------

    private send(m: ClientRoomMessage): void {
        try { this.room!.ws.send(JSON.stringify(m)); } catch (e) { this.problem(`Couldn't send to the room: ${(e as Error).message}`); }
    }

    private problem(message: string): void {
        this.status.error = message;
        this.h.problem(message);
    }

    private async connect(path: string, kind: "world" | "room", cell?: string): Promise<Link | null> {
        this.status[kind] = "connecting";
        let ticket;
        try { ticket = await this.api.ticket(); } catch (e) {
            this.problem(`Realtime ${kind}: ${(e as Error).message}`);
            this.retry(kind, cell);
            return null;
        }
        if (this.stopped || (kind === "room" && cell !== this.status.cell)) return null;
        let ws: WebSocket;
        try { ws = new this.Socket(`${ticket.url}${path}?ticket=${encodeURIComponent(ticket.ticket)}`); } catch (e) {
            this.problem(`Realtime ${kind}: ${(e as Error).message}`);
            this.retry(kind, cell);
            return null;
        }
        const link: Link = { ws, cell, status: "connecting" };
        ws.addEventListener("open", () => {
            link.status = "open"; this.tries[kind] = 0;
            if ((kind === "world" ? this.world : this.room) === link) this.status[kind] = "open";
            if (this.world?.status === "open" && (!this.room || this.room.status === "open")) this.status.error = null;
        });
        ws.addEventListener("message", e => this.onMessage(kind, link, String(e.data)));
        ws.addEventListener("close", e => {
            if ((kind === "world" ? this.world : this.room) !== link || this.stopped) return;
            const why = e.reason || `connection closed (code ${e.code})`;
            if (e.code === 4409 || e.code === 4403) {
                link.status = "stopped"; this.status[kind] = "stopped";
                this.problem(`Realtime ${kind} stopped: ${why}`);
                return;
            }
            this.problem(`Realtime ${kind} dropped: ${why}. Reconnecting...`);
            this.retry(kind, cell);
        });
        return link;
    }

    private retry(kind: "world" | "room", cell?: string): void {
        if (this.stopped) return;
        this.status[kind] = "retrying";
        const n = ++this.tries[kind];
        const wait = Math.min(15000, 1000 * 2 ** (n - 1));
        const old = this.timers[kind];
        if (old) clearTimeout(old);
        this.timers[kind] = setTimeout(() => {
            this.timers[kind] = null;
            if (this.stopped) return;
            if (kind === "world") void this.openWorld();
            else if (cell && cell === this.status.cell) void this.openRoom(cell);
        }, wait);
    }

    private async openWorld(): Promise<void> {
        const link = await this.connect("/world", "world");
        if (link) this.world = link;
    }

    private moveRoom(cell: string): void {
        if (cell === this.status.cell && this.room) return;
        this.closeRoom();
        this.status.cell = cell;
        void this.openRoom(cell);
    }

    private async openRoom(cell: string): Promise<void> {
        const link = await this.connect(`/room/${cell}`, "room", cell);
        if (link) this.room = link;
    }

    private closeRoom(): void {
        const r = this.room;
        this.room = null;
        this.last = null;
        this.samples.clear();
        this.status.room = "off";
        const tm = this.timers.room;
        if (tm) clearTimeout(tm);
        this.timers.room = null;
        this.tries.room = 0;
        if (r) { try { r.ws.close(1000, "Changing rooms."); } catch { /* closed */ } }
    }

    private onMessage(kind: "world" | "room", link: Link, text: string): void {
        let m: ServerRoomMessage | ServerWorldMessage;
        try { m = JSON.parse(text); } catch { this.problem(`Realtime ${kind} sent an unreadable message.`); return; }
        if (kind === "world") {
            const w = m as ServerWorldMessage;
            if (w.t === "hello" || w.t === "online") this.status.online = w.online;
            else if (w.t === "territory") this.h.territory(w.rows);
            else if (w.t === "event") this.h.event(w.event);
            else if ((w as { t: string }).t === "error") this.problem(`Realtime world: ${(w as unknown as { message: string }).message}`);
            return;
        }
        if (link !== this.room) return;
        const r = m as ServerRoomMessage;
        const t = this.now();
        switch (r.t) {
            case "welcome":
                this.me = r.you;
                for (const p of r.players) this.samples.set(p.id, [{ t, s: p }]);
                break;
            case "state": {
                const list = this.samples.get(r.p.id) ?? [];
                list.push({ t, s: r.p });
                while (list.length > 2 && list[1].t < t - RENDER_DELAY_MS - 400) list.shift();
                this.samples.set(r.p.id, list);
                break;
            }
            case "leave": this.samples.delete(r.id); break;
            case "hit": this.h.hit(r); break;
            case "shot": if (r.by !== this.me) this.h.shot(r); break;
            case "error":
                if (r.message === "wrong-room" && this.local) this.moveRoom(cellOf(this.local.lat, this.local.lon));
                else this.problem(`Realtime room: ${r.message}`);
                break;
        }
    }
}

export { CELL_DEG };
