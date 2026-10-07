import { normalizeNodusId } from "../../../../packages/common/src/nodusId";
import type { FirebaseApp } from "firebase/app";
import type { Auth } from "firebase/auth";
import type { DocumentSnapshot, Firestore, QuerySnapshot, Unsubscribe } from "firebase/firestore";
import type { LocalIdentity } from "./identity";
import type { AccessLogEntry, LocalSettings, LocalUser } from "./storage";
import type { SessionPermission } from "../../../../packages/protocol/src/index";
import type { CoordinationDevice, SessionRequestRecord, SignalMessage } from "./api";

const config = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};
const DEVICE_ONLINE_TTL_MS = 45_000;
export const PENDING_REQUEST_TTL_MS = 5 * 60_000;
const cloudUsage = { readRequests: 0, writeRequests: 0, listenerStarts: 0, serverSnapshots: 0, documentsDelivered: 0, minimumReadEstimate: 0, errors: 0 };

export function getCloudUsageDiagnostics() {
  return { ...cloudUsage, measuredAt: Date.now(), includesSecurityRuleReads: false };
}

type FirebaseModules = {
  app: typeof import("firebase/app");
  auth: typeof import("firebase/auth");
  firestore: typeof import("firebase/firestore");
};

let modulesPromise: Promise<FirebaseModules> | null = null;
let appInstance: FirebaseApp | null = null;
let authInstance: Auth | null = null;
let dbInstance: Firestore | null = null;
let accountAppInstance: FirebaseApp | null = null;
let accountAuthInstance: Auth | null = null;
let accountDbInstance: Firestore | null = null;
let deviceUidPromise: Promise<string | null> | null = null;

export function firebaseConfigured(): boolean {
  return Boolean(config.apiKey && config.authDomain && config.projectId && config.appId);
}

export function subscribeCloudAccessBlock(nodusId: string, onBlocked: () => void): { close(): void } {
  const id = normalizeNodusId(nodusId);
  if (!id) return { close() {} };
  let closed = false, unsubscribe: Unsubscribe | undefined;
  (async () => {
    if (!await ensureDeviceUid() || closed) return;
    const { doc, onSnapshot, store } = await fire();
    if (closed) return;
    unsubscribe = onSnapshot(doc(store, "license_access_blocks", id), snapshot => {
      if (!closed && snapshot.data()?.blocked === true) onBlocked();
    }, () => undefined);
  })().catch(() => undefined);
  return { close() { closed = true; unsubscribe?.(); } };
}

export async function signInFirebaseWithGoogle(idToken?: string, accessToken?: string): Promise<string | null> {
  if (!firebaseConfigured() || (!idToken && !accessToken)) return null;
  const authApi = (await modules()).auth;
  const authInstance = await accountAuth();
  const credential = authApi.GoogleAuthProvider.credential(idToken || null, accessToken || null);
  return (await authApi.signInWithCredential(authInstance, credential)).user.uid;
}

export async function signOutFirebaseAccount(): Promise<void> {
  if (!accountAuthInstance) return;
  await (await modules()).auth.signOut(accountAuthInstance);
}

export async function syncCloudUser(user: LocalUser, identity: LocalIdentity): Promise<void> {
  const uid = await ensureAccountUid();
  if (!uid) return;
  const { doc, setDoc, store } = await accountFire();
  await setDoc(doc(store, "users", uid), {
    uid,
    name: user.name,
    email: user.email ?? "",
    picture: user.picture ?? "",
    provider: user.provider,
    lastDeviceId: normalizeNodusId(identity.nodusId),
    updatedAt: new Date().toISOString(),
  }, { merge: true });
}

export async function saveCloudSettings(settings: LocalSettings): Promise<void> {
  const uid = await ensureAccountUid();
  if (!uid) return;
  const { doc, setDoc, store } = await accountFire();
  await setDoc(doc(store, "users", uid, "private", "settings"), firestoreData({ ...settings, threeDimensionalStandby: false }), { merge: true });
}

