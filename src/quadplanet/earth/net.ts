// Map data from the network, kept in the browser's Cache Storage for good: a place you've been
// looks (and loads) the same next time. Elevation and OpenStreetMap tiles are immutable per URL,
// so a cached response is never revalidated.

const CACHE_NAME = "allegiance-tiles-v1";
let cachePromise: Promise<Cache | null> | null = null;

function openCache(): Promise<Cache | null> {
    cachePromise ??= typeof caches === "undefined" ? Promise.resolve(null) : caches.open(CACHE_NAME).catch(() => null);
    return cachePromise;
}

export interface FetchStats { hits: number; fetched: number; missing: number; errors: number }
export const fetchStats: FetchStats = { hits: 0, fetched: 0, missing: 0, errors: 0 };

/**
 * The response for `url`: from the cache, else fetched (and cached when it succeeded). Null when
 * the server says there is nothing there (404 / 204); throws on network trouble or other errors,
 * which are worth retrying.
 */
export async function fetchCached(url: string): Promise<Response | null> {
    const cache = await openCache();
    if (cache) {
        const hit = await cache.match(url);
        if (hit) { fetchStats.hits++; return hit.status === 204 ? null : hit; }
    }
    // A request that hangs would hold its tile pending for good: give up after 20 s (retried).
    const res = await fetch(url, { mode: "cors", credentials: "omit", signal: AbortSignal.timeout(20000) });
    if (res.status === 404 || res.status === 204) {
        fetchStats.missing++;
        return null;
    }
    if (!res.ok) { fetchStats.errors++; throw new Error(`${url}: HTTP ${res.status}`); }
    fetchStats.fetched++;
    if (cache) await cache.put(url, res.clone()).catch(() => undefined);
    return res;
}

/** Remembers that `url` has nothing (an empty OpenStreetMap tile over the sea), so it isn't asked again. */
export async function cacheMissing(url: string): Promise<void> {
    const cache = await openCache();
    if (cache) await cache.put(url, new Response(null, { status: 204 })).catch(() => undefined);
}
