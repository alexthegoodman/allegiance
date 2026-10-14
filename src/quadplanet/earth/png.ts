// A small PNG decoder for elevation tiles (8-bit gray / RGB / RGBA, not interlaced), for places
// without an image decoder (Node tests). The browser decodes with createImageBitmap instead
// (elevation.ts decodeTerrarium). `inflate` is zlib's inflate (node:zlib inflateSync).

export interface DecodedImage { width: number; height: number; channels: number; data: Uint8Array }

export function decodePng(bytes: Uint8Array, inflate: (data: Uint8Array) => Uint8Array): DecodedImage {
    const sig = [137, 80, 78, 71, 13, 10, 26, 10];
    for (let i = 0; i < 8; i++) if (bytes[i] !== sig[i]) throw new Error("not a PNG");
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let at = 8, width = 0, height = 0, depth = 0, type = 0, interlace = 0;
    const idat: Uint8Array[] = [];
    while (at + 8 <= bytes.length) {
        const len = view.getUint32(at);
        const kind = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]);
        const body = bytes.subarray(at + 8, at + 8 + len);
        if (kind === "IHDR") {
            const v = new DataView(body.buffer, body.byteOffset, body.byteLength);
            width = v.getUint32(0); height = v.getUint32(4); depth = body[8]; type = body[9]; interlace = body[12];
        } else if (kind === "IDAT") idat.push(body);
        else if (kind === "IEND") break;
        at += 12 + len;
    }
    if (depth !== 8 || interlace !== 0) throw new Error(`unsupported PNG: depth ${depth}, interlace ${interlace}`);
    const channels = type === 0 ? 1 : type === 2 ? 3 : type === 6 ? 4 : type === 4 ? 2 : 0;
    if (!channels) throw new Error(`unsupported PNG color type ${type}`);
    const total = idat.reduce((n, c) => n + c.length, 0);
    const z = new Uint8Array(total);
    let o = 0;
    for (const c of idat) { z.set(c, o); o += c.length; }
    const raw = inflate(z);
    const stride = width * channels;
    const out = new Uint8Array(stride * height);
    for (let y = 0; y < height; y++) {
        const f = raw[y * (stride + 1)];
        const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
        const row = out.subarray(y * stride, (y + 1) * stride);
        const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
        for (let x = 0; x < stride; x++) {
            const a = x >= channels ? row[x - channels] : 0;
            const b = prev ? prev[x] : 0;
            const c = prev && x >= channels ? prev[x - channels] : 0;
            let v = src[x];
            switch (f) {
                case 0: break;
                case 1: v += a; break;
                case 2: v += b; break;
                case 3: v += (a + b) >> 1; break;
                case 4: {
                    const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
                    v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
                    break;
                }
                default: throw new Error(`bad PNG filter ${f}`);
            }
            row[x] = v & 255;
        }
    }
    return { width, height, channels, data: out };
}
