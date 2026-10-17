import { FieldPath, type Firestore, type QueryDocumentSnapshot } from "firebase-admin/firestore";
import { LicenseError, effectiveStatus, type DeviceLicenseIdentity, type License, type LicenseDevice } from "../../../packages/licensing/src/index.js";

export async function publicDevices(db: Firestore, rows: QueryDocumentSnapshot[], runtimeOnly = false) {
  const presence = rows.length ? await db.getAll(...rows.map(row => db.doc(`devices/${row.data().nodusId}`))) : [];
  const ids = runtimeOnly ? [] : [...new Set(rows.flatMap(row => { const data = row.data() as LicenseDevice; return [data.licenseId, data.freeLicenseId ?? `free-${data.id}`]; }))];
  const licenses = ids.length ? await db.getAll(...ids.map(id => db.doc(`license_licenses/${id}`))) : [];
  const byId = new Map(licenses.map(doc => [doc.id, doc.data() as License | undefined]));
  const identityIds = runtimeOnly ? [] : [...new Set(rows.map(row => row.data().deviceIdentityId as string | undefined).filter((id): id is string => Boolean(id)))];
  const identities = identityIds.length ? await db.getAll(...identityIds.map(id => db.doc(`license_device_identities/${id}`))) : [];
  const byIdentity = new Map(identities.map(doc => [doc.id, doc.data() as DeviceLicenseIdentity | undefined]));
  return rows.map((doc, index) => {
    const { tokenHash: _token, claimHash: _claim, ...device } = doc.data() as LicenseDevice;
    const live = presence[index]?.data(), seenAt = Date.parse(String(live?.updatedAt ?? ""));
    const online = live?.status === "online" && Number.isFinite(seenAt) && Date.now() - seenAt < 90_000;
    const license = byId.get(device.licenseId), free = byId.get(device.freeLicenseId ?? `free-${device.id}`);
    Object.assign(device, {
      appVersion: /^\d{1,5}\.\d{1,5}\.\d{1,5}$/.test(live?.appVersion) ? String(live?.appVersion) : null,
      updateState: ["idle", "checking", "downloading", "installing", "current", "deferred", "failed"].includes(live?.updateState) ? String(live?.updateState) : null,
      activeSessions: Number.isSafeInteger(live?.activeSessions) && live!.activeSessions >= 0 && live!.activeSessions <= 1000 ? Number(live?.activeSessions) : null,
    });
    return { ...device, ...(device.deviceIdentityId && byIdentity.get(device.deviceIdentityId)?.status === "BLOCKED" ? { status: "BLOCKED" as const } : {}), plan: license?.plan ?? "free", licenseStatus: license ? effectiveStatus(license, Date.now()) : "EXPIRED", trialUsed: free?.trialUsed ?? 0, trialLimit: free?.trialLimit ?? 0, firstRegisteredAt: free?.createdAt ?? device.activatedAt, lastSeenAt: Number.isFinite(seenAt) ? Math.max(device.lastSeenAt, seenAt) : device.lastSeenAt, online };
  });
}

const normalize = (value: unknown) => String(value ?? "").normalize("NFD").replace(/[\u0300-\u036f\s]/g, "").toLowerCase();
export async function devicePage(db: Firestore, input: Record<string, unknown>) {
  if (typeof input.query === "string" && input.query.length > 120) throw new LicenseError("INVALID_INPUT");
  const search = normalize(input.query), filter = input.filter ?? "all";
  const runtimeOnly = input.runtimeOnly === "1";
  if (runtimeOnly && !["all", "online", "offline"].includes(String(filter))) throw new LicenseError("INVALID_INPUT");
  if (!["all", "online", "offline", "ACTIVE", "BLOCKED", "REVOKED"].includes(String(filter))) throw new LicenseError("INVALID_INPUT");
  const eligible = (device: Awaited<ReturnType<typeof publicDevices>>[number]) => filter === "all" || (filter === "online" ? device.online : filter === "offline" ? !device.online : device.status === filter);
  if (!input.cursor && /^\d{9}$/.test(search)) {
    const rows = await db.collection("license_devices").where("nodusId", "==", search).limit(25).get();
    return { items: (await publicDevices(db, rows.docs, runtimeOnly)).filter(eligible).slice(0, 10), nextCursor: null };
  }
  const base = db.collection("license_devices").orderBy("lastSeenAt", "desc").orderBy(FieldPath.documentId(), "desc");
  let cursor: { at: number; id: string } | undefined;
  if (input.cursor) {
    try {
      if (typeof input.cursor !== "string" || input.cursor.length > 512) throw new Error();
      cursor = JSON.parse(Buffer.from(input.cursor, "base64url").toString());
      if (!Number.isSafeInteger(cursor?.at) || !/^[a-zA-Z0-9_-]{1,128}$/.test(cursor!.id)) throw new Error();
    } catch { throw new LicenseError("INVALID_INPUT"); }
  }
  const items: Awaited<ReturnType<typeof publicDevices>> = [];
  let scanned = 0, exhausted = false;
  const unfiltered = !search && filter === "all", batchSize = unfiltered ? 11 : 25;
  while (items.length < 10 && scanned < 500 && !exhausted) {
    const rows = await (cursor ? base.startAfter(cursor.at, cursor.id) : base).limit(batchSize).get();
    if (rows.empty) { exhausted = true; break; }
    const candidates = rows.docs.filter(row => !search || [row.data().deviceName, row.data().nodusId, row.id, row.data().licenseId].some(value => normalize(value).includes(search)));
    const hydrated = new Map((await publicDevices(db, unfiltered ? candidates.slice(0, 10 - items.length) : candidates, runtimeOnly)).map(device => [device.id, device]));
    for (const row of rows.docs) {
      scanned++;
      cursor = { at: row.get("lastSeenAt"), id: row.id };
      const device = hydrated.get(row.id);
      if (device && eligible(device)) items.push(device);
      if (items.length === 10) break;
    }
    if (cursor?.id === rows.docs.at(-1)!.id && rows.size < batchSize) exhausted = true;
  }
  return { items, nextCursor: !exhausted && cursor ? Buffer.from(JSON.stringify(cursor)).toString("base64url") : null };
}