export async function loadCloudSettings(): Promise<Partial<LocalSettings> | null> {
  const uid = await ensureAccountUid();
  if (!uid) return null;
  const { doc, getDoc, store } = await accountFire();
  const snapshot = await getDoc(doc(store, "users", uid, "private", "settings"));
  return snapshot.exists() ? snapshot.data() as Partial<LocalSettings> : null;
}

export async function saveCloudAccessLog(entry: AccessLogEntry): Promise<void> {
  const uid = await ensureAccountUid();
  if (!uid) return;
  const { doc, setDoc, store } = await accountFire();
  await setDoc(doc(store, "users", uid, "accessLog", entry.id), firestoreData(entry), { merge: true });
}

export async function cloudRegisterPresence(identity: LocalIdentity): Promise<CoordinationDevice> {
  const uid = await ensureDeviceUid();
  if (!uid) throw new Error("Conta indisponivel.");
  await claimDeviceOwnership(identity, uid);
  const device = cloudDevice(identity, "online", uid);
  const { doc, getDoc, setDoc, store } = await fire();
  const ref = doc(store, "devices", device.nodusId);
  const existing = await getDoc(ref);
  if (existing.exists() && ((existing.data().deviceId && existing.data().deviceId !== identity.deviceId) || (existing.data().deviceFingerprint && existing.data().deviceFingerprint !== identity.deviceFingerprint))) throw new Error("NODUS_ID_CONFLICT");
  await setDoc(ref, device, { merge: true });
  return device;
}

export async function cloudHeartbeat(identityInput: LocalIdentity | string): Promise<CoordinationDevice> {
  const uid = await ensureDeviceUid();
  const nodusIdInput = typeof identityInput === "string" ? identityInput : identityInput.nodusId;
  const nodusId = normalizeNodusId(nodusIdInput);
  if (!nodusId) throw new Error("Nodus ID invalido");
  const { doc, getDoc, setDoc, store } = await fire();
  const ref = doc(store, "devices", nodusId);
  if (uid && typeof identityInput !== "string") {
    const device = cloudDevice(identityInput, "online", uid);
    await setDoc(ref, device, { merge: true });
    return device;
  }
  const current = await getDoc(ref);
  const currentDevice = current.data() as CoordinationDevice | undefined;
  if (currentDevice?.ownerUid && currentDevice.ownerUid !== uid) throw new Error("NODUS_ID_CONFLICT");
  const device: CoordinationDevice = {
    nodusId,
    deviceId: typeof identityInput === "string" ? currentDevice?.deviceId : identityInput.deviceId,
    deviceFingerprint: typeof identityInput === "string" ? currentDevice?.deviceFingerprint : identityInput.deviceFingerprint,
    ownerUid: uid ?? currentDevice?.ownerUid,
    deviceName: typeof identityInput === "string" ? currentDevice?.deviceName ?? "Dispositivo" : identityInput.deviceName,
    status: "online",
    updatedAt: new Date().toISOString(),
    capabilities: currentDevice?.capabilities ?? ["desktop-shell", "presence", "screen-share", "remote-control", "firebase"],
  };
  await setDoc(ref, device, { merge: true });
  return device;
}

export async function cloudUnregisterPresence(identityInput: LocalIdentity | string): Promise<CoordinationDevice> {
  const uid = await ensureDeviceUid();
  const nodusIdInput = typeof identityInput === "string" ? identityInput : identityInput.nodusId;
  const nodusId = normalizeNodusId(nodusIdInput);
  if (!nodusId) throw new Error("Nodus ID invalido");
  const { doc, getDoc, setDoc, store } = await fire();
  const ref = doc(store, "devices", nodusId);
  const current = await getDoc(ref);
  const currentDevice = current.data() as CoordinationDevice | undefined;
  if (currentDevice?.ownerUid && currentDevice.ownerUid !== uid) throw new Error("NODUS_ID_CONFLICT");
  const device: CoordinationDevice = {
    nodusId,
    deviceId: typeof identityInput === "string" ? currentDevice?.deviceId : identityInput.deviceId,
    deviceFingerprint: typeof identityInput === "string" ? currentDevice?.deviceFingerprint : identityInput.deviceFingerprint,
    ownerUid: uid ?? currentDevice?.ownerUid,
    deviceName: typeof identityInput === "string" ? currentDevice?.deviceName ?? "Dispositivo" : identityInput.deviceName,
    status: "offline",
    updatedAt: new Date().toISOString(),
    capabilities: currentDevice?.capabilities ?? ["desktop-shell", "presence", "screen-share", "remote-control", "firebase"],
  };
  await setDoc(ref, device, { merge: true });
  return device;
}

