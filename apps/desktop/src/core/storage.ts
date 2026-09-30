import type { CoordinationDevice, RemoteFrameRate, RemoteResolution } from "./api";

const RECENTS_KEY = "nodus.recents.v1";
const FAVORITES_KEY = "nodus.favorites.v1";
const HIDDEN_CATALOG_DEVICES_KEY = "nodus.hidden-catalog-devices.v1";
const SETTINGS_KEY = "nodus.settings.v1";
const SETTINGS_VERSION_KEY = "nodus.settings.version";
const FOLDERS_KEY = "nodus.folders.v1";
const ACCESS_LOG_KEY = "nodus.access-log.v1";
const USER_KEY = "nodus.user.v1";
const GOOGLE_CLIENT_ID = "76048728439-dg1e8phioi7h6nr8ons45r4850t4puf7.apps.googleusercontent.com";
const BACKUP_FORMAT = "nodus-connect-settings";
const BACKUP_VERSION = 1;

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
  language: "pt-BR" | "en-US" | "ru-RU" | "ja-JP";
  lightweightMode: boolean;
  threeDimensionalStandby: boolean;
  showNodusId: boolean;
  notifyIncomingRequests: boolean;
  playRequestSound: boolean;
  allowRemoteControl: boolean;
  allowFileTransfer: boolean;
  allowClipboard: boolean;
  shareAudio: boolean;
  accessPasswordHash: string;
  unattendedAccess: boolean;
  trustedNodusIds: string[];
  preferredDisplayId: string;
  preferredResolution: RemoteResolution;
  connectionQuality: "auto" | "high" | "balanced" | "economy";
  maxFps: RemoteFrameRate;
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

export function deleteRecent(nodusId: string): RecentDevice[] {
  const next = loadRecents().filter((item) => item.nodusId !== nodusId);
  localStorage.setItem(RECENTS_KEY, JSON.stringify(next));
  localStorage.setItem(FAVORITES_KEY, JSON.stringify(loadFavorites().filter((item) => item !== nodusId)));
  return next;
}

export function loadFavorites(): string[] {
  return read<string[]>(FAVORITES_KEY, []);
}

export function loadHiddenCatalogDevices(): string[] {
  return read<string[]>(HIDDEN_CATALOG_DEVICES_KEY, []);
}

export function hideDeviceFromCatalog(nodusId: string): string[] {
  const next = [...new Set([...loadHiddenCatalogDevices(), nodusId])];
  localStorage.setItem(HIDDEN_CATALOG_DEVICES_KEY, JSON.stringify(next));
  return next;
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
    threeDimensionalStandby: false,
    showNodusId: true,
    notifyIncomingRequests: true,
    playRequestSound: true,
    allowRemoteControl: true,
    allowFileTransfer: true,
    allowClipboard: true,
    shareAudio: true,
    accessPasswordHash: "",
    unattendedAccess: false,
    trustedNodusIds: [],
    preferredDisplayId: "",
    preferredResolution: "native",
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
    threeDimensionalStandby: false,
    theme: ["japan", "sakura-night", "neo-tokyo", "cosmos", "arctic"].includes(stored.theme ?? "")
      ? stored.theme as LocalSettings["theme"]
      : "dark",
    language: ["pt-BR", "en-US", "ru-RU", "ja-JP"].includes(stored.language ?? "")
      ? stored.language as LocalSettings["language"]
      : "pt-BR",
    unattendedAccess: false,
    trustedNodusIds: [],
    preferredResolution: stored.preferredResolution && (stored.preferredResolution === "native" || /^\d{3,5}x\d{3,5}$/.test(stored.preferredResolution))
      ? stored.preferredResolution
      : defaults.preferredResolution,
    maxFps: [30, 45, 60, 90, 120].includes(stored.maxFps ?? 0) ? stored.maxFps as RemoteFrameRate : 60,
    shareAudio: migratedShareAudio ?? defaults.shareAudio,
    coordinationUrl: defaults.coordinationUrl || stored.coordinationUrl || "",
    googleClientId: defaults.googleClientId || stored.googleClientId || "",
  };
}

export function saveSettings(settings: LocalSettings): void {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...settings, threeDimensionalStandby: false }));
  localStorage.setItem(SETTINGS_VERSION_KEY, "2");
}

const backupBooleanKeys = [
  "startWithWindows", "startMinimized", "minimizeToTray", "confirmBeforeDisconnect", "lightweightMode",
  "showNodusId", "notifyIncomingRequests", "playRequestSound", "allowRemoteControl", "allowFileTransfer",
  "allowClipboard", "shareAudio",
] as const;

