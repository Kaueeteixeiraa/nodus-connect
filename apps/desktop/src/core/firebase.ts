import { normalizeNodusId } from "../../../../packages/common/src/nodusId";
import type { FirebaseApp } from "firebase/app";
import type { Auth } from "firebase/auth";
import type { Firestore, Unsubscribe } from "firebase/firestore";
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
const DEVICE_ONLINE_TTL_MS = 20_000;
const PENDING_REQUEST_TTL_MS = 5 * 60_000;

type FirebaseModules = {
  app: typeof import("firebase/app");
  auth: typeof import("firebase/auth");
  firestore: typeof import("firebase/firestore");
};

let modulesPromise: Promise<FirebaseModules> | null = null;
let appInstance: FirebaseApp | null = null;
let authInstance: Auth | null = null;
let dbInstance: Firestore | null = null;

export function firebaseConfigured(): boolean {
  return Boolean(config.apiKey && config.authDomain && config.projectId && config.appId);
}

export async function signInFirebaseWithGoogle(idToken?: string, accessToken?: string): Promise<string | null> {
  if (!firebaseConfigured() || (!idToken && !accessToken)) return null;
  const authApi = (await modules()).auth;
  const authInstance = await auth();
  const credential = authApi.GoogleAuthProvider.credential(idToken || null, accessToken || null);
  if (authInstance.currentUser?.isAnonymous) {
    try {
      return (await authApi.linkWithCredential(authInstance.currentUser, credential)).user.uid;
    } catch {}
  }
  return (await authApi.signInWithCredential(authInstance, credential)).user.uid;
}

export async function syncCloudUser(user: LocalUser, identity: LocalIdentity): Promise<void> {
  const uid = await ensureUid();
  if (!uid) return;
  const { doc, setDoc, store } = await fire();
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
  const uid = await ensureUid();
  if (!uid) return;
  const { doc, setDoc, store } = await fire();
  await setDoc(doc(store, "users", uid, "private", "settings"), firestoreData(settings), { merge: true });
}

export async function loadCloudSettings(): Promise<Partial<LocalSettings> | null> {
  const uid = await ensureUid();
  if (!uid) return null;
  const { doc, getDoc, store } = await fire();
  const snapshot = await getDoc(doc(store, "users", uid, "private", "settings"));
  return snapshot.exists() ? snapshot.data() as Partial<LocalSettings> : null;
}

export async function saveCloudAccessLog(entry: AccessLogEntry): Promise<void> {
  const uid = await ensureUid();
  if (!uid) return;
  const { doc, setDoc, store } = await fire();
  await setDoc(doc(store, "users", uid, "accessLog", entry.id), firestoreData(entry), { merge: true });
}

export async function cloudRegisterPresence(identity: LocalIdentity): Promise<CoordinationDevice> {
  const uid = await ensureUid();
  const device = cloudDevice(identity, "online", uid);
  const { doc, getDoc, setDoc, store } = await fire();
  const ref = doc(store, "devices", device.nodusId);
  const existing = await getDoc(ref);
  if (existing.exists() && existing.data().ownerUid !== uid) throw new Error("NODUS_ID_CONFLICT");
  await setDoc(ref, device, { merge: true });
  return device;
}

