// A small Mapbox Vector Tile (MVT 2.x) decoder: the protobuf format OpenStreetMap vector tiles
// (OpenFreeMap, OpenMapTiles, Protomaps...) are served in. Only what the city layer needs: layers
// by name, each feature's id, type, properties and geometry in tile units. Ported from
// QuadPlanet's mvt.rs.
//
// The format, briefly: a tile is a list of layers; a layer has a name, an extent (tile units per
// side, usually 4096), shared key and value tables, and features. A feature's properties are pairs
// of indices into those tables, and its geometry is a run of commands (MoveTo, LineTo, ClosePath)
// with zigzag-encoded deltas from the previous point.

export type Value = string | number | boolean;

export const GEOM_UNKNOWN = 0, GEOM_POINT = 1, GEOM_LINE = 2, GEOM_POLYGON = 3;

export interface Feature {
    id: number | null;
    geomType: number;
    properties: Map<string, Value>;
    /** Points for a point feature, lines for a line feature, rings for a polygon (open: the first
     * point is not repeated). Tile units, y down. */
    geometry: [number, number][][];
}

export const featureNumber = (f: Feature, key: string): number | null => {
    const v = f.properties.get(key);
    if (v === undefined) return null;
    if (typeof v === "number") return v;
    if (typeof v === "boolean") return v ? 1 : 0;
    const n = Number(v);
    return v.trim() !== "" && Number.isFinite(n) ? n : null;
};
export const featureString = (f: Feature, key: string): string | null => {
    const v = f.properties.get(key);
    return typeof v === "string" ? v : null;
};
export function truthy(v: Value): boolean {
    if (typeof v === "boolean") return v;
    if (typeof v === "number") return v !== 0;
    return v !== "" && v !== "false" && v !== "0";
}

export interface Layer { name: string; extent: number; features: Feature[] }

const utf8 = new TextDecoder("utf-8");

class Pb {
    at = 0;
    constructor(readonly b: Uint8Array) {}
    done(): boolean { return this.at >= this.b.length; }
    varint(): number {
        let v = 0, mul = 1;
        for (let shift = 0; shift < 64; shift += 7) {
            if (this.at >= this.b.length) throw new Error("truncated varint");
            const byte = this.b[this.at++];
            v += (byte & 0x7f) * mul;
            mul *= 128;
            if ((byte & 0x80) === 0) return v;
        }
        throw new Error("varint too long");
    }
    bytes(): Uint8Array {
        const n = this.varint();
        const end = this.at + n;
        if (end > this.b.length) throw new Error("truncated field");
        const s = this.b.subarray(this.at, end);
        this.at = end;
        return s;
    }
    fixed(n: number): Uint8Array {
        const end = this.at + n;
        if (end > this.b.length) throw new Error("truncated fixed field");
        const s = this.b.subarray(this.at, end);
        this.at = end;
        return s;
    }
    key(): [number, number] {
        const k = this.varint();
        return [Math.floor(k / 8), k % 8];
    }
    skip(wire: number): void {
        switch (wire) {
            case 0: this.varint(); break;
            case 1: this.fixed(8); break;
            case 2: this.bytes(); break;
            case 5: this.fixed(4); break;
            default: throw new Error(`unsupported wire type ${wire}`);
        }
    }
    packed(): number[] {
        const inner = new Pb(this.bytes());
        const out: number[] = [];
        while (!inner.done()) out.push(inner.varint() >>> 0);
        return out;
    }
}

const zigzag = (v: number): number => (v >>> 1) ^ -(v & 1);

function decodeValue(b: Uint8Array): Value {
    const p = new Pb(b);
    let out: Value = "";
    while (!p.done()) {
        const [field, wire] = p.key();
        if (field === 1 && wire === 2) out = utf8.decode(p.bytes());
        else if (field === 2 && wire === 5) { const f = p.fixed(4); out = new DataView(f.buffer, f.byteOffset, 4).getFloat32(0, true); }
        else if (field === 3 && wire === 1) { const f = p.fixed(8); out = new DataView(f.buffer, f.byteOffset, 8).getFloat64(0, true); }
        else if ((field === 4 || field === 5) && wire === 0) out = p.varint();
        else if (field === 6 && wire === 0) { const v = p.varint(); out = v % 2 === 0 ? v / 2 : -(v + 1) / 2; }
        else if (field === 7 && wire === 0) out = p.varint() !== 0;
        else p.skip(wire);
    }
    return out;
}

