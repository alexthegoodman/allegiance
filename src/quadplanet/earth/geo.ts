// Anchoring to the real world through OpenStreetMap: place names to coordinates (and back) with a
// Nominatim geocoder (ported from QuadPlanet's geo.rs). Nominatim's public instance asks for at
// most one request a second and caching of results - both done here; point `endpoint` at your own
// instance for heavier use. Results are © OpenStreetMap contributors (ODbL).

export const NOMINATIM = "https://nominatim.openstreetmap.org";

export interface Place {
    name: string;
    lat: number;
    lon: number;
    /** OSM class/type, e.g. "natural/peak". */
    kind: string;
}

/** Turns Nominatim's search JSON into places. */
export function parseSearch(json: string): Place[] {
    const hits = JSON.parse(json) as unknown;
    if (!Array.isArray(hits)) throw new Error("unexpected geocoder reply");
    const out: Place[] = [];
    for (const h of hits as Record<string, unknown>[]) {
        const lat = Number(h.lat), lon = Number(h.lon);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
        const cls = String(h.category ?? h.class ?? "");
        out.push({ name: String(h.display_name ?? ""), lat, lon, kind: `${cls}/${String(h.type ?? "")}` });
    }
    return out;
}

export class Geocoder {
    private lastRequest = 0;
    private searchCache = new Map<string, Place[]>();
    /** Reverse lookups by a ~1 km grid cell. */
    private reverseCache = new Map<string, string | null>();
    private reverseInFlight = false;
    readonly endpoint: string;

    constructor(endpoint?: string) {
        this.endpoint = (endpoint ?? NOMINATIM).replace(/\/+$/, "");
    }

    private async throttledGet(url: string): Promise<string> {
        // One request a second, as the public Nominatim asks.
        const wait = this.lastRequest + 1000 - Date.now();
        this.lastRequest = Math.max(Date.now(), this.lastRequest + 1000);
        if (wait > 0) await new Promise(r => setTimeout(r, wait));
        const res = await fetch(url, { headers: { Accept: "application/json" } });
        if (!res.ok) throw new Error(`geocoder request failed: HTTP ${res.status}`);
        return res.text();
    }

    /** Places matching `query`, best first (cached). */
    async search(query: string): Promise<Place[]> {
        const key = query.trim().toLowerCase();
        const hit = this.searchCache.get(key);
        if (hit) return hit;
        const url = `${this.endpoint}/search?format=jsonv2&limit=5&q=${encodeURIComponent(query)}`;
        const places = parseSearch(await this.throttledGet(url));
        this.searchCache.set(key, places);
        return places;
    }

    /** The name of the place at a coordinate if known, starting a lookup in the background if not (poll again later). */
    reverse(lat: number, lon: number): string | null {
        const cell = `${Math.round(lat * 100)},${Math.round(lon * 100)}`;
        if (this.reverseCache.has(cell)) return this.reverseCache.get(cell)!;
        if (this.reverseInFlight) return null;
        this.reverseInFlight = true;
        const url = `${this.endpoint}/reverse?format=jsonv2&zoom=10&lat=${lat.toFixed(5)}&lon=${lon.toFixed(5)}`;
        this.throttledGet(url).then(t => {
            const r = JSON.parse(t) as { display_name?: string; error?: string };
            this.reverseCache.set(cell, r.error ? null : r.display_name ?? null);
        }, () => this.reverseCache.set(cell, null)).finally(() => { this.reverseInFlight = false; });
        return null;
    }
}
