// The campaign save (the addon's IO.store): a synchronous key/value face over IndexedDB. Everything
// is read once at startup; writes update memory at once and IndexedDB in the background.

import { Idb } from "./idb";

export class SaveStore {
    private data = new Map<string, string>();
    private constructor(private db: Idb | null) {}

    static async open(): Promise<SaveStore> {
        let db: Idb | null = null;
        try { db = typeof indexedDB === "undefined" ? null : await Idb.open("allegiance-saves", ["files"]); } catch { db = null; }
        const s = new SaveStore(db);
        if (db) for (const [k, v] of await db.entries<string>("files")) s.data.set(k, v);
        return s;
    }

    read(path: string): string | null { return this.data.get(path) ?? null; }

    write(path: string, text: string): void {
        this.data.set(path, text);
        if (this.db) void this.db.put("files", path, text);
    }

    remove(path: string): void {
        this.data.delete(path);
        if (this.db) void this.db.delete("files", path);
    }
}
