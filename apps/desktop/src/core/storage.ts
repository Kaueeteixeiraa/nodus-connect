import type { CoordinationDevice } from "./api";

const RECENTS_KEY = "nodus.recents.v1";
const FAVORITES_KEY = "nodus.favorites.v1";
const SETTINGS_KEY = "nodus.settings.v1";
const SETTINGS_VERSION_KEY = "nodus.settings.version";
const FOLDERS_KEY = "nodus.folders.v1";
const ACCESS_LOG_KEY = "nodus.access-log.v1";
const USER_KEY = "nodus.user.v1";
const GOOGLE_CLIENT_ID = "76048728439-dg1e8phioi7h6nr8ons45r4850t4puf7.apps.googleusercontent.com";

export interface RecentDevice {
  nodusId: string;
  deviceName: string;
  alias?: string;
  folderId?: string;
  lastConnectionAt: string;
  status: CoordinationDevice["status"];
  favorite: boolean;
  notes?: string;
  tags?: string[];
  macAddress?: string;
}

export interface DeviceFolder {
  id: string;
  name: string;
  createdAt: string;
}

export interface AccessLogEntry {
  id: string;
  nodusId: string;
  deviceName: string;
  direction: "incoming" | "outgoing";
  result: "requested" | "accepted" | "denied" | "connected" | "disconnected" | "error";
  userName?: string;
  userEmail?: string;
  at: string;
}

export interface LocalUser {
  id: string;
  name: string;
  email?: string;
  picture?: string;
  provider: "google" | "local";
  loggedAt: string;
}

export interface LocalSettings {
  startWithWindows: boolean;
  startMinimized: boolean;
  minimizeToTray: boolean;
  confirmBeforeDisconnect: boolean;
  theme: "dark" | "japan" | "sakura-night" | "neo-tokyo" | "cosmos" | "arctic";
  language: "pt-BR";
  lightweightMode: boolean;
  showNodusId: boolean;
  notifyIncomingRequests: boolean;
  playRequestSound: boolean;
  allowRemoteControl: boolean;
  allowFileTransfer: boolean;
  allowClipboard: boolean;
  shareAudio: boolean;
  accessPasswordHash: string;
  remoteAccessPassword: string;
  unattendedAccess: boolean;
  trustedNodusIds: string[];
  preferredDisplayId: string;
  preferredResolution: "1366x768" | "1280x720" | "1920x1080" | "1024x768";
  connectionQuality: "auto" | "high" | "balanced" | "economy";
  maxFps: 60 | 120;
  coordinationUrl: string;
  googleClientId: string;
  iceServersJson: string;
}

export function loadRecents(): RecentDevice[] {
  return read<RecentDevice[]>(RECENTS_KEY, []);
}

export function saveRecent(device: CoordinationDevice): RecentDevice[] {
  const favorites = new Set(loadFavorites());
  const current = loadRecents().find((item) => item.nodusId === device.nodusId);
  const next: RecentDevice = {
    nodusId: device.nodusId,
    deviceName: device.deviceName,
    alias: current?.alias,
    folderId: current?.folderId,
    notes: current?.notes,
    tags: current?.tags,
    macAddress: current?.macAddress,
    lastConnectionAt: new Date().toISOString(),
    status: device.status,
    favorite: favorites.has(device.nodusId),
  };
  const merged = [next, ...loadRecents().filter((item) => item.nodusId !== device.nodusId)].slice(0, 12);
  localStorage.setItem(RECENTS_KEY, JSON.stringify(merged));
  return merged;
}

export function loadFavorites(): string[] {
  return read<string[]>(FAVORITES_KEY, []);
}

export function toggleFavorite(nodusId: string): string[] {
  const favorites = new Set(loadFavorites());
  if (favorites.has(nodusId)) favorites.delete(nodusId);
  else favorites.add(nodusId);
  const next = [...favorites];
  localStorage.setItem(FAVORITES_KEY, JSON.stringify(next));
  return next;
}

