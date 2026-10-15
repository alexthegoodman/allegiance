// The Indie Machine API (/api/allegiance): sessions, accounts, nations and their saves, the
// territory map, world news and realtime tickets. Every failure throws a NetError with a message
// meant for the player; nothing here retries or degrades quietly.

import type {
    ClaimRequest, ClaimResponse, EventsResponse, FoundRequest, NationInfo, NationResponse, PlayerInfo, ReleaseRequest, ReportRequest,
    ReportResponse, SessionResponse, TerritoriesResponse, TerritoryRow, TicketResponse,
} from "./protocol";

export class NetError extends Error {
    constructor(public status: number, public code: string, message: string) { super(message); }
}

const TOKEN_KEY = "allegiance.token";

/** The bearer token, kept in localStorage (this device's session). */
export interface TokenStore { get(): string | null; set(token: string | null): void }

export const localTokens: TokenStore = {
    get() {
        try { return localStorage.getItem(TOKEN_KEY); } catch (e) { throw new NetError(0, "storage", `This browser won't let Allegiance keep your session: ${(e as Error).message}`); }
    },
    set(token) {
        try { if (token) localStorage.setItem(TOKEN_KEY, token); else localStorage.removeItem(TOKEN_KEY); } catch (e) {
            throw new NetError(0, "storage", `This browser won't let Allegiance keep your session: ${(e as Error).message}`);
        }
    },
};

export function apiBase(): string {
    const base = import.meta.env.VITE_ALLEGIANCE_API as string | undefined;
    if (!base) throw new NetError(0, "config", "This build has no VITE_ALLEGIANCE_API: it doesn't know where the Allegiance server is.");
    return base.replace(/\/+$/, "");
}

export class Api {
    player: PlayerInfo | null = null;
    nation: NationInfo | null = null;

    constructor(readonly base: string, private tokens: TokenStore, private fetcher: typeof fetch = (...a) => fetch(...a)) {}

    get signedIn(): boolean { return !!this.player; }

    async request<T>(path: string, method = "GET", body?: unknown, auth = true): Promise<T> {
        const token = auth ? this.tokens.get() : null;
        let res: Response;
        try {
            res = await this.fetcher(this.base + path, {
                method,
                headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
                body: body === undefined ? undefined : JSON.stringify(body),
            });
        } catch (e) {
            throw new NetError(0, "offline", `Can't reach the Allegiance server at ${this.base} (${(e as Error).message}).`);
        }
        let data: unknown;
        try { data = await res.json(); } catch {
            throw new NetError(res.status, "bad-response", `The Allegiance server sent an unreadable answer (HTTP ${res.status}).`);
        }
        if (!res.ok) {
            const err = (data as { error?: { code?: string; message?: string } }).error;
            throw new NetError(res.status, err?.code ?? "error", err?.message ?? `The Allegiance server answered HTTP ${res.status}.`);
        }
        return data as T;
    }

    private take(s: SessionResponse): SessionResponse {
        this.tokens.set(s.token);
        this.player = s.player;
        this.nation = s.nation;
        return s;
    }

    /** Resumes this device's session (a 401 NetError when it has expired), or starts an anonymous one. */
    async session(): Promise<SessionResponse> {
        if (this.tokens.get()) return this.take(await this.request<SessionResponse>("/session", "POST"));
        return this.take(await this.request<SessionResponse>("/session", "POST", undefined, false));
    }

    /** Drops this device's session and starts a fresh anonymous one. */
    async anonymous(): Promise<SessionResponse> {
        this.tokens.set(null);
        return this.take(await this.request<SessionResponse>("/session", "POST", undefined, false));
    }

    async createAccount(email: string, password: string): Promise<PlayerInfo> {
        const r = await this.request<{ player: PlayerInfo }>("/account", "POST", { email, password });
        this.player = r.player;
        return r.player;
    }

    async signIn(email: string, password: string): Promise<SessionResponse> {
        return this.take(await this.request<SessionResponse>("/login", "POST", { email, password }, false));
    }

    async found(req: FoundRequest): Promise<{ nation: NationInfo; pushError?: string }> {
        const r = await this.request<{ nation: NationInfo; pushError?: string }>("/nation", "POST", req);
        this.nation = r.nation;
        return r;
    }

    loadNation(): Promise<NationResponse> { return this.request<NationResponse>("/nation"); }

    save(save: unknown, saveVersion: number): Promise<{ savedAt: string }> { return this.request("/save", "PUT", { save, saveVersion }); }

    /** Every territory row changed since `since` (all of them without), following pages. */
    async territories(since: string | null): Promise<{ rows: TerritoryRow[]; now: string }> {
        const rows: TerritoryRow[] = [];
        let cursor = since;
        let now = "";
        for (let page = 0; page < 50; page++) {
            const r = await this.request<TerritoriesResponse>(`/territories${cursor ? `?since=${encodeURIComponent(cursor)}` : ""}`);
            rows.push(...r.rows);
            now = r.now;
            if (!r.more || !r.rows.length) break;
            cursor = r.rows[r.rows.length - 1].updatedAt;
        }
        return { rows, now };
    }

    claim(req: ClaimRequest): Promise<ClaimResponse> { return this.request("/territories/claim", "POST", req); }
    release(req: ReleaseRequest): Promise<{ row: TerritoryRow | null; pushError?: string }> { return this.request("/territories/release", "POST", req); }
    report(req: ReportRequest): Promise<ReportResponse> { return this.request("/territories/report", "POST", req); }
    events(after = 0): Promise<EventsResponse> { return this.request(`/events?after=${after}`); }
    ticket(): Promise<TicketResponse> { return this.request("/ticket", "POST"); }
}