export function subscribeCloudDevicePresence(nodusIdInput: string, onPresence: (device: CoordinationDevice | null) => void): { close(): void } {
  const nodusId = normalizeNodusId(nodusIdInput);
  let closed = false;
  let unsubscribe: Unsubscribe | undefined;
  let expiryTimer = 0;

  const publish = (device: CoordinationDevice | null) => {
    if (closed) return;
    window.clearTimeout(expiryTimer);
    if (!device || !isFresh(device.updatedAt, DEVICE_ONLINE_TTL_MS)) {
      onPresence(null);
      return;
    }
    onPresence(device);
    expiryTimer = window.setTimeout(() => onPresence(null), Math.max(0, DEVICE_ONLINE_TTL_MS - (Date.now() - Date.parse(device.updatedAt)) + 20));
  };

  if (!firebaseConfigured() || !nodusId) return { close() {} };
  fire().then(({ doc, onSnapshot, store }) => {
    if (closed) return;
    unsubscribe = onSnapshot(doc(store, "devices", nodusId), (snapshot) => publish(snapshot.exists() ? snapshot.data() as CoordinationDevice : null), () => publish(null));
  }).catch(() => publish(null));

  return { close() { closed = true; window.clearTimeout(expiryTimer); unsubscribe?.(); } };
}

export async function cloudLookupDevice(nodusIdInput: string): Promise<CoordinationDevice | null> {
  await ensureDeviceUid();
  const nodusId = normalizeNodusId(nodusIdInput);
  if (!nodusId) throw new Error("Nodus ID invalido");
  const { doc, getDoc, store } = await fire();
  const snapshot = await getDoc(doc(store, "devices", nodusId));
  if (!snapshot.exists()) return null;
  const device = snapshot.data() as CoordinationDevice;
  return device.status === "online" && isFresh(device.updatedAt, DEVICE_ONLINE_TTL_MS) ? device : null;
}

export async function cloudCreateSessionRequest(input: {
  sessionId?: string;
  requesterNodusId: string;
  requesterName: string;
  targetNodusId: string;
  requestedPermissions?: SessionPermission[];
  passwordHash?: string;
  preferredResolution?: import("./api").RemoteResolution;
  preferredFps?: import("./api").RemoteFrameRate;
}): Promise<SessionRequestRecord> {
  const uid = await ensureDeviceUid();
  const requesterNodusId = normalizeNodusId(input.requesterNodusId);
  const targetNodusId = normalizeNodusId(input.targetNodusId);
  if (!requesterNodusId || !targetNodusId) throw new Error("Nodus ID invalido");
  if (requesterNodusId === targetNodusId) throw new Error("Digite o Nodus ID de outro computador.");
  const target = await cloudLookupDevice(targetNodusId);
  if (!target) throw new Error("Dispositivo nao encontrado ou offline.");
  const now = new Date().toISOString();
  const { collection, doc, setDoc, store } = await fire();
  const ref = input.sessionId ? doc(store, "sessionRequests", input.sessionId) : doc(collection(store, "sessionRequests"));
  const request: SessionRequestRecord = {
    id: ref.id,
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    requesterUid: uid ?? undefined,
    requesterNodusId,
    requesterName: input.requesterName.trim(),
    targetUid: target?.ownerUid,
    targetNodusId,
    status: "pending",
    requestedPermissions: input.requestedPermissions ?? ["screen:view"],
    passwordHash: input.passwordHash,
    preferredResolution: input.preferredResolution,
    preferredFps: input.preferredFps,
    createdAt: now,
    updatedAt: now,
  };
  await setDoc(ref, firestoreData(request));
  return request;
}

