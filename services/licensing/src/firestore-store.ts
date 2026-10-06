import type { Firestore, Transaction } from "firebase-admin/firestore";
import type { LicenseStore } from "./store.js";

export const FIRESTORE_CLIENT_CONFIG = { interfaces: { "google.firestore.v1.Firestore": {
  retry_codes: { nodus_write: ["UNAVAILABLE"] },
  retry_params: { nodus_write: { initial_retry_delay_millis: 100, retry_delay_multiplier: 1.3, max_retry_delay_millis: 1_000, initial_rpc_timeout_millis: 7_000, rpc_timeout_multiplier: 1, max_rpc_timeout_millis: 7_000, total_timeout_millis: 7_000 } },
  methods: { Commit: { timeout_millis: 7_000, retry_codes_name: "nodus_write", retry_params_name: "nodus_write" } },
} } } as const;

export function configureFirestore(db: Firestore): Firestore {
  db.settings({ clientConfig: FIRESTORE_CLIENT_CONFIG });
  return db;
}

export function firestoreLicenseStore(db: Firestore): LicenseStore {
  return { transaction: (operation, options) => db.runTransaction(async (transaction: Transaction) => {
    const writes = new Map<string, object>();
    const result = await operation({
      async get<T>(path: string) {
        if (writes.has(path)) return structuredClone(writes.get(path)) as T;
        const document = await transaction.get(db.doc(path));
        return document.exists ? document.data() as T : null;
      },
      set(path, value) { if (options?.readOnly) throw new Error("READ_ONLY_TRANSACTION"); writes.set(path, structuredClone(value)); },
    });
    // Firestore requires all reads before writes; retries must not expose intermediate changes.
    for (const [path, value] of writes) transaction.set(db.doc(path), value);
    return result;
  }, options?.readOnly ? { readOnly: true } : undefined) };
}
