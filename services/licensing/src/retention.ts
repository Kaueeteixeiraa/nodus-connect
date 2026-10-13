import type { Firestore } from "firebase-admin/firestore";

export function signalingRetention(db: Firestore, now = () => Date.now()) {
  let nextCheck = 0;
  const lock = db.doc("license_signaling_maintenance/current");
  return async () => {
    const time = now();
    if (time < nextCheck) return;
    nextCheck = time + 60_000;
    const claimed = await db.runTransaction(async tx => {
      const previous = await tx.get(lock), nextRunAt = previous.get("nextRunAt") ?? 0;
      if (nextRunAt > time) { nextCheck = nextRunAt; return false; }
      tx.set(lock, { nextRunAt: time + 6 * 3_600_000 });
      return true;
    });
    if (!claimed) return;
    try {
      const cutoff = new Date(time - 86_400_000).toISOString();
      const [signals, requests] = await Promise.all([
        db.collectionGroup("items").where("createdAt", "<=", cutoff).limit(200).get(),
        db.collection("sessionRequests").where("createdAt", "<=", cutoff).limit(200).get(),
      ]);
      const batch = db.batch();
      for (const row of signals.docs) if (/^sessions\/[^/]+\/signals\/\d{9}\/items\/[^/]+$/.test(row.ref.path)) batch.delete(row.ref);
      for (const row of requests.docs) batch.delete(row.ref);
      if (signals.size || requests.size) await batch.commit();
      nextCheck = time + (signals.size === 200 || requests.size === 200 ? 60_000 : 6 * 3_600_000);
      await lock.set({ nextRunAt: nextCheck });
    } catch (error) {
      await lock.set({ nextRunAt: time + 60_000 }).catch(() => undefined);
      throw error;
    }
  };
}
