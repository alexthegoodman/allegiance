// Prepares the PBR material sets for the browser: each set's 1024 px PNG maps (as authored for
// Entropy, examples/studio-bundle/assets/materials) become WebP in public/materials/<set>/, about a
// tenth of the size, so a first visit doesn't download 90 MB of PNG.
//
//   node scripts/materials.mjs [source dir]
//
// Base color, roughness, height and metallic are lossy at high quality; normals keep a higher
// quality so their small angles survive.

import { readdir, mkdir, copyFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";

const source = process.argv[2] ?? "../entropy-engine/examples/studio-bundle/assets/materials";
const out = "public/materials";
const maps = { basecolor: 90, normal: 96, roughness: 90, height: 92, metallic: 90 };
let total = 0;
for (const set of (await readdir(source, { withFileTypes: true })).filter(d => d.isDirectory() && d.name !== "new_zips").map(d => d.name)) {
    await mkdir(join(out, set), { recursive: true });
    for (const [map, quality] of Object.entries(maps)) {
        const from = join(source, set, `${map}.png`);
        if (!existsSync(from)) { console.log(`missing ${set}/${map}`); continue; }
        const to = join(out, set, `${map}.webp`);
        await sharp(from).resize(1024, 1024, { fit: "fill" }).webp({ quality, effort: 5, smartSubsample: true }).toFile(to);
        total += (await stat(to)).size;
    }
    if (existsSync(join(source, set, "source.json"))) await copyFile(join(source, set, "source.json"), join(out, set, "source.json"));
}
console.log(`${(total / 1e6).toFixed(1)} MB in ${out}`);