export async function cloudListIncomingRequests(nodusIdInput: string): Promise<SessionRequestRecord[]> {
  const uid = await ensureDeviceUid();
  const nodusId = normalizeNodusId(nodusIdInput);
  if (!nodusId) throw new Error("Nodus ID invalido");
  if (!uid) throw new Error("Conta indisponivel.");
  const { collection, getDocs, query, store, where } = await fire();
  const snapshot = await getDocs(query(collection(store, "sessionRequests"), where("targetNodusId", "==", nodusId), where("targetUid", "==", uid)));
  return snapshot.docs
    .map((item) => item.data() as SessionRequestRecord)
    .filter((item) => item.status === "pending" && isFresh(item.createdAt, PENDING_REQUEST_TTL_MS))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function cloudGetSessionRequest(id: string): Promise<SessionRequestRecord> {
  await ensureDeviceUid();
  const { doc, getDoc, store } = await fire();
  const snapshot = await getDoc(doc(store, "sessionRequests", id));
  if (!snapshot.exists()) throw new Error("Solicitacao expirada. Tente novamente.");
  const request = snapshot.data() as SessionRequestRecord;
  if (request.status === "pending" && !isFresh(request.createdAt, PENDING_REQUEST_TTL_MS)) throw new Error("Solicitacao expirada. Tente novamente.");
  return request;
}

export async function cloudAcceptSessionRequest(id: string, targetName: string, grantedPermissions: SessionPermission[]): Promise<SessionRequestRecord> {
  await ensureDeviceUid();
  const { doc, setDoc, store } = await fire();
  const ref = doc(store, "sessionRequests", id);
  const current = await cloudGetSessionRequest(id);
  const sessionId = current.sessionId ?? crypto.randomUUID();
  const next: SessionRequestRecord = {
    ...current,
    sessionId,
    targetName: targetName.trim() || "Dispositivo remoto",
    grantedPermissions,
    status: "accepted",
    updatedAt: new Date().toISOString(),
  };
  await setDoc(doc(store, "sessions", sessionId), firestoreData({
    sessionId,
    requesterNodusId: next.requesterNodusId,
    targetNodusId: next.targetNodusId,
    grantedPermissions,
    participantUids: unique([next.requesterUid, next.targetUid]),
    updatedAt: next.updatedAt,
  }), { merge: true });
  await setDoc(ref, firestoreData(next), { merge: true });
  return next;
}

export async function cloudDenySessionRequest(id: string): Promise<SessionRequestRecord> {
  await ensureDeviceUid();
  const { doc, setDoc, store } = await fire();
  const ref = doc(store, "sessionRequests", id);
  const next: SessionRequestRecord = { ...await cloudGetSessionRequest(id), status: "denied", updatedAt: new Date().toISOString() };
  await setDoc(ref, firestoreData(next), { merge: true });
  return next;
}

export async function cloudSendSignal(sessionId: string, signal: Omit<SignalMessage, "seq" | "sessionId" | "createdAt">): Promise<SignalMessage> {
  const from = normalizeNodusId(signal.from), to = normalizeNodusId(signal.to);
  if (!from || !to) throw new Error("Nodus ID invalido");
  await ensureDeviceUid();
  const { addDoc, collection, store } = await fire();
  const message: SignalMessage = {
    ...signal,
    from,
    to,
    sessionId,
    seq: Date.now() * 1000 + Math.floor(Math.random() * 1000),
    createdAt: new Date().toISOString(),
  };
  await addDoc(collection(store, "sessions", sessionId, "signals", to, "items"), firestoreData(message));
  return message;
}

export async function cloudGetSignals(sessionId: string, toInput: string, after = 0): Promise<SignalMessage[]> {
  await ensureDeviceUid();
  const to = normalizeNodusId(toInput);
  if (!to) throw new Error("Nodus ID invalido");
  const { collection, getDocs, query, store, where } = await fire();
  const snapshot = await getDocs(query(collection(store, "sessions", sessionId, "signals", to, "items"), where("seq", ">", after)));
  return snapshot.docs
    .map((item) => item.data() as SignalMessage)
    .sort((a, b) => a.seq - b.seq);
}

export function subscribeCloudSignals(sessionId: string, toInput: string, onSignal: (signal: SignalMessage) => Promise<void>, onError: () => void): { close(): void } {
  const to = normalizeNodusId(toInput);
  let closed = false, unsubscribe: Unsubscribe | undefined, retryTimer: ReturnType<typeof setTimeout> | undefined;
  let retries = 0, generation = 0, queue = Promise.resolve();
  const delivered = new Set<string>();
  const failed = (current: number, error: unknown) => {
    if (closed || current !== generation) return;
    generation++;
    onError();
    unsubscribe?.();
    unsubscribe = undefined;
    if (["permission-denied", "unauthenticated"].includes((error as { code?: string })?.code ?? "")) return;
    clearTimeout(retryTimer);
    retryTimer = setTimeout(open, Math.min(300_000, 30_000 * 2 ** Math.min(retries++, 4)));
  };
  const open = async () => {
    const current = ++generation;
    try {
      if (closed || !to || !await ensureDeviceUid()) return;
      const { collection, onSnapshot, store } = await fire();
      if (closed || current !== generation) return;
      unsubscribe = onSnapshot(collection(store, "sessions", sessionId, "signals", to, "items"), snapshot => {
        if (closed || current !== generation) return;
        if (!snapshot.metadata.fromCache) retries = 0;
        const changes = snapshot.docChanges().filter(change => change.type !== "removed")
          .sort((a, b) => Number(a.doc.data().seq) - Number(b.doc.data().seq));
        for (const change of changes) {
          if (delivered.has(change.doc.id)) continue;
          delivered.add(change.doc.id);
          const signal = change.doc.data() as SignalMessage;
          queue = queue.then(async () => { if (!closed) await onSignal(signal); }).catch(() => { if (!closed) onError(); });
        }
      }, error => failed(current, error));
    } catch (error) { failed(current, error); }
  };
  void open();
  return { close() { closed = true; clearTimeout(retryTimer); unsubscribe?.(); delivered.clear(); } };
}

export function subscribeCloudRealtime(
  nodusIdInput: string,
  handlers: {
    onIncomingRequest?(request: SessionRequestRecord): void;
    onIncomingRequests?(requests: SessionRequestRecord[]): void;
    onRequestUpdate?(request: SessionRequestRecord): void;
    onState?(state: "connecting" | "online" | "offline"): void;
  },
): { close(): void } {
  const nodusId = normalizeNodusId(nodusIdInput);
  const unsubscribes: Unsubscribe[] = [];
  let closed = false;
  let retryTimer: ReturnType<typeof setTimeout> | undefined, retries = 0, generation = 0;
  if (!firebaseConfigured() || !nodusId) return { close() {} };
  handlers.onState?.("connecting");
  const open = () => {
    const current = ++generation;
    const onError = (error: unknown) => {
      if (closed || current !== generation) return;
      generation++;
      handlers.onState?.("offline");
      unsubscribes.splice(0).forEach(unsubscribe => unsubscribe());
      if (["permission-denied", "unauthenticated"].includes((error as { code?: string })?.code ?? "")) return;
      clearTimeout(retryTimer);
      retryTimer = setTimeout(open, Math.min(300_000, 30_000 * 2 ** Math.min(retries++, 4)));
    };
    ensureDeviceUid().then(async (uid) => {
      if (closed || current !== generation) return;
      if (!uid) throw new Error("Conta indisponivel.");
      const { collection, onSnapshot, query, store, where } = await fire();
      if (closed || current !== generation) return;
      unsubscribes.push(onSnapshot(query(collection(store, "sessionRequests"), where("targetNodusId", "==", nodusId), where("targetUid", "==", uid)), { includeMetadataChanges: true }, (snapshot) => {
        if (closed || current !== generation) return;
        handlers.onState?.(snapshot.metadata.fromCache ? "connecting" : "online");
        if (!snapshot.metadata.fromCache) retries = 0;
        if (handlers.onIncomingRequests) {
          handlers.onIncomingRequests(snapshot.docs.map(item => item.data() as SessionRequestRecord)
            .filter(item => item.status === "pending" && isFresh(item.createdAt, PENDING_REQUEST_TTL_MS))
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
          return;
        }
        snapshot.docChanges().forEach((change) => {
          const request = change.doc.data() as SessionRequestRecord;
          if (change.type !== "removed" && request.status === "pending" && isFresh(request.createdAt, PENDING_REQUEST_TTL_MS)) handlers.onIncomingRequest?.(request);
        });
      }, onError));
      unsubscribes.push(onSnapshot(query(collection(store, "sessionRequests"), where("requesterNodusId", "==", nodusId), where("requesterUid", "==", uid)), (snapshot) => {
        if (closed || current !== generation) return;
        snapshot.docChanges().forEach((change) => {
          if (change.type !== "removed") handlers.onRequestUpdate?.(change.doc.data() as SessionRequestRecord);
        });
      }, onError));
    }).catch(onError);
  };
  open();
  return { close: () => {
    closed = true;
    clearTimeout(retryTimer);
    unsubscribes.forEach((unsubscribe) => unsubscribe());
  } };
}

function cloudDevice(identity: LocalIdentity, status: CoordinationDevice["status"], ownerUid: string | null): CoordinationDevice {
  const nodusId = normalizeNodusId(identity.nodusId);
  if (!nodusId) throw new Error("Nodus ID invalido");
  return {
    nodusId,
    deviceId: identity.deviceId,
    deviceFingerprint: identity.deviceFingerprint,
    ownerUid: ownerUid ?? undefined,
    ...(identity.supportProfileId ? { supportProfileId: identity.supportProfileId } : {}),
    deviceName: identity.deviceName,
    status,
    updatedAt: new Date().toISOString(),
    capabilities: ["desktop-shell", "presence", "screen-share", "remote-control", "firebase"],
  };
}

async function ensureDeviceUid(): Promise<string | null> {
  if (!firebaseConfigured()) return null;
  // Presence and listeners must never create different anonymous users at startup.
  const pending = deviceUidPromise ??= (async () => {
    const authApi = (await modules()).auth;
    const authInstance = await deviceAuth();
    await authInstance.authStateReady();
    const user = authInstance.currentUser ?? (await authApi.signInAnonymously(authInstance)).user;
    await user.getIdToken();
    return user.uid;
  })();
  try { return await pending; } finally { if (deviceUidPromise === pending) deviceUidPromise = null; }
}

export async function getDeviceAuthToken(): Promise<string> {
  if (!await ensureDeviceUid()) throw new Error("Autenticação do dispositivo indisponível.");
  return (await deviceAuth()).currentUser!.getIdToken();
}

async function claimDeviceOwnership(identity: LocalIdentity, ownerUid: string): Promise<void> {
  const nodusId = normalizeNodusId(identity.nodusId);
  if (!nodusId) throw new Error("Nodus ID invalido");
  const { doc, setDoc, store } = await fire();
  await setDoc(doc(store, "deviceClaims", nodusId), {
    nodusId,
    deviceId: identity.deviceId,
    deviceFingerprint: identity.deviceFingerprint,
    deviceClaim: identity.deviceClaim,
    ownerUid,
    updatedAt: new Date().toISOString(),
  }, { merge: true });
}

async function ensureAccountUid(): Promise<string | null> {
  if (!firebaseConfigured()) return null;
  return (await accountAuth()).currentUser?.uid ?? null;
}

async function deviceAuth(): Promise<Auth> {
  if (!authInstance) authInstance = (await modules()).auth.getAuth(await app());
  return authInstance;
}

async function fire(): Promise<typeof import("firebase/firestore") & { store: Firestore }> {
  const { firestore } = await modules();
  if (!dbInstance) dbInstance = firestore.getFirestore(await app());
  return instrumentFirestore(dbInstance, firestore);
}

function instrumentFirestore(store: Firestore, api: FirebaseModules["firestore"]): FirebaseModules["firestore"] & { store: Firestore } {
  const read = async <T extends DocumentSnapshot<unknown> | QuerySnapshot<unknown>>(work: () => Promise<T>) => {
    cloudUsage.readRequests++;
    try {
      const snapshot = await work();
      if (!snapshot.metadata.fromCache) cloudUsage.minimumReadEstimate += "size" in snapshot ? Math.max(1, snapshot.size) : 1;
      return snapshot;
    } catch (error) { cloudUsage.errors++; throw error; }
  };
  const write = async <T>(work: () => Promise<T>) => {
    cloudUsage.writeRequests++;
    try { return await work(); } catch (error) { cloudUsage.errors++; throw error; }
  };
  return Object.assign({ store }, api, {
    getDoc: (...args: Parameters<typeof api.getDoc>) => read(() => api.getDoc(...args)),
    getDocs: (...args: Parameters<typeof api.getDocs>) => read(() => api.getDocs(...args)),
    setDoc: (...args: Parameters<typeof api.setDoc>) => write(() => api.setDoc(...args)),
    addDoc: (...args: Parameters<typeof api.addDoc>) => write(() => api.addDoc(...args)),
    onSnapshot: (...args: unknown[]) => {
      cloudUsage.listenerStarts++;
      const index = typeof args[1] === "function" ? 1 : 2;
      const next = args[index] as (snapshot: DocumentSnapshot | QuerySnapshot) => void;
      const error = args[index + 1] as ((error: unknown) => void) | undefined;
      let initial = true;
      args[index] = (snapshot: DocumentSnapshot | QuerySnapshot) => {
        if (!snapshot.metadata.fromCache) {
          const count = "docChanges" in snapshot ? (initial ? snapshot.size : snapshot.docChanges().filter(change => change.type !== "removed").length) : 1;
          cloudUsage.serverSnapshots++;
          cloudUsage.documentsDelivered += count;
          cloudUsage.minimumReadEstimate += initial ? Math.max(1, count) : count;
          initial = false;
        }
        next(snapshot);
      };
      args[index + 1] = (reason: unknown) => { cloudUsage.errors++; error?.(reason); };
      return (api.onSnapshot as (...args: unknown[]) => Unsubscribe)(...args);
    },
  }) as FirebaseModules["firestore"] & { store: Firestore };
}

async function accountAuth(): Promise<Auth> {
  if (!accountAuthInstance) accountAuthInstance = (await modules()).auth.getAuth(await accountApp());
  return accountAuthInstance;
}

async function accountFire(): Promise<typeof import("firebase/firestore") & { store: Firestore }> {
  const { firestore } = await modules();
  if (!accountDbInstance) accountDbInstance = firestore.getFirestore(await accountApp());
  return instrumentFirestore(accountDbInstance, firestore);
}

async function accountApp(): Promise<FirebaseApp> {
  if (!accountAppInstance) {
    const appApi = (await modules()).app;
    accountAppInstance = appApi.getApps().find((item) => item.name === "nodus-account") ?? appApi.initializeApp(config, "nodus-account");
  }
  return accountAppInstance;
}

async function app(): Promise<FirebaseApp> {
  if (!appInstance) {
    const appApi = (await modules()).app;
    appInstance = appApi.getApps().find((item) => item.name === "[DEFAULT]") ?? appApi.initializeApp(config);
  }
  return appInstance;
}

function modules(): Promise<FirebaseModules> {
  modulesPromise ??= Promise.all([
    import("firebase/app"),
    import("firebase/auth"),
    import("firebase/firestore"),
  ]).then(([app, auth, firestore]) => ({ app, auth, firestore }));
  return modulesPromise;
}

function firestoreData<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function unique(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter(Boolean) as string[])];
}

function isFresh(value: string | undefined, ttlMs: number): boolean {
  const at = Date.parse(value || "");
  return Number.isFinite(at) && Date.now() - at <= ttlMs;
}