export function loadSettings(): LocalSettings {
  const defaults: LocalSettings = {
    startWithWindows: false,
    startMinimized: false,
    minimizeToTray: true,
    confirmBeforeDisconnect: true,
    theme: "dark",
    language: "pt-BR",
    lightweightMode: false,
    showNodusId: true,
    notifyIncomingRequests: true,
    playRequestSound: true,
    allowRemoteControl: true,
    allowFileTransfer: true,
    allowClipboard: true,
    shareAudio: true,
    accessPasswordHash: "",
    remoteAccessPassword: "",
    unattendedAccess: false,
    trustedNodusIds: [],
    preferredDisplayId: "",
    preferredResolution: "1920x1080",
    connectionQuality: "high",
    maxFps: 60,
    coordinationUrl: import.meta.env.VITE_NODUS_API ?? "",
    googleClientId: import.meta.env.VITE_GOOGLE_CLIENT_ID ?? GOOGLE_CLIENT_ID,
    iceServersJson: JSON.stringify([{ urls: "stun:stun.l.google.com:19302" }], null, 2),
  };
  const stored = read<Partial<LocalSettings>>(SETTINGS_KEY, {});
  const migratedShareAudio = localStorage.getItem(SETTINGS_VERSION_KEY) ? stored.shareAudio : true;
  return {
    ...defaults,
    ...stored,
    theme: ["japan", "sakura-night", "neo-tokyo", "cosmos", "arctic"].includes(stored.theme ?? "")
      ? stored.theme as LocalSettings["theme"]
      : "dark",
    maxFps: stored.maxFps === 120 ? 120 : 60,
    shareAudio: migratedShareAudio ?? defaults.shareAudio,
    coordinationUrl: defaults.coordinationUrl || stored.coordinationUrl || "",
    googleClientId: defaults.googleClientId || stored.googleClientId || "",
  };
}

export function saveSettings(settings: LocalSettings): void {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  localStorage.setItem(SETTINGS_VERSION_KEY, "2");
}

export function loadUser(): LocalUser | null {
  return read<LocalUser | null>(USER_KEY, null);
}

export function saveUser(user: LocalUser): void {
  localStorage.setItem(USER_KEY, JSON.stringify(user));
}

export function clearUser(): void {
  localStorage.removeItem(USER_KEY);
}

export function loadFolders(): DeviceFolder[] {
  return read<DeviceFolder[]>(FOLDERS_KEY, []);
}

export function createFolder(name: string): DeviceFolder[] {
  const trimmed = name.trim();
  if (!trimmed) return loadFolders();
  const folder: DeviceFolder = {
    id: crypto.randomUUID(),
    name: trimmed,
    createdAt: new Date().toISOString(),
  };
  const next = [...loadFolders(), folder];
  localStorage.setItem(FOLDERS_KEY, JSON.stringify(next));
  return next;
}

export function renameDevice(nodusId: string, alias: string): RecentDevice[] {
  const next = loadRecents().map((item) => (item.nodusId === nodusId ? { ...item, alias: alias.trim() || undefined } : item));
  localStorage.setItem(RECENTS_KEY, JSON.stringify(next));
  return next;
}

export function moveDeviceToFolder(nodusId: string, folderId: string): RecentDevice[] {
  const next = loadRecents().map((item) => (item.nodusId === nodusId ? { ...item, folderId: folderId || undefined } : item));
  localStorage.setItem(RECENTS_KEY, JSON.stringify(next));
  return next;
}

export function updateDevice(nodusId: string, patch: Partial<Pick<RecentDevice, "notes" | "tags" | "macAddress">>): RecentDevice[] {
  const next = loadRecents().map((item) => (item.nodusId === nodusId ? { ...item, ...patch } : item));
  localStorage.setItem(RECENTS_KEY, JSON.stringify(next));
  return next;
}

export function loadAccessLog(): AccessLogEntry[] {
  return read<AccessLogEntry[]>(ACCESS_LOG_KEY, []);
}

export function addAccessLog(entry: Omit<AccessLogEntry, "id" | "at">): AccessLogEntry[] {
  const next = [
    {
      ...entry,
      id: crypto.randomUUID(),
      at: new Date().toISOString(),
    },
    ...loadAccessLog(),
  ].slice(0, 100);
  localStorage.setItem(ACCESS_LOG_KEY, JSON.stringify(next));
  return next;
}

function read<T>(key: string, fallback: T): T {
  const stored = localStorage.getItem(key);
  if (!stored) return fallback;
  try {
    return JSON.parse(stored) as T;
  } catch {
    localStorage.removeItem(key);
    return fallback;
  }
}
