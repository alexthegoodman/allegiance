// The campaign and the MMO's territory map (src/net/). The server records who holds what between
// players; this campaign's sim proposes changes (al_world territoryHooks: a claim when the party
// takes a region, a release when a regime takes one back) and takes the server's rows as truth:
// - rows held by you: governed by the party here;
// - rows held by another nation: governed by that nation's faction ("nation-<id>", registered with
//   al_data), its troops as the garrison you must beat and its support among the people;
// - rows back with a regime: that regime governs again.
// Plain functions over the Campaign, so the tests drive them without a browser.

import { NATION_PREFIX, PARTY, UNDECIDED, isNationFaction, registerFaction, regionDefById, RIVALS, type RGBA } from "./al_data";
import { baseGarrison, campaignRegions, discoverSettlement, normalizeSupport, partyShare, pushNews, type Campaign, type RegionState } from "./al_state";
import { loseRegion } from "./al_world";
import type { AiFaction, Gov, NationSummary, RegionInfo, ReportRequest, TerritoryRow } from "../net/protocol";

export const nationFaction = (nationId: string): string => `${NATION_PREFIX}${nationId}`;

export function hexToRgba(hex: string): RGBA {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255, 1];
}

export function rgbaToHex(c: RGBA | readonly number[]): string {
    return "#" + [c[0], c[1], c[2]].map(v => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, "0")).join("");
}

/** Registers another player's nation as a faction and returns its id. */
export function registerNation(n: NationSummary): string {
    const id = nationFaction(n.id);
    registerFaction({ id, name: n.name, short: n.name.toUpperCase().slice(0, 14), color: hexToRgba(n.color), topics: [], drive: 0, motto: `Led by ${n.leader}.` });
    return id;
}

const isAi = (id: string): id is AiFaction => (RIVALS as string[]).includes(id);

/** What the server needs to know about a region the party claims. */
export function regionInfo(c: Campaign, rs: RegionState): RegionInfo {
    const d = regionDefById(rs.id)!;
    return { id: d.id, name: d.name, kind: d.kind ?? "territory", lat: d.lat, lon: d.lon, pop: d.pop, gov: rs.gov as Gov };
}

/** Every region the party governs, with its troops and support, for the periodic report. */
export function holdings(c: Campaign): ReportRequest["holdings"] {
    return Object.values(c.regions).filter(rs => rs.governor === PARTY)
        .map(rs => ({ id: rs.id, army: Math.max(0, Math.round(rs.army)), support: Math.max(0, Math.min(1, partyShare(rs))), gov: rs.gov as Gov }));
}

/** A claim needs the regime it was taken from, or "nation" when it was another player's. */
export const previousFor = (governor: string): string => (isAi(governor) ? governor : isNationFaction(governor) ? "nation" : "concordat");

/** The region a row is about, discovering a settlement this campaign has not seen yet. */
function regionOf(c: Campaign, row: TerritoryRow): RegionState | null {
    if (c.regions[row.regionId]) return c.regions[row.regionId];
    if (!row.regionId.startsWith("place-")) return null;
    try {
        const d = discoverSettlement(c, { name: row.name, lat: row.lat, lon: row.lon, kind: row.kind });
        return d.id === row.regionId ? c.regions[d.id] : null;
    } catch {
        return null;
    }
}

/** Puts a share of the people behind `faction`, the rest scaled to fit. */
function setSupport(rs: RegionState, faction: string, share: number): void {
    const s = rs.support;
    const target = Math.max(0, Math.min(0.95, share));
    const rest = Object.keys(s).filter(k => k !== faction).reduce((a, k) => a + s[k], 0);
    const scale = rest > 0 ? (1 - target) / rest : 0;
    for (const k of Object.keys(s)) if (k !== faction) s[k] *= scale;
    if (rest <= 0) s[UNDECIDED] = 1 - target;
    s[faction] = target;
    normalizeSupport(s);
}

export interface ApplyResult { changed: string[]; unknown: string[] }

/**
 * Makes the campaign agree with the server's rows. Returns the regions whose governor changed here
 * and rows it couldn't place (a settlement id this client can't rebuild). Losing a region this
 * way goes through loseRegion with `quiet` so it is not reported back as a release.
 */
export function applyRows(c: Campaign, rows: TerritoryRow[], myNationId: string, quiet: { on: boolean }): ApplyResult {
    const changed: string[] = [], unknown: string[] = [];
    quiet.on = true;
    try {
        for (const row of rows) {
            const rs = regionOf(c, row);
            if (!rs) { unknown.push(row.regionId); continue; }
            const before = rs.governor;
            if (row.nation?.id === myNationId) {
                if (rs.governor !== PARTY) {
                    rs.governor = PARTY; rs.gov = row.gov; rs.war = null; rs.threat = null;
                    rs.army = Math.max(rs.army, row.army);
                    rs.garrison = Math.round(baseGarrison(regionDefById(rs.id)!, rs.gov) * 0.05);
                }
            } else if (row.nation) {
                const id = registerNation(row.nation);
                if (rs.governor === PARTY) loseRegion(c, rs, id, `seized by ${row.nation.name}`);
                rs.governor = id; rs.gov = row.gov; rs.threat = null;
                if (rs.war && rs.war.attacker !== PARTY) rs.war = null;
                rs.garrison = row.army;
                if (rs.war) rs.war.defender = id;
                setSupport(rs, id, row.support);
            } else if (rs.governor === PARTY) {
                loseRegion(c, rs, row.aiGovernor, "the regime's hold on it was never broken");
            } else if (isNationFaction(rs.governor)) {
                rs.governor = row.aiGovernor; rs.gov = row.gov;
                rs.garrison = baseGarrison(regionDefById(rs.id)!, rs.gov);
                delete rs.support[before];
                normalizeSupport(rs.support);
                if (rs.war) rs.war.defender = row.aiGovernor;
            }
            if (rs.governor !== before) changed.push(rs.id);
        }
    } finally {
        quiet.on = false;
    }
    return { changed, unknown };
}

/** Report answers: ids the server has no record of are regime-held. */
export function applyUnknown(c: Campaign, ids: string[], quiet: { on: boolean }): string[] {
    const lost: string[] = [];
    quiet.on = true;
    try {
        for (const id of ids) {
            const rs = c.regions[id];
            if (!rs || rs.governor !== PARTY) continue;
            const def = regionDefById(id);
            loseRegion(c, rs, "concordat", "the Allegiance server has no record of the party holding it");
            lost.push(def?.name ?? id);
        }
    } finally {
        quiet.on = false;
    }
    return lost;
}

/** World news from the server goes on the campaign's news line too. */
export function worldNews(c: Campaign, text: string, mine: boolean): void {
    pushNews(c, `WORLD: ${text}`, mine ? "good" : "war");
}

/** Regions any nation (yours included) holds, for the map and the HUD. */
export const nationRegions = (c: Campaign): RegionState[] => campaignRegions(c).map(d => c.regions[d.id]).filter(rs => rs.governor === PARTY || isNationFaction(rs.governor));