export async function cloudHeartbeat(identityInput: LocalIdentity | string): Promise<CoordinationDevice> {
  const uid = await ensureUid();
  const nodusIdInput = typeof identityInput === "string" ? identityInput : identityInput.nodusId;
  const nodusId = normalizeNodusId(nodusIdInput);
  if (!nodusId) throw new Error("Nodus ID invalido");
  const { doc, getDoc, setDoc, store } = await fire();
  const ref = doc(store, "devices", nodusId);
  const current = await getDoc(ref);
  const currentDevice = current.data() as CoordinationDevice | undefined;
  const device: CoordinationDevice = {
    nodusId,
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
  const uid = await ensureUid();
  const nodusIdInput = typeof identityInput === "string" ? identityInput : identityInput.nodusId;
  const nodusId = normalizeNodusId(nodusIdInput);
  if (!nodusId) throw new Error("Nodus ID invalido");
  const { doc, getDoc, setDoc, store } = await fire();
  const ref = doc(store, "devices", nodusId);
  const current = await getDoc(ref);
  const currentDevice = current.data() as CoordinationDevice | undefined;
  const device: CoordinationDevice = {
    nodusId,
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
  await ensureUid();
  const nodusId = normalizeNodusId(nodusIdInput);
  if (!nodusId) throw new Error("Nodus ID invalido");
  const { doc, getDoc, store } = await fire();
  const snapshot = await getDoc(doc(store, "devices", nodusId));
  if (!snapshot.exists()) return null;
  const device = snapshot.data() as CoordinationDevice;
  return device.status === "online" && isFresh(device.updatedAt, DEVICE_ONLINE_TTL_MS) ? device : null;
}

export async function cloudCreateSessionRequest(input: {
  requesterNodusId: string;
  requesterName: string;
  targetNodusId: string;
  requestedPermissions?: SessionPermission[];
  passwordHash?: string;
  preferredResolution?: import("./api").RemoteResolution;
  preferredFps?: import("./api").RemoteFrameRate;
}): Promise<SessionRequestRecord> {
  const uid = await ensureUid();
  const requesterNodusId = normalizeNodusId(input.requesterNodusId);
  const targetNodusId = normalizeNodusId(input.targetNodusId);
  if (!requesterNodusId || !targetNodusId) throw new Error("Nodus ID invalido");
  if (requesterNodusId === targetNodusId) throw new Error("Digite o Nodus ID de outro computador.");
  const target = await cloudLookupDevice(targetNodusId);
  if (!target) throw new Error("Dispositivo nao encontrado ou offline.");
  const now = new Date().toISOString();
  const { collection, doc, setDoc, store } = await fire();
  const ref = doc(collection(store, "sessionRequests"));
  const request: SessionRequestRecord = {
    id: ref.id,
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
  const uid = await ensureUid();
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
  await ensureUid();
  const { doc, getDoc, store } = await fire();
  const snapshot = await getDoc(doc(store, "sessionRequests", id));
  if (!snapshot.exists()) throw new Error("Solicitacao expirada. Tente novamente.");
  const request = snapshot.data() as SessionRequestRecord;
  if (request.status === "pending" && !isFresh(request.createdAt, PENDING_REQUEST_TTL_MS)) throw new Error("Solicitacao expirada. Tente novamente.");
  return request;
}

export async function cloudAcceptSessionRequest(id: string, targetName: string, grantedPermissions: SessionPermission[]): Promise<SessionRequestRecord> {
  await ensureUid();
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
  await ensureUid();
  const { doc, setDoc, store } = await fire();
  const ref = doc(store, "sessionRequests", id);
  const next: SessionRequestRecord = { ...await cloudGetSessionRequest(id), status: "denied", updatedAt: new Date().toISOString() };
  await setDoc(ref, firestoreData(next), { merge: true });
  return next;
}

export async function cloudSendSignal(sessionId: string, signal: Omit<SignalMessage, "seq" | "sessionId" | "createdAt">): Promise<SignalMessage> {
  await ensureUid();
  const to = normalizeNodusId(signal.to);
  if (!to) throw new Error("Nodus ID invalido");
  const { addDoc, collection, store } = await fire();
  const message: SignalMessage = {
    ...signal,
    to,
    sessionId,
    seq: Date.now() * 1000 + Math.floor(Math.random() * 1000),
    createdAt: new Date().toISOString(),
  };
  await addDoc(collection(store, "sessions", sessionId, "signals", to, "items"), firestoreData(message));
  return message;
}

export async function cloudGetSignals(sessionId: string, toInput: string, after = 0): Promise<SignalMessage[]> {
  await ensureUid();
  const to = normalizeNodusId(toInput);
  if (!to) throw new Error("Nodus ID invalido");
  const { collection, getDocs, query, store, where } = await fire();
  const snapshot = await getDocs(query(collection(store, "sessions", sessionId, "signals", to, "items"), where("seq", ">", after)));
  return snapshot.docs
    .map((item) => item.data() as SignalMessage)
    .sort((a, b) => a.seq - b.seq);
}

export function subscribeCloudRealtime(
  nodusIdInput: string,
  handlers: {
    onIncomingRequest?(request: SessionRequestRecord): void;
    onRequestUpdate?(request: SessionRequestRecord): void;
    onState?(state: "connecting" | "online" | "offline"): void;
  },
): { close(): void } {
  const nodusId = normalizeNodusId(nodusIdInput);
  const unsubscribes: Unsubscribe[] = [];
  let closed = false;
  if (!firebaseConfigured() || !nodusId) return { close() {} };
  handlers.onState?.("connecting");
  ensureUid().then(async (uid) => {
    if (closed) return;
    if (!uid) throw new Error("Conta indisponivel.");
    const { collection, onSnapshot, query, store, where } = await fire();
    handlers.onState?.("online");
    const onError = () => {
      if (!closed) handlers.onState?.("offline");
    };
    unsubscribes.push(onSnapshot(query(collection(store, "sessionRequests"), where("targetNodusId", "==", nodusId), where("targetUid", "==", uid)), (snapshot) => {
      snapshot.docChanges().forEach((change) => {
        const request = change.doc.data() as SessionRequestRecord;
        if (change.type !== "removed" && request.status === "pending" && isFresh(request.createdAt, PENDING_REQUEST_TTL_MS)) handlers.onIncomingRequest?.(request);
      });
    }, onError));
    unsubscribes.push(onSnapshot(query(collection(store, "sessionRequests"), where("requesterNodusId", "==", nodusId), where("requesterUid", "==", uid)), (snapshot) => {
      snapshot.docChanges().forEach((change) => {
        if (change.type !== "removed") handlers.onRequestUpdate?.(change.doc.data() as SessionRequestRecord);
      });
    }, onError));
  }).catch(() => handlers.onState?.("offline"));
  return { close: () => {
    closed = true;
    unsubscribes.forEach((unsubscribe) => unsubscribe());
  } };
}

function cloudDevice(identity: LocalIdentity, status: CoordinationDevice["status"], ownerUid: string | null): CoordinationDevice {
  const nodusId = normalizeNodusId(identity.nodusId);
  if (!nodusId) throw new Error("Nodus ID invalido");
  return {
    nodusId,
    ownerUid: ownerUid ?? undefined,
    deviceName: identity.deviceName,
    status,
    updatedAt: new Date().toISOString(),
    capabilities: ["desktop-shell", "presence", "screen-share", "remote-control", "firebase"],
  };
}

async function ensureUid(): Promise<string | null> {
  if (!firebaseConfigured()) return null;
  const authApi = (await modules()).auth;
  const authInstance = await auth();
  const user = authInstance.currentUser ?? (await authApi.signInAnonymously(authInstance)).user;
  await user.getIdToken();
  return user.uid;
}

async function auth(): Promise<Auth> {
  if (!authInstance) authInstance = (await modules()).auth.getAuth(await app());
  return authInstance;
}

async function fire(): Promise<typeof import("firebase/firestore") & { store: Firestore }> {
  const { firestore } = await modules();
  if (!dbInstance) dbInstance = firestore.getFirestore(await app());
  return Object.assign({ store: dbInstance }, firestore);
}

async function app(): Promise<FirebaseApp> {
  if (!appInstance) {
    const appApi = (await modules()).app;
    appInstance = appApi.getApps()[0] ?? appApi.initializeApp(config);
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