function decodeGeometry(cmds: number[], geomType: number): [number, number][][] {
    const out: [number, number][][] = [];
    let x = 0, y = 0, i = 0;
    while (i < cmds.length) {
        const id = cmds[i] & 7;
        const count = cmds[i] >>> 3;
        i++;
        if (id === 1 || id === 2) {
            for (let c = 0; c < count; c++) {
                if (i + 1 >= cmds.length) return out;
                const dx = cmds[i], dy = cmds[i + 1];
                i += 2;
                x = (x + zigzag(dx)) | 0;
                y = (y + zigzag(dy)) | 0;
                if (id === 1 && (geomType !== GEOM_POINT || out.length === 0)) out.push([]);
                out[out.length - 1]?.push([x, y]);
            }
        } else if (id === 7) {
            // ClosePath: rings are kept open (the first point isn't repeated).
        } else return out;
    }
    return out;
}

function decodeFeature(b: Uint8Array, keys: string[], values: Value[]): Feature {
    const p = new Pb(b);
    const f: Feature = { id: null, geomType: GEOM_UNKNOWN, properties: new Map(), geometry: [] };
    let tags: number[] = [], cmds: number[] = [];
    while (!p.done()) {
        const [field, wire] = p.key();
        if (field === 1 && wire === 0) f.id = p.varint();
        else if (field === 2 && wire === 2) tags = p.packed();
        else if (field === 3 && wire === 0) { const t = p.varint(); f.geomType = t >= 1 && t <= 3 ? t : GEOM_UNKNOWN; }
        else if (field === 4 && wire === 2) cmds = p.packed();
        else p.skip(wire);
    }
    for (let k = 0; k + 1 < tags.length; k += 2) {
        const key = keys[tags[k]], value = values[tags[k + 1]];
        if (key !== undefined && value !== undefined) f.properties.set(key, value);
    }
    f.geometry = decodeGeometry(cmds, f.geomType);
    return f;
}

/** Decodes the layers named in `wanted` (all layers when it is empty). */
export function decodeTile(tile: Uint8Array, wanted: readonly string[]): Layer[] {
    const p = new Pb(tile);
    const layers: Layer[] = [];
    while (!p.done()) {
        const [field, wire] = p.key();
        if (field !== 3 || wire !== 2) { p.skip(wire); continue; }
        const lp = new Pb(p.bytes());
        // First pass: the name, extent and tables; features need the tables to decode.
        let name = "", extent = 4096;
        const keys: string[] = [], values: Value[] = [], features: Uint8Array[] = [];
        while (!lp.done()) {
            const [f, w] = lp.key();
            if (f === 1 && w === 2) name = utf8.decode(lp.bytes());
            else if (f === 2 && w === 2) features.push(lp.bytes());
            else if (f === 3 && w === 2) keys.push(utf8.decode(lp.bytes()));
            else if (f === 4 && w === 2) values.push(decodeValue(lp.bytes()));
            else if (f === 5 && w === 0) extent = lp.varint();
            else lp.skip(w);
        }
        if (wanted.length && !wanted.includes(name)) continue;
        layers.push({ name, extent: Math.max(1, extent), features: features.map(b => decodeFeature(b, keys, values)) });
    }
    return layers;
}

/** Twice the signed area of a ring (shoelace, tile units). Positive for an exterior ring in MVT. */
export function ringArea2(ring: readonly [number, number][]): number {
    let a = 0;
    for (let i = 0; i < ring.length; i++) {
        const p = ring[i], q = ring[(i + 1) % ring.length];
        a += p[0] * q[1] - q[0] * p[1];
    }
    return a;
}
