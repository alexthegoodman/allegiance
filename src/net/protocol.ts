// The wire format between the Allegiance game, this API and allegiance-realtime. Kept in step by
// hand with indie-machine/lib/allegiance/protocol.ts and allegiance-realtime/src/protocol.ts (same file).

export const AI_FACTIONS = ["concordat", "vanguard", "verdant", "current"] as const;
export const GOVS = ["democracy", "technocracy", "junta", "oligarchy"] as const;
export const HOWS = ["election", "coup", "war"] as const;
export type AiFaction = (typeof AI_FACTIONS)[number];
export type Gov = (typeof GOVS)[number];
export type How = (typeof HOWS)[number];

export interface ApiErrorBody { error: { code: string; message: string } }

export interface PlayerInfo { id: string; email: string | null; anonymous: boolean }

export interface NationSummary { id: string; name: string; leader: string; ideology: string; color: string }

export interface NationInfo extends NationSummary { homeName: string; homeLat: number; homeLon: number; foundedAt: string; savedAt: string | null }

export interface SessionResponse { token: string; player: PlayerInfo; nation: NationInfo | null }

export interface NationResponse { nation: NationInfo; save: unknown | null; saveVersion: number | null }

export interface FoundRequest { name: string; leader: string; ideology: string; color: string; home: { name: string; lat: number; lon: number } }

export interface SaveRequest { save: unknown; saveVersion: number }

/** What the client knows about a region when it claims it (the server stores it with the row). */
export interface RegionInfo { id: string; name: string; kind: string; lat: number; lon: number; pop: number; gov: Gov }

export interface TerritoryRow {
  regionId: string;
  name: string;
  kind: string;
  lat: number;
  lon: number;
  pop: number;
  /** The nation holding it, or null when a regime does. */
  nation: NationSummary | null;
  aiGovernor: AiFaction;
  gov: Gov;
  /** The holder's troops there, after the decay of an absent ruler. */
  army: number;
  support: number;
  takenAt: string | null;
  updatedAt: string;
}

export interface ClaimRequest { region: RegionInfo; how: How; previous: string; army: number; support: number }

export interface ClaimResponse {
  ok: boolean;
  message: string;
  /** The territory as it now stands. */
  row: TerritoryRow;
  /** Your troops left there (after a fight with another nation). */
  army: number;
  /** Set when the change was recorded but connected players could not be told. */
  pushError?: string;
}

export interface ReleaseRequest { regionId: string; to: AiFaction; why: string }

export interface ReportRequest { holdings: { id: string; army: number; support: number; gov: Gov }[] }

/**
 * Where the server's record differs from the client's: `rows` for territory it reported but does
 * not hold (or holds but did not report), `unknown` for reported ids the server has no record of
 * (a regime holds them).
 */
export interface ReportResponse { rows: TerritoryRow[]; unknown: string[] }

export interface TerritoriesResponse { rows: TerritoryRow[]; now: string; more: boolean }

export interface WorldEvent { id: number; at: string; kind: string; text: string; regionId: string | null; nationId: string | null }

export interface EventsResponse { events: WorldEvent[] }

export interface TicketResponse { ticket: string; url: string; expiresAt: string }

// --- Realtime (WebSocket) messages -----------------------------------------------------------

export type Mode = "foot" | "car" | "cobra";

/** Rooms cover cells of this many degrees of latitude and longitude. */
export const CELL_DEG = 0.25;

/** The room a point belongs to. */
export function cellOf(lat: number, lon: number): string {
  return `${Math.floor((lat + 90) / CELL_DEG)}_${Math.floor((lon + 180) / CELL_DEG)}`;
}

/** The latitude/longitude bounds of a cell id (null when it is not one). */
export function cellBounds(cell: string): { lat0: number; lat1: number; lon0: number; lon1: number } | null {
  const m = /^(\d{1,4})_(\d{1,4})$/.exec(cell);
  if (!m) return null;
  const i = Number(m[1]), j = Number(m[2]);
  if (i * CELL_DEG >= 180 || j * CELL_DEG >= 360) return null;
  return { lat0: i * CELL_DEG - 90, lat1: (i + 1) * CELL_DEG - 90, lon0: j * CELL_DEG - 180, lon1: (j + 1) * CELL_DEG - 180 };
}

/** A player as the room relays them: where, how, and who. `alt` is meters from Earth's center
 * minus its radius (the same for every client), `yaw` radians clockwise from north. */
export interface PlayerState {
  id: string;
  nid: string;
  leader: string;
  nation: string;
  color: string;
  lat: number;
  lon: number;
  alt: number;
  yaw: number;
  mode: Mode;
  speed: number;
  health: number;
  weapon: string;
  /** Server time of this state (ms). */
  at: number;
}

export type ClientRoomMessage =
  | { t: "state"; lat: number; lon: number; alt: number; yaw: number; mode: Mode; speed: number; health: number; weapon: string }
  /** A shot from the eye: each pellet along a unit east/north/up direction, stopping at `length` (where it hit a wall for the shooter). */
  | { t: "shot"; weapon: string; lat: number; lon: number; alt: number; pellets: Pellet[] };

export interface Pellet { dir: [number, number, number]; length: number }

export type ServerRoomMessage =
  | { t: "welcome"; you: string; room: string; players: PlayerState[] }
  | { t: "state"; p: PlayerState }
  | { t: "leave"; id: string }
  | { t: "shot"; by: string; weapon: string; lat: number; lon: number; alt: number; pellets: (Pellet & { hit: string | null })[] }
  | { t: "hit"; by: string; leader: string; weapon: string; damage: number }
  | { t: "error"; message: string };

export type ServerWorldMessage =
  | { t: "hello"; online: number }
  | { t: "online"; online: number }
  | { t: "territory"; rows: TerritoryRow[] }
  | { t: "event"; event: WorldEvent };
