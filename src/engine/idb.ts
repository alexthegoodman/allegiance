// A minimal promise wrapper over IndexedDB: the mesh cache's and the campaign save's storage.

export class Idb {
    private constructor(private db: IDBDatabase) {}

    static open(name: string, stores: string[], version = 1): Promise<Idb> {
        return new Promise((resolve, reject) => {
            const req = indexedDB.open(name, version);
            req.onupgradeneeded = () => {
                for (const s of stores) if (!req.result.objectStoreNames.contains(s)) req.result.createObjectStore(s);
            };
            req.onsuccess = () => resolve(new Idb(req.result));
            req.onerror = () => reject(req.error);
        });
    }

    private tx<T>(store: string, mode: IDBTransactionMode, f: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
        return new Promise((resolve, reject) => {
            const t = this.db.transaction(store, mode);
            const r = f(t.objectStore(store));
            t.oncomplete = () => resolve(r ? r.result : undefined);
            t.onerror = () => reject(t.error);
            t.onabort = () => reject(t.error);
        });
    }

    get<T>(store: string, key: string): Promise<T | undefined> { return this.tx<T>(store, "readonly", s => s.get(key) as IDBRequest<T>); }
    put(store: string, key: string, value: unknown): Promise<unknown> { return this.tx(store, "readwrite", s => s.put(value, key)); }
    delete(store: string, key: string): Promise<unknown> { return this.tx(store, "readwrite", s => s.delete(key)); }

    /** Every key/value of a store. */
    entries<T>(store: string): Promise<[string, T][]> {
        return new Promise((resolve, reject) => {
            const out: [string, T][] = [];
            const t = this.db.transaction(store, "readonly");
            const req = t.objectStore(store).openCursor();
            req.onsuccess = () => {
                const c = req.result;
                if (c) { out.push([String(c.key), c.value as T]); c.continue(); }
            };
            t.oncomplete = () => resolve(out);
            t.onerror = () => reject(t.error);
        });
    }
}