export function exportSettingsBackup(): string {
  const settings = loadSettings();
  const safeSettings: Partial<LocalSettings> = {};
  for (const key of backupBooleanKeys) safeSettings[key] = settings[key];
  Object.assign(safeSettings, {
    theme: settings.theme,
    language: settings.language,
    preferredResolution: settings.preferredResolution,
    connectionQuality: settings.connectionQuality,
    maxFps: settings.maxFps,
  });
  const recents = loadRecents().map(({ macAddress: _macAddress, ...device }) => device);
  return JSON.stringify({
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    settings: safeSettings,
    recents,
    favorites: loadFavorites(),
    folders: loadFolders(),
  }, null, 2);
}

export function importSettingsBackup(raw: string): { settings: LocalSettings; recents: RecentDevice[]; favorites: string[]; folders: DeviceFolder[] } {
  if (!raw || raw.length > 2_000_000) throw new Error("Arquivo de backup vazio ou muito grande.");
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error("Arquivo de backup inválido."); }
  if (!isRecord(value) || value.format !== BACKUP_FORMAT || value.version !== BACKUP_VERSION) throw new Error("Formato ou versão de backup incompatível.");
  const sourceSettings = isRecord(value.settings) ? value.settings : {};
  const patch: Partial<LocalSettings> = {};
  for (const key of backupBooleanKeys) if (typeof sourceSettings[key] === "boolean") patch[key] = sourceSettings[key];
  if (["dark", "japan", "sakura-night", "neo-tokyo", "cosmos", "arctic"].includes(String(sourceSettings.theme))) patch.theme = sourceSettings.theme as LocalSettings["theme"];
  if (["pt-BR", "en-US", "ru-RU", "ja-JP"].includes(String(sourceSettings.language))) patch.language = sourceSettings.language as LocalSettings["language"];
  if (sourceSettings.preferredResolution === "native" || /^\d{3,5}x\d{3,5}$/.test(String(sourceSettings.preferredResolution))) patch.preferredResolution = sourceSettings.preferredResolution as RemoteResolution;
  if (["auto", "high", "balanced", "economy"].includes(String(sourceSettings.connectionQuality))) patch.connectionQuality = sourceSettings.connectionQuality as LocalSettings["connectionQuality"];
  if ([30, 45, 60, 90, 120].includes(Number(sourceSettings.maxFps))) patch.maxFps = Number(sourceSettings.maxFps) as RemoteFrameRate;

  const favorites = uniqueNodusIds(value.favorites);
  const folders = Array.isArray(value.folders) ? value.folders.slice(0, 100).flatMap((item) => {
    if (!isRecord(item) || !safeText(item.id, 100) || !safeText(item.name, 100)) return [];
    return [{ id: String(item.id), name: String(item.name), createdAt: safeDate(item.createdAt) }];
  }) : [];
  const folderIds = new Set(folders.map((folder) => folder.id));
  const recents = Array.isArray(value.recents) ? value.recents.slice(0, 100).flatMap((item) => {
    if (!isRecord(item) || !/^\d{9}$/.test(String(item.nodusId)) || !safeText(item.deviceName, 100)) return [];
    const nodusId = String(item.nodusId);
    return [{
      nodusId,
      deviceName: String(item.deviceName),
      alias: safeText(item.alias, 100) || undefined,
      folderId: folderIds.has(String(item.folderId)) ? String(item.folderId) : undefined,
      lastConnectionAt: safeDate(item.lastConnectionAt),
      status: "offline" as const,
      favorite: favorites.includes(nodusId),
      notes: safeText(item.notes, 2_000) || undefined,
      tags: Array.isArray(item.tags) ? item.tags.slice(0, 20).map((tag) => String(tag).trim().slice(0, 50)).filter(Boolean) : undefined,
    }];
  }) : [];
  const settings = { ...loadSettings(), ...patch, threeDimensionalStandby: false, unattendedAccess: false, trustedNodusIds: [] };
  saveSettings(settings);
  localStorage.setItem(RECENTS_KEY, JSON.stringify(recents));
  localStorage.setItem(FAVORITES_KEY, JSON.stringify(favorites));
  localStorage.setItem(FOLDERS_KEY, JSON.stringify(folders));
  return { settings, recents, favorites, folders };
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

export function updateDevicePresence(nodusId: string, device: CoordinationDevice | null): RecentDevice[] {
  const next = loadRecents().map((item) => item.nodusId === nodusId
    ? { ...item, deviceName: device?.deviceName || item.deviceName, status: device?.status ?? "offline" }
    : item);
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function safeText(value: unknown, limit: number): string {
  return typeof value === "string" ? value.trim().slice(0, limit) : "";
}

function safeDate(value: unknown): string {
  const parsed = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : new Date().toISOString();
}

function uniqueNodusIds(value: unknown): string[] {
  return Array.isArray(value) ? [...new Set(value.map(String).filter((item) => /^\d{9}$/.test(item)))].slice(0, 100) : [];
}
