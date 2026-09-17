import {
  type ClipboardEvent as ReactClipboardEvent,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type RefObject,
  useEffect,
  useMemo,
  useRef,
  useState,
  type WheelEvent as ReactWheelEvent,
} from "react";
import {
  Activity,
  ArrowRight,
  Bell,
  BellRing,
  CheckCircle2,
  ChevronDown,
  Clipboard,
  Clock3,
  Copy,
  FileUp,
  FolderOpen,
  FolderUp,
  Gauge,
  Globe2,
  Grid2X2,
  Eye,
  EyeOff,
  Keyboard,
  List,
  Link,
  LockKeyhole,
  Mail,
  Maximize2,
  MousePointer2,
  MonitorCog,
  Monitor,
  MonitorUp,
  MoreHorizontal,
  Plus,
  Radio,
  Palette,
  Power,
  RefreshCw,
  Save,
  Search,
  Settings2,
  ShieldCheck,
  Star,
  Volume2,
  VolumeX,
  Wifi,
  X,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { formatNodusId, normalizeNodusId } from "../../../packages/common/src/nodusId";
import type { SessionPermission } from "../../../packages/protocol/src/index";
import {
  acceptSessionRequest,
  configureApiBase,
  createSessionRequest,
  denySessionRequest,
  fetchIceServers,
  getSessionRequest,
  getSignals,
  heartbeat,
  loginCoordinationAccount,
  registerCoordinationAccount,
  listIncomingRequests,
  lookupDevice,
  registerPresence,
  sendSignal,
  testIceServers,
  type RemoteResolution,
  type RemoteFrameRate,
  type SessionRequestRecord,
  type SignalMessage,
} from "./core/api";
import { loadNativeIdentity, loadOrCreateIdentity, regenerateNodusId, saveIdentity, type LocalIdentity } from "./core/identity";
import { applyLanguage, currentLocale } from "./core/localization";
import {
  firebaseConfigured,
  loadCloudSettings,
  saveCloudAccessLog,
  saveCloudSettings,
  signInFirebaseWithGoogle,
  syncCloudUser,
} from "./core/firebase";
import { connectRealtime } from "./core/realtime";
import {
  addAccessLog,
  clearUser,
  createFolder,
  deleteRecent,
  loadAccessLog,
  loadFolders,
  loadFavorites,
  loadRecents,
  loadSettings,
  loadUser,
  moveDeviceToFolder,
  renameDevice,
  saveRecent,
  saveSettings,
  saveUser,
  toggleFavorite,
  updateDevice,
  type AccessLogEntry,
  type DeviceFolder,
  type LocalSettings,
  type LocalUser,
  type RecentDevice,
} from "./core/storage";
import { createFileCryptoSession, decryptFileChunk, deriveFileCryptoKey, encryptFileChunk, type FileCryptoSession } from "./core/file-crypto";
import { CapturePool, type CaptureLease, type PooledCapture } from "./core/capture-pool";
import { advanceStage, recommendedStage, STAGE_LIMITS, type AdaptiveStage, type QualitySample } from "./core/adaptive-quality";

type ServiceState = "connecting" | "online" | "offline" | "error";
type SettingsSection = "general" | "access" | "connection" | "appearance";
type WindowsServiceStatus = { installed: boolean; running: boolean };
type View = "connection" | "devices" | "recents" | "favorites" | "files" | "settings";
const themeOptions: { id: LocalSettings["theme"]; label: string; description: string }[] = [
  { id: "dark", label: "Padrão", description: "Visual Nodus atual" },
  { id: "japan", label: "Japão Feudal", description: "Papel, vermelho e montanhas" },
  { id: "sakura-night", label: "Sakura Night", description: "Lua, sakuras e azul noturno" },
  { id: "neo-tokyo", label: "Neo Tokyo", description: "Neon urbano e chuva" },
  { id: "cosmos", label: "Cosmos", description: "Nebulosas e espaço profundo" },
  { id: "arctic", label: "Ártico", description: "Aurora, gelo e ciano" },
];
type RemoteSession = {
  role: "viewer" | "host";
  sessionId: string;
  remoteNodusId: string;
  remoteName: string;
  status: string;
  permissions: SessionPermission[];
};
type SessionRuntime = {
  session: RemoteSession;
  remoteStream: MediaStream | null;
  shareStream: MediaStream | null;
  controlReady: boolean;
  error: string;
  metrics: SessionMetrics;
};
type SessionMetrics = {
  bitrateKbps: number;
  fps: number;
  captureFps: number;
  encodedFps: number;
  sentFps: number;
  receivedFps: number;
  decodedFps: number;
  renderFps: number;
  renderDroppedFrames: number;
  latencyMs: number;
  route: "direct" | "relay" | "unknown";
  quality: "high" | "balanced" | "economy";
  codec: string;
  packetLossPct: number;
  jitterMs: number;
  availableKbps: number;
  captureWidth: number;
  captureHeight: number;
  encodeMs: number;
  decodeMs: number;
  droppedFrames: number;
  limitation: string;
  encoder: string;
  decoder: string;
};
type RemoteInputMessage =
  | { type: "mouseMove"; x: number; y: number }
  | { type: "mouseDown" | "mouseUp"; button: number }
  | { type: "wheel"; delta: number }
  | { type: "keyDown" | "keyUp"; keyCode: number }
  | { type: "clipboard"; text: string }
  | { type: "resolution"; resolution: RemoteResolution }
  | { type: "quality"; quality: LocalSettings["connectionQuality"]; maxFps: RemoteFrameRate }
  | { type: "display"; displayId: string }
  | { type: "screen-options"; displays: CaptureSource[] }
  | { type: "admin-request" }
  | { type: "admin-status"; status: "approved" | "denied" | "unavailable" };
type CaptureSource = { id: string; name: string; displayId: string; width: number; height: number };
type FileTransferRecord = {
  id: string;
  sessionId: string;
  remoteName: string;
  fileName: string;
  size: number;
  direction: "sent" | "received";
  status: "sending" | "sent" | "receiving" | "received" | "error";
  progress: number;
  at: string;
  url?: string;
  savedPath?: string;
  error?: string;
};
type IncomingFileTransfer = {
  id: string;
  sessionId: string;
  remoteName: string;
  fileName: string;
  size: number;
  mime: string;
  received: number;
  chunks: BlobPart[];
};
type FileControlMessage =
  | { type: "file-key"; publicKey: string }
  | { type: "file-meta"; id: string; name: string; size: number; mime?: string }
  | { type: "file-end"; id: string }
  | { type: "file-saved"; id: string; name: string }
  | { type: "file-error"; id: string; message: string };

const navItems: Array<{ view: View; label: string; icon: LucideIcon }> = [
  { view: "connection", label: "Conexão", icon: Monitor },
  { view: "devices", label: "Dispositivos", icon: Grid2X2 },
  { view: "favorites", label: "Favoritos", icon: Star },
  { view: "settings", label: "Configurações", icon: Settings2 },
];
const MAX_FILE_SIZE = 256 * 1024 * 1024;

export function App() {
  const [identity, setIdentity] = useState<LocalIdentity>(() => loadOrCreateIdentity());
  const [deviceName, setDeviceName] = useState(identity.deviceName);
  const [serviceState, setServiceState] = useState<ServiceState>("connecting");
  const [targetId, setTargetId] = useState("");
  const [targetPassword, setTargetPassword] = useState("");
  const [rememberTargetPassword, setRememberTargetPassword] = useState(false);
  const [, setLocaleRevision] = useState(0);
  const [feedback, setFeedback] = useState("");
  const [activeView, setActiveView] = useState<View>("connection");
  const [settingsSection, setSettingsSection] = useState<SettingsSection>("general");
  const [recents, setRecents] = useState<RecentDevice[]>(() => loadRecents());
  const [favorites, setFavorites] = useState<string[]>(() => loadFavorites());
  const [settings, setSettings] = useState<LocalSettings>(() => loadSettings());
  const [currentUser, setCurrentUser] = useState<LocalUser | null>(() => loadUser());
  const [folders, setFolders] = useState<DeviceFolder[]>(() => loadFolders());
  const [accessLog, setAccessLog] = useState<AccessLogEntry[]>(() => loadAccessLog());
  const [appVersion, setAppVersion] = useState("0.4.1");
  const [nativeGoogleClient, setNativeGoogleClient] = useState(false);
  const [windowsServiceStatus, setWindowsServiceStatus] = useState<WindowsServiceStatus>({ installed: false, running: false });
  const [serverIceServers, setServerIceServers] = useState<RTCIceServer[]>([]);
  const [loginError, setLoginError] = useState("");
  const [incomingRequests, setIncomingRequests] = useState<SessionRequestRecord[]>([]);
  const [outgoingRequest, setOutgoingRequest] = useState<SessionRequestRecord | null>(null);
  const [sessionRuntimes, setSessionRuntimes] = useState<SessionRuntime[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [fileTransfers, setFileTransfers] = useState<FileTransferRecord[]>([]);
  const [fileChannelReady, setFileChannelReady] = useState<Record<string, boolean>>({});
  const [confirmDisconnectId, setConfirmDisconnectId] = useState<string | null>(null);
  const [captureSources, setCaptureSources] = useState<CaptureSource[]>([]);
  const [remoteDisplays, setRemoteDisplays] = useState<Record<string, CaptureSource[]>>({});
  const [sessionResolutions, setSessionResolutions] = useState<Record<string, RemoteResolution>>({});
  const [remoteAudioMuted, setRemoteAudioMuted] = useState<Record<string, boolean>>({});
  const [adminRequests, setAdminRequests] = useState<Record<string, string>>({});
  const [recordingSessionId, setRecordingSessionId] = useState<string | null>(null);
  const [standby, setStandby] = useState(false);
  const peersRef = useRef(new Map<string, RTCPeerConnection>());
  const controlChannelsRef = useRef(new Map<string, RTCDataChannel>());
  const fileChannelsRef = useRef(new Map<string, RTCDataChannel>());
  const fileCryptoRef = useRef(new Map<string, { local: FileCryptoSession; remote: Promise<CryptoKey> | null }>());
  const fileCryptoSessionsRef = useRef(new Map<string, Promise<FileCryptoSession>>());
  const incomingFilesRef = useRef(new Map<string, IncomingFileTransfer>());
  const lastControlMoveRef = useRef(0);
  const signalTimersRef = useRef(new Map<string, number>());
  const lastSignalSeqRef = useRef(new Map<string, number>());
  const pendingCandidatesRef = useRef(new Map<string, RTCIceCandidateInit[]>());
  const reconnectTimersRef = useRef(new Map<string, number>());
  const reconnectAttemptsRef = useRef(new Map<string, number>());
  const hostInputRateRef = useRef(new Map<string, { at: number; count: number }>());
  const qualityTimersRef = useRef(new Map<string, number>());
  const statsRef = useRef(new Map<string, {
    bytes: number;
    captured: number;
    encoded: number;
    sent: number;
    received: number;
    decoded: number;
    encodeTime: number;
    decodeTime: number;
    dropped: number;
    lost: number;
    receivedPackets: number;
    at: number;
  }>());
  const qualityTierRef = useRef(new Map<string, string>());
  const adaptiveStateRef = useRef(new Map<string, { stage: AdaptiveStage; stableSamples: number }>());
  const requestedResolutionsRef = useRef(new Map<string, RemoteResolution>());
  const requestedQualitiesRef = useRef(new Map<string, LocalSettings["connectionQuality"]>());
  const requestedFpsRef = useRef(new Map<string, RemoteFrameRate>());
  const capturePoolRef = useRef(new CapturePool());
  const captureQueueRef = useRef<Promise<void>>(Promise.resolve());
  const captureCleanupRef = useRef(new Map<string, () => void>());
  const recordingRef = useRef(new Map<string, { recorder: MediaRecorder; chunks: BlobPart[] }>());
  const autoAcceptingRef = useRef(new Set<string>());
  const processedSignalsRef = useRef(new Set<string>());
  const lastIncomingAlertRef = useRef("");
  const targetPasswordLookupRef = useRef(0);
  const outgoingRequestRef = useRef<SessionRequestRecord | null>(null);
  const sessionsRef = useRef<SessionRuntime[]>([]);
  const remoteVideoRef = useRef<HTMLVideoElement | null>(null);
  const renderStatsRef = useRef(new Map<string, { fps: number; dropped: number }>());
  const activeRuntime = useMemo(
    () => sessionRuntimes.find((item) => item.session.sessionId === selectedSessionId) ?? sessionRuntimes[0] ?? null,
    [selectedSessionId, sessionRuntimes],
  );
  const activeSession = activeRuntime?.session ?? null;
  const remoteStream = activeRuntime?.remoteStream ?? null;
  const controlReady = Boolean(activeRuntime?.controlReady);
  const sessionError = activeRuntime?.error ?? "";
  const visibleNodusId = settings.showNodusId ? identity.nodusId : maskNodusId(identity.nodusId);
  const activeFileReady = Boolean(activeSession && fileChannelReady[activeSession.sessionId]);

  const statusLabel = useMemo(() => {
    if (serviceState === "online") return "Online";
    if (serviceState === "connecting") return "Conectando";
    if (serviceState === "offline") return "Offline";
    return "Conexao ativa";
  }, [serviceState]);
  const pageTitle = activeView === "favorites" ? "Favoritos" : activeView === "settings" ? "Configurações" : activeView === "devices" ? "Dispositivos" : "Bem-vindo de volta";
  const pageSubtitle = activeView === "favorites"
    ? "Seus dispositivos mais importantes em um só lugar."
    : activeView === "settings"
      ? "Personalize o funcionamento do Nodus Connect."
      : activeView === "devices"
        ? "Gerencie todos os seus dispositivos em um só lugar."
        : "Acesso remoto simples, rápido e seguro.";

  useEffect(() => {
    sessionsRef.current = sessionRuntimes;
  }, [sessionRuntimes]);

  useEffect(() => {
    outgoingRequestRef.current = outgoingRequest;
  }, [outgoingRequest]);

  useEffect(() => {
    document.documentElement.dataset.theme = settings.theme;
  }, [settings.theme]);

  useEffect(() => {
    applyLanguage(settings.language);
    setLocaleRevision((revision) => revision + 1);
  }, [settings.language]);

  useEffect(() => {
    document.documentElement.dataset.mode = settings.lightweightMode ? "simple" : "full";
  }, [settings.lightweightMode]);

  useEffect(() => {
    const shouldTrack = !settings.lightweightMode && sessionRuntimes.length === 0 && !incomingRequests.length && !outgoingRequest;
    if (!shouldTrack) {
      setStandby(false);
      return;
    }

    let timer = window.setTimeout(() => setStandby(true), 20_000);
    const reset = () => {
      setStandby(false);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setStandby(true), 20_000);
    };
    const events = ["pointermove", "pointerdown", "keydown", "touchstart"];
    events.forEach((event) => window.addEventListener(event, reset));
    return () => {
      window.clearTimeout(timer);
      events.forEach((event) => window.removeEventListener(event, reset));
    };
  }, [incomingRequests.length, outgoingRequest, sessionRuntimes.length, settings.lightweightMode]);

  useEffect(() => {
    window.nodusDesktop?.setStartupOptions({
      startWithWindows: settings.startWithWindows,
      startMinimized: settings.startMinimized,
      minimizeToTray: settings.minimizeToTray,
    }).catch(() => undefined);
  }, [settings.minimizeToTray, settings.startMinimized, settings.startWithWindows]);

  useEffect(() => {
    if (!currentUser || !firebaseConfigured()) return;
    syncCloudUser(currentUser, identity).catch(() => undefined);
    loadCloudSettings().then((cloudSettings) => {
      if (!cloudSettings) return;
      setSettings((current) => {
        const next = { ...current, ...cloudSettings };
        saveSettings(next);
        return next;
      });
    }).catch(() => undefined);
  }, [currentUser, identity.nodusId]);

  useEffect(() => {
    loadNativeIdentity().then((nativeIdentity) => {
      if (!nativeIdentity) {
        saveIdentity(identity);
        return;
      }
      if (nativeIdentity.nodusId !== identity.nodusId || nativeIdentity.deviceNameConfirmed !== identity.deviceNameConfirmed) {
        setIdentity(nativeIdentity);
        setDeviceName(nativeIdentity.deviceName);
      }
    });
  }, []);

  useEffect(() => {
    window.nodusDesktop?.getAppInfo().then((info) => {
      setAppVersion(info.version);
      setNativeGoogleClient(Boolean(info.googleClientConfigured));
    }).catch(() => undefined);
    window.nodusDesktop?.getNativeCaptureStatus().then((status) => {
      window.nodusDesktop?.writeDiagnostic(`capture-backend=${status.backend || "chromium-getdisplaymedia"} wgc-supported=${status.supported}`);
    }).catch(() => undefined);
    window.nodusDesktop?.getServiceStatus().then(setWindowsServiceStatus).catch(() => undefined);
  }, []);

  async function changeWindowsService(action: "install" | "uninstall") {
    const result = action === "install"
      ? await window.nodusDesktop?.installService()
      : await window.nodusDesktop?.uninstallService();
    if (!result?.ok) {
      setFeedback(result?.error || "Nao foi possivel alterar o servico do Windows.");
      return;
    }
    setWindowsServiceStatus(window.nodusDesktop ? await window.nodusDesktop.getServiceStatus() : { installed: false, running: false });
    setFeedback(action === "install" ? "Servico do Windows instalado." : "Servico do Windows removido.");
  }

  async function setWindowsServiceRunning(running: boolean) {
    const result = running ? await window.nodusDesktop?.startService() : await window.nodusDesktop?.stopService();
    if (!result?.ok) {
      setFeedback(result?.error || "Nao foi possivel alterar o estado do servico.");
      return;
    }
    setWindowsServiceStatus(window.nodusDesktop ? await window.nodusDesktop.getServiceStatus() : { installed: false, running: false });
    setFeedback(running ? "Servico do Windows iniciado." : "Servico do Windows parado.");
  }

  useEffect(() => {
    configureApiBase(settings.coordinationUrl);
  }, [settings.coordinationUrl]);

  useEffect(() => {
    const onResult = (event: Event) => applyGoogleLoginResult((event as CustomEvent).detail);
    window.addEventListener("nodus-google-login-result", onResult);
    const removeIpc = window.nodusDesktop?.onGoogleLoginResult?.(applyGoogleLoginResult);
    return () => {
      window.removeEventListener("nodus-google-login-result", onResult);
      removeIpc?.();
    };
  }, []);

  useEffect(() => {
    let disposed = false;
    const refresh = async () => {
      const remoteIceServers = await fetchIceServers(settings.coordinationUrl);
      if (disposed) return;
      setServerIceServers(remoteIceServers);
      const effectiveIceServers = remoteIceServers.length ? remoteIceServers : parseIceServers(settings.iceServersJson);
      const health = await testIceServers(effectiveIceServers);
      if (disposed) return;
      logDiagnostic(`ice-check relay=${health.relayAvailable} ok=${health.ok} elapsed=${health.elapsedMs}ms candidates=${JSON.stringify(health.candidateTypes)} urls=${health.urls.length}${health.error ? ` error=${health.error}` : ""}`);
    };
    refresh();
    const timer = window.setInterval(refresh, 45 * 60_000);
    window.addEventListener("online", refresh);
    return () => {
      disposed = true;
      window.clearInterval(timer);
      window.removeEventListener("online", refresh);
    };
  }, [settings.coordinationUrl, settings.iceServersJson]);

  useEffect(() => {
    window.nodusDesktop?.getCaptureSources().then(setCaptureSources).catch(() => undefined);
  }, []);

  useEffect(() => {
    window.nodusDesktop?.setCaptureOptions({
      sourceId: settings.preferredDisplayId,
      displayId: captureSources.find((source) => source.id === settings.preferredDisplayId)?.displayId,
      shareAudio: settings.shareAudio,
    }).catch(() => undefined);
  }, [captureSources, settings.preferredDisplayId, settings.shareAudio]);

  useEffect(() => {
    window.nodusDesktop?.setTrayIdentity({
      nodusId: identity.nodusId,
      deviceName: identity.deviceName,
      status: statusLabel,
    });
  }, [identity, statusLabel]);

  useEffect(() => {
    if (!identity.deviceNameConfirmed) return;

    let disposed = false;

    async function syncPresence() {
      try {
        setServiceState("connecting");
        await registerPresence(identity);
        if (!disposed) setServiceState("online");
      } catch (error) {
        if (error instanceof Error && error.message === "NODUS_ID_CONFLICT") {
          const next = regenerateNodusId(identity);
          saveIdentity(next);
          if (!disposed) setIdentity(next);
          return;
        }
        if (!disposed) setServiceState(navigator.onLine ? "error" : "offline");
      }
    }

    syncPresence();
    const timer = window.setInterval(async () => {
      try {
        await heartbeat(identity);
        if (!disposed) setServiceState("online");
      } catch {
        if (!disposed) setServiceState(navigator.onLine ? "error" : "offline");
      }
    }, 8_000);

    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [identity, settings.coordinationUrl]);

  useEffect(() => {
    if (!identity.deviceNameConfirmed) return;
    const realtime = connectRealtime(identity.nodusId, {
      onIncomingRequest: (request) => {
        setIncomingRequests((items) => (items.some((item) => item.id === request.id) ? items : [request, ...items]));
      },
      onRequestUpdate: (request) => {
        if (outgoingRequestRef.current?.id !== request.id) return;
        outgoingRequestRef.current = request;
        setOutgoingRequest(request);
        if (request.status === "denied") {
          setFeedback("Pedido recusado pelo outro computador.");
          outgoingRequestRef.current = null;
          setOutgoingRequest(null);
        }
        if (request.status === "accepted" && request.sessionId) {
          recordAccess({
            nodusId: request.targetNodusId,
            deviceName: request.targetName ?? "Dispositivo remoto",
            direction: "outgoing",
            result: "accepted",
          });
          setFeedback("Autorizado. Estabelecendo conexao segura...");
          outgoingRequestRef.current = null;
          setOutgoingRequest(null);
          startViewerSession(request).catch(() => setFeedback("Nao foi possivel iniciar o acesso remoto."));
        }
      },
      onSignal: (signal) => {
        handleSignal(signal).catch(() => updateRuntime(signal.sessionId, { error: "Falha temporaria na conexao." }));
      },
    });
    return () => realtime.close();
  }, [identity.deviceNameConfirmed, identity.nodusId, settings.coordinationUrl]);

  useEffect(() => {
    if (!identity.deviceNameConfirmed) return;
    const timer = window.setInterval(async () => {
      try {
        setIncomingRequests(await listIncomingRequests(identity.nodusId));
      } catch {
        setIncomingRequests([]);
      }
    }, 2_000);
    return () => window.clearInterval(timer);
  }, [identity, settings.coordinationUrl]);

  useEffect(() => {
    if (!outgoingRequest || outgoingRequest.status !== "pending") return;
    const timer = window.setInterval(async () => {
      try {
        const current = await getSessionRequest(outgoingRequest.id);
        setOutgoingRequest(current);
        if (current.status === "denied") {
          setFeedback("Pedido recusado pelo outro computador.");
          setOutgoingRequest(null);
        }
        if (current.status === "accepted" && current.sessionId) {
          recordAccess({
            nodusId: current.targetNodusId,
            deviceName: current.targetName ?? "Dispositivo remoto",
            direction: "outgoing",
            result: "accepted",
          });
          setFeedback("Autorizado. Estabelecendo conexao segura...");
          setOutgoingRequest(null);
          await startViewerSession(current);
        }
      } catch {
        if (!sessionsRef.current.some((item) => item.session.remoteNodusId === outgoingRequest.targetNodusId)) {
          setFeedback("Nao foi possivel acompanhar o pedido.");
        }
      }
    }, 700);
    return () => window.clearInterval(timer);
  }, [outgoingRequest, settings.coordinationUrl]);

  useEffect(() => {
    const video = remoteVideoRef.current;
    if (!video) return;
    video.srcObject = remoteStream;
    video.muted = false;
    const play = () => video.play().catch(() => {
      video.muted = true;
      return video.play().catch(() => undefined);
    });
    video.addEventListener("loadedmetadata", play);
    play();
    const sessionId = activeSession?.sessionId;
    let callback = 0;
    let started = performance.now();
    let frames = 0;
    let dropped = 0;
    let lastPresented = 0;
    const onFrame: VideoFrameRequestCallback = (now, metadata) => {
      frames++;
      if (lastPresented) dropped += Math.max(0, metadata.presentedFrames - lastPresented - 1);
      lastPresented = metadata.presentedFrames;
      if (sessionId && now - started >= 1000) {
        renderStatsRef.current.set(sessionId, { fps: Math.round(frames * 1000 / (now - started)), dropped });
        started = now;
        frames = 0;
        dropped = 0;
      }
      callback = video.requestVideoFrameCallback(onFrame);
    };
    if (sessionId && remoteStream && video.requestVideoFrameCallback) callback = video.requestVideoFrameCallback(onFrame);
    return () => {
      video.removeEventListener("loadedmetadata", play);
      if (callback) video.cancelVideoFrameCallback(callback);
    };
  }, [remoteStream, activeSession?.sessionId]);

  useEffect(() => {
    if (!captureSources.length) return;
    sessionsRef.current.filter((item) => item.session.role === "host").forEach((runtime) => {
      const channel = controlChannelsRef.current.get(runtime.session.sessionId);
      if (channel?.readyState === "open") channel.send(JSON.stringify({ type: "screen-options", displays: captureSources } satisfies RemoteInputMessage));
    });
  }, [captureSources]);

  useEffect(() => {
    const request = incomingRequests[0];
    if (!request || lastIncomingAlertRef.current === request.id) return;
    lastIncomingAlertRef.current = request.id;
    if (settings.playRequestSound) playRequestTone();
    if (settings.notifyIncomingRequests) notifyIncomingRequest(request);
  }, [incomingRequests, settings.notifyIncomingRequests, settings.playRequestSound]);

  useEffect(() => {
    const request = incomingRequests.find((item) => (settings.unattendedAccess && settings.trustedNodusIds.includes(item.requesterNodusId))
      || Boolean(settings.accessPasswordHash && item.passwordHash === settings.accessPasswordHash));
    if (!request || autoAcceptingRef.current.has(request.id)) return;
    autoAcceptingRef.current.add(request.id);
    acceptIncoming(request).finally(() => autoAcceptingRef.current.delete(request.id));
  }, [incomingRequests, settings.accessPasswordHash, settings.trustedNodusIds, settings.unattendedAccess]);

  function completeOnboarding(event: FormEvent) {
    event.preventDefault();
    const trimmedName = deviceName.trim();
    if (!trimmedName) return;

    const next = { ...identity, deviceName: trimmedName, deviceNameConfirmed: true };
    saveIdentity(next);
    setIdentity(next);
  }

  async function connect(event: FormEvent) {
    event.preventDefault();
    await connectToDevice(targetId, targetPassword);
  }

  async function copyNodusId() {
    const nodusId = formatNodusId(identity.nodusId);
    try {
      if (window.nodusDesktop?.writeClipboard) await window.nodusDesktop.writeClipboard(nodusId);
      else await navigator.clipboard.writeText(nodusId);
      setFeedback("Nodus ID copiado.");
    } catch {
      setFeedback("Nao foi possivel copiar o Nodus ID.");
    }
  }

  async function connectToDevice(target: string, password = "") {
    const normalized = normalizeNodusId(target);
    if (!normalized) {
      setFeedback("Informe um Nodus ID com 9 digitos.");
      return;
    }
    if (normalized === identity.nodusId) {
      setFeedback("Digite o Nodus ID de outro computador. Este e o ID deste PC.");
      return;
    }

    try {
      setFeedback("Localizando dispositivo...");
      const iceWarmup = fetchIceServers(settings.coordinationUrl).then((servers) => {
        if (servers.length) setServerIceServers(servers);
        return servers;
      }).catch(() => [] as RTCIceServer[]);
      const device = await lookupDevice(normalized);
      if (!device) {
        setFeedback("Dispositivo nao encontrado. Abra o Nodus no outro PC e use o ID dele.");
        return;
      }
      setRecents(saveRecent(device));
      const request = await createSessionRequest({
        requesterNodusId: identity.nodusId,
        requesterName: currentUser ? `${currentUser.name} - ${identity.deviceName}` : identity.deviceName,
        targetNodusId: normalized,
        requestedPermissions: ["screen:view", "mouse:control", "keyboard:control", "clipboard:sync", "files:transfer", "audio:remote"],
        passwordHash: await hashPassword(password),
        preferredResolution: settings.preferredResolution,
        preferredFps: settings.maxFps,
      });
      recordAccess({
        nodusId: device.nodusId,
        deviceName: device.deviceName,
        direction: "outgoing",
        result: "requested",
      });
      setOutgoingRequest(request);
      if (rememberTargetPassword && password) await window.nodusDesktop?.saveConnectionPassword(normalized, password);
      else if (!rememberTargetPassword) await window.nodusDesktop?.saveConnectionPassword(normalized, "");
      if (!rememberTargetPassword) setTargetPassword("");
      setFeedback("Dispositivo encontrado. Aguardando autorizacao...");
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "Nao foi possivel conectar ao dispositivo.");
    }
  }

  function updateTargetId(value: string) {
    const lookupId = ++targetPasswordLookupRef.current;
    const formatted = formatNodusId(value);
    const normalized = normalizeNodusId(formatted);
    setTargetId(formatted);
    if (!normalized) {
      setTargetPassword("");
      setRememberTargetPassword(false);
      return;
    }
    window.nodusDesktop?.getConnectionPassword(normalized).then((password) => {
      if (targetPasswordLookupRef.current !== lookupId) return;
      setTargetPassword(password);
      setRememberTargetPassword(Boolean(password));
    }).catch(() => undefined);
  }

  async function acceptIncoming(request: SessionRequestRecord): Promise<string | null> {
    let captureLease: CaptureLease | null = null;
    try {
      setFeedback("");
      if (settings.accessPasswordHash && request.passwordHash !== settings.accessPasswordHash) {
        setFeedback("Senha incorreta. O solicitante precisa informar a senha deste Nodus.");
        return "Senha incorreta. Informe a senha definida neste Nodus no pedido de conexão.";
      }
      const iceWarmup = fetchIceServers(settings.coordinationUrl).then((servers) => {
        if (servers.length) setServerIceServers(servers);
        return servers;
      }).catch(() => [] as RTCIceServer[]);
      captureLease = await acquireHostCapture(
        request.preferredResolution ?? settings.preferredResolution,
        request.preferredFps ?? settings.maxFps,
        settings.preferredDisplayId,
        allowedPermissions(request, settings).includes("audio:remote"),
      );
      const accepted = await acceptSessionRequest(request.id, identity.deviceName, allowedPermissions(request, settings));
      recordAccess({
        nodusId: request.requesterNodusId,
        deviceName: request.requesterName,
        direction: "incoming",
        result: "accepted",
      });
      setIncomingRequests((items) => items.filter((item) => item.id !== request.id));
      await startHostSession(accepted, captureLease);
      captureLease = null;
      return null;
    } catch {
      captureLease?.release();
      setFeedback("Compartilhamento cancelado ou indisponivel.");
      return "Nao foi possivel iniciar o compartilhamento. Verifique a permissao de captura de tela e tente novamente.";
    }
  }

  async function denyIncoming(request: SessionRequestRecord) {
    await denySessionRequest(request.id);
    recordAccess({
      nodusId: request.requesterNodusId,
      deviceName: request.requesterName,
      direction: "incoming",
      result: "denied",
    });
    setIncomingRequests((items) => items.filter((item) => item.id !== request.id));
  }

  function upsertRuntime(runtime: SessionRuntime) {
    setSessionRuntimes((current) => {
      const next = [runtime, ...current.filter((item) => item.session.sessionId !== runtime.session.sessionId)];
      sessionsRef.current = next;
      return next;
    });
    setSelectedSessionId(runtime.session.sessionId);
  }

  function updateRuntime(
    sessionId: string,
    patch: Partial<Omit<SessionRuntime, "session">> & { session?: Partial<RemoteSession> },
  ) {
    setSessionRuntimes((current) => {
      const next = current.map((item) => {
        if (item.session.sessionId !== sessionId) return item;
        const { session, ...rest } = patch;
        return { ...item, ...rest, session: { ...item.session, ...session } };
      });
      sessionsRef.current = next;
      return next;
    });
  }

  function removeRuntime(sessionId: string) {
    const next = sessionsRef.current.filter((item) => item.session.sessionId !== sessionId);
    sessionsRef.current = next;
    setSessionRuntimes(next);
    if (selectedSessionId === sessionId) setSelectedSessionId(next[0]?.session.sessionId ?? null);
    syncRemoteControl(next);
  }

  function syncRemoteControl(runtimes = sessionsRef.current) {
    window.nodusDesktop?.setRemoteControlActive(settings.allowRemoteControl && runtimes.some((item) => item.session.role === "host")).catch(() => undefined);
  }

  async function startHostSession(request: SessionRequestRecord, captureLease: CaptureLease) {
    if (!request.sessionId) {
      captureLease.release();
      return;
    }
    if (peersRef.current.has(request.sessionId)) {
      captureLease.release();
      setSelectedSessionId(request.sessionId);
      return;
    }
    const stream = captureLease.stream;
    captureCleanupRef.current.get(request.sessionId)?.();
    captureCleanupRef.current.set(request.sessionId, captureLease.release);
    const remoteNodusId = request.requesterNodusId;
    const peer = createPeer(request.sessionId, identity.nodusId, remoteNodusId, "host", getEffectiveIceServers());
    const permissions = request.grantedPermissions ?? allowedPermissions(request, settings);
    stream.getTracks().filter((track) => track.kind === "video" || permissions.includes("audio:remote")).forEach((track) => {
      if (track.kind === "video") track.contentHint = settings.connectionQuality === "economy" ? "detail" : "motion";
      const sender = peer.addTrack(track, stream);
      logDiagnostic(`track-added id=${request.sessionId} kind=${track.kind} state=${track.readyState}`);
      const transceiver = peer.getTransceivers().find((item) => item.sender === sender);
      if (track.kind === "video" && transceiver) preferDesktopCodecs(transceiver);
      if (track.kind === "video") {
        requestedResolutionsRef.current.set(request.sessionId!, request.preferredResolution ?? settings.preferredResolution);
        requestedFpsRef.current.set(request.sessionId!, request.preferredFps ?? settings.maxFps);
        setSessionResolutions((current) => ({ ...current, [request.sessionId!]: request.preferredResolution ?? settings.preferredResolution }));
        tuneVideoSender(sender, request.preferredFps);
        applyRequestedResolution(sender, request.preferredResolution ?? settings.preferredResolution);
      }
    });
    upsertRuntime({
      session: {
        role: "host",
        sessionId: request.sessionId,
        remoteNodusId,
        remoteName: request.requesterName,
        status: "Compartilhando sua tela",
        permissions,
      },
      remoteStream: null,
      shareStream: stream,
      controlReady: false,
      error: "",
      metrics: emptyMetrics(),
    });
    window.nodusDesktop?.setRemoteControlActive(settings.allowRemoteControl).catch(() => undefined);
    startSignalPolling(request.sessionId, identity.nodusId);
  }

  async function startViewerSession(request: SessionRequestRecord) {
    if (!request.sessionId) return;
    if (peersRef.current.has(request.sessionId)) {
      setSelectedSessionId(request.sessionId);
      return;
    }
    const remoteNodusId = request.targetNodusId;
    const permissions = request.grantedPermissions ?? ["screen:view", "mouse:control", "keyboard:control", "clipboard:sync", "files:transfer"];
    const peer = createPeer(request.sessionId, identity.nodusId, remoteNodusId, "viewer", getEffectiveIceServers());
    preferDesktopCodecs(peer.addTransceiver("video", { direction: "recvonly" }));
    if (permissions.includes("audio:remote")) peer.addTransceiver("audio", { direction: "recvonly" });
    if (permissions.some((item) => item === "mouse:control" || item === "keyboard:control" || item === "clipboard:sync")) {
      attachViewerControl(request.sessionId, peer.createDataChannel("control"));
    }
    if (permissions.includes("files:transfer")) attachFileTransfer(request.sessionId, peer.createDataChannel("files"), request.targetName ?? "Dispositivo remoto");
    const runtime: SessionRuntime = {
      session: {
        role: "viewer",
        sessionId: request.sessionId,
        remoteNodusId,
        remoteName: request.targetName ?? "Dispositivo remoto",
        status: "Conectando ao computador remoto",
        permissions,
      },
      remoteStream: null,
      shareStream: null,
      controlReady: false,
      error: "",
      metrics: emptyMetrics(),
    };
    upsertRuntime(runtime);
    setSessionResolutions((current) => ({ ...current, [request.sessionId!]: settings.preferredResolution }));
    await peer.setLocalDescription(await peer.createOffer());
    await sendReliableSignal(request.sessionId, {
      from: identity.nodusId,
      to: remoteNodusId,
      type: "offer",
      payload: peer.localDescription,
    });
    startSignalPolling(request.sessionId, identity.nodusId);
  }

  async function ensureSessionIceServers() {
    const current = getEffectiveIceServers();
    if (hasTurnServer(current)) return current;
    const fresh = await fetchIceServers(settings.coordinationUrl);
    if (fresh.length) {
      setServerIceServers(fresh);
      return fresh;
    }
    return current;
  }

  function createPeer(sessionId: string, from: string, to: string, role: RemoteSession["role"], iceServersOverride?: RTCIceServer[]) {
    cleanupSession(sessionId, false);
    const iceServers = iceServersOverride?.length ? iceServersOverride : getEffectiveIceServers();
    logDiagnostic(`session-start id=${sessionId} role=${role} turn=${hasTurnServer(iceServers)} urls=${iceServerUrls(iceServers).length}`);
    const peer = new RTCPeerConnection({
      iceServers,
      iceCandidatePoolSize: 8,
      bundlePolicy: "max-bundle",
    });
    peersRef.current.set(sessionId, peer);
    peer.ondatachannel = (event) => {
      if (event.channel.label === "files") {
        const permissions = sessionsRef.current.find((item) => item.session.sessionId === sessionId)?.session.permissions ?? [];
        if (role === "host" && (!settings.allowFileTransfer || !permissions.includes("files:transfer"))) {
          event.channel.close();
          return;
        }
        attachFileTransfer(sessionId, event.channel, sessionsRef.current.find((item) => item.session.sessionId === sessionId)?.session.remoteName ?? "Dispositivo remoto");
        return;
      }
      if (event.channel.label === "control" && role === "host") {
        if (!settings.allowRemoteControl) {
          event.channel.close();
          return;
        }
        attachHostControl(sessionId, event.channel);
      }
    };
    peer.onicecandidate = (event) => {
      if (event.candidate) {
        logDiagnostic(`ice-candidate id=${sessionId} role=${role} type=${candidateType(event.candidate.candidate)}`);
        sendSignal(sessionId, { from, to, type: "ice-candidate", payload: event.candidate }).catch(() => undefined);
      }
    };
    peer.ontrack = (event) => {
      const currentStream = sessionsRef.current.find((item) => item.session.sessionId === sessionId)?.remoteStream;
      const stream = event.streams[0] ?? currentStream ?? new MediaStream();
      if (!stream.getTracks().some((track) => track.id === event.track.id)) stream.addTrack(event.track);
      logDiagnostic(`remote-track id=${sessionId} kind=${event.track.kind} state=${event.track.readyState} streams=${event.streams.length}`);
      updateRuntime(sessionId, { remoteStream: stream, session: { status: "Tela remota conectada" } });
    };
    peer.onconnectionstatechange = () => {
      logDiagnostic(`connection-state id=${sessionId} role=${role} state=${peer.connectionState}`);
      updateRuntime(sessionId, { session: { status: connectionLabel(peer.connectionState) } });
    };
    peer.oniceconnectionstatechange = () => {
      logDiagnostic(`ice-state id=${sessionId} role=${role} state=${peer.iceConnectionState}`);
      if (peer.iceConnectionState === "failed" || peer.iceConnectionState === "disconnected") {
        updateRuntime(sessionId, { error: "Reconectando..." });
        if (role === "viewer") scheduleIceRestart(sessionId, peer, from, to, peer.iceConnectionState === "failed" ? 0 : 1800);
      }
      if (peer.iceConnectionState === "connected" || peer.iceConnectionState === "completed") {
        const timer = reconnectTimersRef.current.get(sessionId);
        if (timer) window.clearTimeout(timer);
        reconnectTimersRef.current.delete(sessionId);
        reconnectAttemptsRef.current.delete(sessionId);
        updateRuntime(sessionId, { error: "" });
      }
    };
    startQualityMonitoring(sessionId, peer, role);
    return peer;
  }

  function scheduleIceRestart(sessionId: string, peer: RTCPeerConnection, from: string, to: string, delayMs: number) {
    if (reconnectTimersRef.current.has(sessionId)) return;
    const attempt = (reconnectAttemptsRef.current.get(sessionId) ?? 0) + 1;
    if (attempt > 5) {
      logDiagnostic(`ice-restart-failed id=${sessionId} attempts=5`);
      updateRuntime(sessionId, { error: "Nao foi possivel retomar. Tente conectar novamente." });
      return;
    }
    reconnectAttemptsRef.current.set(sessionId, attempt);
    const timer = window.setTimeout(async () => {
      reconnectTimersRef.current.delete(sessionId);
      if (peer.connectionState === "closed") return;
      try {
        if (peer.signalingState !== "stable") throw new Error("Aguardando resposta");
        const freshIceServers = await fetchIceServers(settings.coordinationUrl);
        if (freshIceServers.length) {
          const configuration = peer.getConfiguration();
          configuration.iceServers = freshIceServers;
          peer.setConfiguration(configuration);
          setServerIceServers(freshIceServers);
        }
        logDiagnostic(`ice-restart id=${sessionId} attempt=${attempt} turn=${hasTurnServer(peer.getConfiguration().iceServers ?? [])}`);
        await peer.setLocalDescription(await peer.createOffer({ iceRestart: true }));
        await sendReliableSignal(sessionId, { from, to, type: "offer", payload: peer.localDescription });
      } catch {
        updateRuntime(sessionId, { error: `Reconectando... tentativa ${attempt} de 5` });
      } finally {
        if (!["connected", "closed"].includes(peer.connectionState)) {
          scheduleIceRestart(sessionId, peer, from, to, Math.min(10_000, 1200 * 2 ** attempt));
        }
      }
    }, delayMs);
    reconnectTimersRef.current.set(sessionId, timer);
  }

  function startQualityMonitoring(sessionId: string, peer: RTCPeerConnection, role: RemoteSession["role"]) {
    const current = qualityTimersRef.current.get(sessionId);
    if (current) window.clearInterval(current);
    let inspecting = false;
    const inspect = async () => {
      if (peer.connectionState === "closed" || inspecting) return;
      inspecting = true;
      try {
        const reports = await peer.getStats();
        let bytes = 0;
        let captured = 0;
        let captureRate = 0;
        let encoded = 0;
        let sent = 0;
        let receivedFrames = 0;
        let decoded = 0;
        let encodeTime = 0;
        let decodeTime = 0;
        let dropped = 0;
        let captureWidth = 0;
        let captureHeight = 0;
        let latencyMs = 0;
        let jitterMs = 0;
        let availableKbps = 0;
        let lost = 0;
        let received = 0;
        let route: SessionMetrics["route"] = "unknown";
        let codecId = "";
        let codec = "";
        let limitation = "none";
        let encoder = "";
        let decoder = "";
        const codecs = new Map<string, string>();
        const candidates = new Map<string, string>();
        let selectedPair: { localCandidateId?: string; remoteCandidateId?: string; currentRoundTripTime?: number; availableOutgoingBitrate?: number } | undefined;
        for (const report of reports.values()) {
          const item = report as RTCStats & Record<string, number | string | boolean | undefined>;
          if (item.type === "codec") codecs.set(item.id, String(item.mimeType || "").split("/").pop()?.toUpperCase() || "");
          if (item.type === "local-candidate" || item.type === "remote-candidate") candidates.set(item.id, String(item.candidateType || ""));
          if (item.type === "candidate-pair" && item.state === "succeeded" && (item.nominated || item.selected)) {
            selectedPair = {
              localCandidateId: String(item.localCandidateId || ""),
              remoteCandidateId: String(item.remoteCandidateId || ""),
              currentRoundTripTime: Number(item.currentRoundTripTime || 0),
              availableOutgoingBitrate: Number(item.availableOutgoingBitrate || 0),
            };
          }
          if (item.type === "inbound-rtp" && item.kind === "video" && role === "viewer") {
            bytes += Number(item.bytesReceived || 0);
            receivedFrames += Number(item.framesReceived || 0);
            decoded += Number(item.framesDecoded || 0);
            decodeTime += Number(item.totalDecodeTime || 0);
            dropped += Number(item.framesDropped || 0);
            decoder = String(item.decoderImplementation || decoder);
            lost += Number(item.packetsLost || 0);
            received += Number(item.packetsReceived || 0);
            jitterMs = Math.max(jitterMs, Number(item.jitter || 0) * 1000);
            codecId = String(item.codecId || codecId);
          }
          if (item.type === "outbound-rtp" && item.kind === "video" && role === "host") {
            bytes += Number(item.bytesSent || 0);
            encoded += Number(item.framesEncoded || 0);
            sent += Number(item.framesSent || 0);
            encodeTime += Number(item.totalEncodeTime || 0);
            limitation = String(item.qualityLimitationReason || limitation);
            encoder = String(item.encoderImplementation || encoder);
            codecId = String(item.codecId || codecId);
          }
          if (item.type === "remote-inbound-rtp" && item.kind === "video" && role === "host") {
            lost += Number(item.packetsLost || 0);
            received += Number(item.packetsReceived || 0);
            jitterMs = Math.max(jitterMs, Number(item.jitter || 0) * 1000);
          }
          if (item.type === "media-source" && item.kind === "video" && role === "host") {
            captured += Number(item.frames || 0);
            captureRate = Math.max(captureRate, Number(item.framesPerSecond || 0));
            captureWidth = Math.max(captureWidth, Number(item.width || 0));
            captureHeight = Math.max(captureHeight, Number(item.height || 0));
          }
        }
        codec = codecs.get(codecId) || "";
        if (selectedPair) {
          latencyMs = Math.round(Number(selectedPair.currentRoundTripTime || 0) * 1000);
          availableKbps = Math.round(Number(selectedPair.availableOutgoingBitrate || 0) / 1000);
          route = candidates.get(String(selectedPair.localCandidateId)) === "relay" || candidates.get(String(selectedPair.remoteCandidateId)) === "relay" ? "relay" : "direct";
        }
        const now = performance.now();
        const previous = statsRef.current.get(sessionId);
        const bitrateKbps = previous ? Math.max(0, Math.round(((bytes - previous.bytes) * 8) / (now - previous.at))) : 0;
        const stageFps = (current: number, prior: number) => previous ? Math.max(0, Math.round(((current - prior) * 1000) / (now - previous.at))) : 0;
        const captureFps = Math.round(captureRate) || stageFps(captured, previous?.captured ?? 0);
        const encodedFps = stageFps(encoded, previous?.encoded ?? 0);
        const sentFps = stageFps(sent, previous?.sent ?? 0);
        const receivedFps = stageFps(receivedFrames, previous?.received ?? 0);
        const decodedFps = stageFps(decoded, previous?.decoded ?? 0);
        const encodeMs = previous && encoded > previous.encoded ? Math.round(((encodeTime - previous.encodeTime) * 1000 / (encoded - previous.encoded)) * 10) / 10 : 0;
        const decodeMs = previous && decoded > previous.decoded ? Math.round(((decodeTime - previous.decodeTime) * 1000 / (decoded - previous.decoded)) * 10) / 10 : 0;
        const droppedFrames = previous ? Math.max(0, dropped - previous.dropped) : 0;
        const fps = role === "host" ? encodedFps || sentFps || captureFps : decodedFps || receivedFps;
        const lostDelta = Math.max(0, lost - (previous?.lost ?? lost));
        const receivedDelta = Math.max(0, received - (previous?.receivedPackets ?? received));
        const lossPct = lostDelta / Math.max(1, lostDelta + receivedDelta) * 100;
        statsRef.current.set(sessionId, { bytes, captured, encoded, sent, received: receivedFrames, decoded, encodeTime, decodeTime, dropped, lost, receivedPackets: received, at: now });
        const targetFps = requestedFpsRef.current.get(sessionId) ?? settings.maxFps;
        const sample: QualitySample = {
          rttMs: latencyMs, jitterMs, lossPct, availableKbps, bitrateKbps, captureFps, encodedFps, encodeMs, targetFps,
          activePicture: captureFps >= 10 || bitrateKbps >= 200 || limitation === "cpu", limitation,
        };
        const quality = await applyAdaptiveQuality(sessionId, peer, role, sample);
        const render = renderStatsRef.current.get(sessionId);
        const metrics = { bitrateKbps, fps, captureFps, encodedFps, sentFps, receivedFps, decodedFps, renderFps: render?.fps ?? 0, renderDroppedFrames: render?.dropped ?? 0, latencyMs, route, quality, codec, packetLossPct: Math.round(lossPct * 10) / 10, jitterMs: Math.round(jitterMs), availableKbps, captureWidth, captureHeight, encodeMs, decodeMs, droppedFrames, limitation, encoder, decoder };
        logMediaDiagnostic(`media-stats id=${sessionId} role=${role} capture=${captureFps} encoded=${encodedFps} sent=${sentFps} received=${receivedFps} decoded=${decodedFps} bitrate=${bitrateKbps} encodeMs=${encodeMs} dropped=${droppedFrames} limit=${limitation} encoder=${encoder || "pending"}`);
        window.nodusDesktop?.writePerformance?.(JSON.stringify({ at: new Date().toISOString(), sessionId, role, ...metrics })).catch(() => undefined);
        updateRuntime(sessionId, { metrics });
      } catch {} finally { inspecting = false; }
    };
    inspect();
    qualityTimersRef.current.set(sessionId, window.setInterval(inspect, 1000));
  }

  async function applyAdaptiveQuality(
    sessionId: string,
    peer: RTCPeerConnection,
    role: RemoteSession["role"],
    sample: QualitySample,
  ): Promise<SessionMetrics["quality"]> {
    const requestedQuality = requestedQualitiesRef.current.get(sessionId) ?? settings.connectionQuality;
    const requestedFps = requestedFpsRef.current.get(sessionId) ?? settings.maxFps;
    if (role !== "host") return requestedQuality === "economy" ? "economy" : requestedQuality === "high" ? "high" : "balanced";
    const sender = peer.getSenders().find((item) => item.track?.kind === "video");
    if (!sender) return "balanced";
    const minimum = requestedQuality === "economy" ? 2 : requestedQuality === "balanced" ? 1 : 0;
    const current = adaptiveStateRef.current.get(sessionId) ?? { stage: minimum as AdaptiveStage, stableSamples: 0 };
    const target = Math.max(minimum, recommendedStage(sample)) as AdaptiveStage;
    const next = advanceStage(current.stage, target, current.stableSamples);
    adaptiveStateRef.current.set(sessionId, next);
    const limits = STAGE_LIMITS[next.stage];
    const quality: SessionMetrics["quality"] = next.stage >= 3 ? "economy" : next.stage >= 1 ? "balanced" : "high";
    const requestedResolution = requestedResolutionsRef.current.get(sessionId);
    const [targetWidth, targetHeight] = (requestedResolution ?? settings.preferredResolution).split("x").map(Number);
    const source = sender.track?.getSettings();
    const scale = Math.max(1, (source?.width ?? targetWidth) / targetWidth, (source?.height ?? targetHeight) / Math.min(targetHeight, limits.height));
    const fps = next.stage === 0 ? requestedFps : Math.min(requestedFps, limits.fps);
    const desiredBitrate = next.stage === 0 && requestedFps > 60 ? 24_000_000 : limits.bitrate;
    const bandwidthBound = sample.activePicture && sample.availableKbps > 0 && sample.bitrateKbps >= sample.availableKbps * 0.7;
    const bitrate = sample.availableKbps > 0 && (bandwidthBound || sample.limitation === "bandwidth")
      ? Math.min(desiredBitrate, Math.max(300_000, Math.round(sample.availableKbps * 850)))
      : desiredBitrate;
    const roundedBitrate = Math.max(300_000, Math.round(bitrate / 250_000) * 250_000);
    const tier = `${next.stage}:${scale.toFixed(2)}:${fps}:${roundedBitrate}`;
    if (qualityTierRef.current.get(sessionId) === tier) return quality;
    try {
      const parameters = sender.getParameters();
      if (!parameters.encodings.length) parameters.encodings = [{}];
      parameters.degradationPreference = "maintain-framerate";
      parameters.encodings[0].maxBitrate = roundedBitrate;
      parameters.encodings[0].maxFramerate = fps;
      parameters.encodings[0].scaleResolutionDownBy = scale;
      await sender.setParameters(parameters);
      qualityTierRef.current.set(sessionId, tier);
      logMediaDiagnostic(`quality-stage id=${sessionId} stage=${next.stage} scale=${scale.toFixed(2)} fps=${fps} bitrate=${roundedBitrate}`);
    } catch {}
    return quality;
  }

  function tuneVideoSender(sender: RTCRtpSender, requestedFps = settings.maxFps) {
    try {
      const parameters = sender.getParameters();
      if (!parameters.encodings.length) parameters.encodings = [{}];
      parameters.degradationPreference = "maintain-framerate";
      parameters.encodings[0].maxBitrate = settings.connectionQuality === "high" ? (requestedFps > 60 ? 24_000_000 : 14_000_000) : 10_000_000;
      parameters.encodings[0].maxFramerate = requestedFps;
      sender.setParameters(parameters).catch(() => undefined);
    } catch {}
  }

  function attachHostControl(sessionId: string, channel: RTCDataChannel) {
    controlChannelsRef.current.set(sessionId, channel);
    channel.onopen = () => {
      updateRuntime(sessionId, { controlReady: true });
      if (captureSources.length) channel.send(JSON.stringify({ type: "screen-options", displays: captureSources } satisfies RemoteInputMessage));
    };
    channel.onclose = () => updateRuntime(sessionId, { controlReady: false });
    channel.onmessage = (event) => {
      try {
        if (typeof event.data !== "string" || event.data.length > 1_000_000) return;
        const now = Date.now();
        const rate = hostInputRateRef.current.get(sessionId);
        const current = !rate || now - rate.at >= 1000 ? { at: now, count: 1 } : { ...rate, count: rate.count + 1 };
        hostInputRateRef.current.set(sessionId, current);
        if (current.count > 500) return;
        const message = JSON.parse(event.data) as RemoteInputMessage;
        const permissions = sessionsRef.current.find((item) => item.session.sessionId === sessionId)?.session.permissions ?? [];
        if (message.type === "admin-request") {
          setAdminRequests((current) => ({ ...current, [sessionId]: sessionsRef.current.find((item) => item.session.sessionId === sessionId)?.session.remoteName ?? "O outro computador" }));
          return;
        }
        if (message.type === "resolution" || message.type === "display") {
          if (message.type === "resolution") setSessionResolutions((current) => ({ ...current, [sessionId]: message.resolution }));
          if (permissions.includes("screen:view")) switchHostCapture(sessionId, message.type === "resolution" ? message.resolution : undefined, message.type === "display" ? message.displayId : undefined).catch(() => updateRuntime(sessionId, { error: "Nao foi possivel trocar a tela compartilhada." }));
          return;
        }
        if (message.type === "quality") {
          const fpsChanged = requestedFpsRef.current.get(sessionId) !== message.maxFps;
          requestedQualitiesRef.current.set(sessionId, message.quality);
          requestedFpsRef.current.set(sessionId, message.maxFps);
          qualityTierRef.current.delete(sessionId);
          adaptiveStateRef.current.delete(sessionId);
          if (fpsChanged) switchHostCapture(sessionId, undefined, undefined, message.maxFps).catch(() => undefined);
          // The next one-second sample applies the new preference using current network conditions.
          return;
        }
        if (message.type === "screen-options") return;
        if (message.type === "clipboard") {
          if (settings.allowClipboard && permissions.includes("clipboard:sync")) window.nodusDesktop?.writeClipboard(message.text).catch(() => undefined);
        } else {
          const allowed = message.type.startsWith("mouse") || message.type === "wheel"
            ? permissions.includes("mouse:control")
            : permissions.includes("keyboard:control");
          if (settings.allowRemoteControl && allowed) window.nodusDesktop?.applyRemoteInput(message).catch(() => undefined);
        }
      } catch {
        updateRuntime(sessionId, { error: "Comando remoto invalido." });
      }
    };
  }

  function attachViewerControl(sessionId: string, channel: RTCDataChannel) {
    controlChannelsRef.current.set(sessionId, channel);
    channel.onopen = () => {
      updateRuntime(sessionId, { controlReady: true, session: { status: "Tela e controle conectados" } });
      channel.send(JSON.stringify({ type: "quality", quality: settings.connectionQuality, maxFps: settings.maxFps } satisfies RemoteInputMessage));
    };
    channel.onclose = () => updateRuntime(sessionId, { controlReady: false });
    channel.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data) as RemoteInputMessage;
        if (message.type === "screen-options") setRemoteDisplays((current) => ({ ...current, [sessionId]: message.displays }));
        if (message.type === "admin-status") {
          const label = message.status === "approved" ? "O proprietário autorizou a solicitação no Windows." : message.status === "denied" ? "O proprietário recusou a solicitação de administrador." : "A solicitação de administrador não pôde ser concluída.";
          updateRuntime(sessionId, { error: label });
        }
      } catch {}
    };
  }

  function attachFileTransfer(sessionId: string, channel: RTCDataChannel, remoteName: string) {
    channel.binaryType = "arraybuffer";
    fileChannelsRef.current.set(sessionId, channel);
    const cryptoSessionPromise = createFileCryptoSession().then((local) => {
      fileCryptoRef.current.set(sessionId, { local, remote: null });
      return local;
    });
    fileCryptoSessionsRef.current.set(sessionId, cryptoSessionPromise);
    setFileChannelReady((current) => ({ ...current, [sessionId]: channel.readyState === "open" }));
    channel.onopen = async () => {
      setFileChannelReady((current) => ({ ...current, [sessionId]: true }));
      const local = await cryptoSessionPromise;
      if (channel.readyState === "open") channel.send(JSON.stringify({ type: "file-key", publicKey: local.publicKey } satisfies FileControlMessage));
    };
    channel.onclose = () => {
      fileCryptoRef.current.delete(sessionId);
      setFileChannelReady((current) => ({ ...current, [sessionId]: false }));
    };
    channel.onmessage = (event) => {
      handleFileTransferMessage(sessionId, remoteName, event.data).catch(() => {
        updateRuntime(sessionId, { error: "Nao foi possivel receber o arquivo." });
      });
    };
  }

  async function handleFileTransferMessage(sessionId: string, remoteName: string, data: unknown) {
    if (typeof data === "string") {
      const message = JSON.parse(data) as FileControlMessage;
      if (message.type === "file-key") {
        const local = await fileCryptoSessionsRef.current.get(sessionId);
        if (!local) throw new Error("Sessao de arquivos indisponivel.");
        const state = fileCryptoRef.current.get(sessionId);
        if (state) state.remote = deriveFileCryptoKey(local, message.publicKey);
        return;
      }
      if (message.type === "file-meta") {
        if (!Number.isFinite(message.size) || message.size < 0 || message.size > MAX_FILE_SIZE) {
          fileChannelsRef.current.get(sessionId)?.send(JSON.stringify({ type: "file-error", id: message.id, message: "Arquivo maior que 256 MB." } satisfies FileControlMessage));
          return;
        }
        const transfer: IncomingFileTransfer = {
          id: message.id,
          sessionId,
          remoteName,
          fileName: message.name,
          size: message.size,
          mime: message.mime || "application/octet-stream",
          received: 0,
          chunks: [],
        };
        incomingFilesRef.current.set(message.id, transfer);
        upsertFileTransfer({
          id: message.id,
          sessionId,
          remoteName,
          fileName: message.name,
          size: message.size,
          direction: "received",
          status: "receiving",
          progress: 0,
          at: new Date().toISOString(),
        });
      }
      if (message.type === "file-end") {
        const transfer = incomingFilesRef.current.get(message.id);
        if (!transfer) return;
        const blob = new Blob(transfer.chunks, { type: transfer.mime });
        const saved = window.nodusDesktop ? await window.nodusDesktop.saveReceivedFile(transfer.fileName, await blob.arrayBuffer()) : null;
        if (saved && !saved.ok) {
          incomingFilesRef.current.delete(message.id);
          patchFileTransfer(message.id, { status: "error", error: "Não foi possível salvar em Documentos." });
          fileChannelsRef.current.get(sessionId)?.send(JSON.stringify({ type: "file-error", id: message.id, message: "O computador remoto não conseguiu salvar o arquivo." } satisfies FileControlMessage));
          return;
        }
        const url = URL.createObjectURL(blob);
        incomingFilesRef.current.delete(message.id);
        patchFileTransfer(message.id, { status: "received", progress: 100, url, savedPath: saved?.name ? `Documentos\\${saved.name}` : undefined });
        if (saved?.name) fileChannelsRef.current.get(sessionId)?.send(JSON.stringify({ type: "file-saved", id: message.id, name: saved.name } satisfies FileControlMessage));
      }
      if (message.type === "file-saved") patchFileTransfer(message.id, { status: "sent", progress: 100, savedPath: `Documentos\\${message.name}` });
      if (message.type === "file-error") patchFileTransfer(message.id, { status: "error", error: message.message });
      return;
    }

    const transfer = [...incomingFilesRef.current.values()].find((item) => item.sessionId === sessionId && item.received < item.size);
    if (!transfer) return;
    const chunk = data instanceof Blob ? await data.arrayBuffer() : data instanceof ArrayBuffer ? data : null;
    if (!chunk) return;
    const keyPromise = fileCryptoRef.current.get(sessionId)?.remote;
    if (!keyPromise) throw new Error("A criptografia da transferencia ainda nao esta pronta.");
    const decrypted = await decryptFileChunk(await keyPromise, chunk);
    transfer.chunks.push(decrypted);
    transfer.received += decrypted.byteLength;
    patchFileTransfer(transfer.id, { progress: Math.min(99, Math.round((transfer.received / transfer.size) * 100)) });
  }

  async function sendFile(file: File) {
    if (!activeSession) {
      setFeedback("Inicie uma conexao antes de enviar arquivos.");
      return;
    }
    const channel = fileChannelsRef.current.get(activeSession.sessionId);
    if (!channel || channel.readyState !== "open") {
      setFeedback("Aguarde a conexao de arquivos ficar pronta.");
      return;
    }
    if (file.size > MAX_FILE_SIZE) {
      setFeedback("O limite por arquivo e 256 MB.");
      return;
    }

    const id = crypto.randomUUID();
    upsertFileTransfer({
      id,
      sessionId: activeSession.sessionId,
      remoteName: activeSession.remoteName,
      fileName: file.name,
      size: file.size,
      direction: "sent",
      status: "sending",
      progress: 0,
      at: new Date().toISOString(),
    });

    try {
      channel.send(JSON.stringify({ type: "file-meta", id, name: file.name, size: file.size, mime: file.type } satisfies FileControlMessage));
      const keyPromise = fileCryptoRef.current.get(activeSession.sessionId)?.remote;
      if (!keyPromise) throw new Error("A criptografia da transferencia ainda nao esta pronta.");
      const key = await keyPromise;
      const chunkSize = 64 * 1024;
      for (let offset = 0; offset < file.size; offset += chunkSize) {
        await waitForFileChannel(channel);
        channel.send(await encryptFileChunk(key, await file.slice(offset, offset + chunkSize).arrayBuffer()));
        patchFileTransfer(id, { progress: Math.min(99, Math.round(((offset + chunkSize) / file.size) * 100)) });
      }
      await waitForFileChannel(channel);
      channel.send(JSON.stringify({ type: "file-end", id } satisfies FileControlMessage));
      patchFileTransfer(id, { status: "sent", progress: 100 });
      setFeedback("Arquivo enviado.");
    } catch {
      channel.readyState === "open" && channel.send(JSON.stringify({ type: "file-error", id, message: "Envio cancelado." } satisfies FileControlMessage));
      patchFileTransfer(id, { status: "error", error: "Nao foi possivel enviar." });
    }
  }

  function upsertFileTransfer(record: FileTransferRecord) {
    setFileTransfers((current) => [record, ...current.filter((item) => item.id !== record.id)].slice(0, 30));
  }

  function patchFileTransfer(id: string, patch: Partial<FileTransferRecord>) {
    setFileTransfers((current) => current.map((item) => (item.id === id ? { ...item, ...patch } : item)));
  }

  async function waitForFileChannel(channel: RTCDataChannel) {
    while (channel.readyState === "open" && channel.bufferedAmount > 2_000_000) {
      await new Promise((resolve) => window.setTimeout(resolve, 60));
    }
    if (channel.readyState !== "open") throw new Error("Conexao encerrada.");
  }

  function startSignalPolling(sessionId: string, selfNodusId: string) {
    const currentTimer = signalTimersRef.current.get(sessionId);
    if (currentTimer) window.clearInterval(currentTimer);
    lastSignalSeqRef.current.set(sessionId, 0);
    const poll = async () => {
      try {
        const signals = await getSignals(sessionId, selfNodusId, lastSignalSeqRef.current.get(sessionId) ?? 0);
        for (const signal of signals) {
          lastSignalSeqRef.current.set(sessionId, Math.max(lastSignalSeqRef.current.get(sessionId) ?? 0, signal.seq));
          await handleSignal(signal);
        }
      } catch {
        updateRuntime(sessionId, { error: "Falha temporaria na conexao." });
      }
    };
    poll();
    signalTimersRef.current.set(sessionId, window.setInterval(poll, 180));
  }

  async function handleSignal(signal: SignalMessage) {
    if (signal.from === identity.nodusId) return;
    const peer = peersRef.current.get(signal.sessionId);
    if (!peer) return;
    const signalKey = `${signal.sessionId}:${signal.seq}`;
    if (processedSignalsRef.current.has(signalKey)) return;
    processedSignalsRef.current.add(signalKey);
    logDiagnostic(`signal-recv id=${signal.sessionId} type=${signal.type} from=${signal.from}`);

    if (signal.type === "offer") {
      if (peer.signalingState === "have-local-offer") await peer.setLocalDescription({ type: "rollback" });
      await peer.setRemoteDescription(signal.payload as RTCSessionDescriptionInit);
      await flushPendingCandidates(signal.sessionId, peer);
      await peer.setLocalDescription(await peer.createAnswer());
      await sendReliableSignal(signal.sessionId, {
        from: identity.nodusId,
        to: signal.from,
        type: "answer",
        payload: peer.localDescription,
      });
    }
    if (signal.type === "answer" && peer.signalingState === "have-local-offer") {
      await peer.setRemoteDescription(signal.payload as RTCSessionDescriptionInit);
      await flushPendingCandidates(signal.sessionId, peer);
    }
    if (signal.type === "ice-candidate") {
      const candidate = signal.payload as RTCIceCandidateInit;
      if (!peer.remoteDescription) {
        pendingCandidatesRef.current.set(signal.sessionId, [...(pendingCandidatesRef.current.get(signal.sessionId) ?? []), candidate]);
        return;
      }
      await peer.addIceCandidate(candidate).catch(() => undefined);
    }
    if (signal.type === "disconnect") endSession(signal.sessionId, false);
  }

  async function flushPendingCandidates(sessionId: string, peer: RTCPeerConnection) {
    const candidates = pendingCandidatesRef.current.get(sessionId) ?? [];
    pendingCandidatesRef.current.delete(sessionId);
    for (const candidate of candidates) await peer.addIceCandidate(candidate);
  }

  async function sendReliableSignal(sessionId: string, signal: Omit<SignalMessage, "seq" | "sessionId" | "createdAt">) {
    let lastError: unknown;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        logDiagnostic(`signal-send id=${sessionId} type=${signal.type} to=${signal.to}`);
        return await sendSignal(sessionId, signal);
      } catch (error) {
        lastError = error;
        await delay(220 + attempt * 280);
      }
    }
    throw lastError instanceof Error ? lastError : new Error("Nao foi possivel iniciar a conexao.");
  }

  function delay(ms: number) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  function remotePoint(surface: HTMLElement, event: MouseEvent) {
    const rect = surface.getBoundingClientRect();
    const video = surface.querySelector("video");
    let left = rect.left;
    let top = rect.top;
    let width = rect.width;
    let height = rect.height;
    if (video?.videoWidth && video.videoHeight) {
      const surfaceRatio = rect.width / rect.height;
      const videoRatio = video.videoWidth / video.videoHeight;
      if (surfaceRatio > videoRatio) {
        width = rect.height * videoRatio;
        left += (rect.width - width) / 2;
      } else {
        height = rect.width / videoRatio;
        top += (rect.height - height) / 2;
      }
    }
    return {
      x: clampRatio((event.clientX - left) / width),
      y: clampRatio((event.clientY - top) / height),
    };
  }

  function clampRatio(value: number) {
    return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
  }

  function disconnectSession(sessionId = selectedSessionId, confirmed = false) {
    if (!sessionId) return;
    if (!confirmed && settings.confirmBeforeDisconnect) {
      setConfirmDisconnectId(sessionId);
      return;
    }
    setConfirmDisconnectId(null);
    if (sessionId) endSession(sessionId, true);
  }

  function endSession(sessionId: string, notifyRemote: boolean) {
    const current = sessionsRef.current.find((item) => item.session.sessionId === sessionId)?.session;
    if (current && notifyRemote) {
      recordAccess({
        nodusId: current.remoteNodusId,
        deviceName: current.remoteName,
        direction: current.role === "viewer" ? "outgoing" : "incoming",
        result: "disconnected",
      });
      sendSignal(current.sessionId, {
        from: identity.nodusId,
        to: current.remoteNodusId,
        type: "disconnect",
        payload: {},
      }).catch(() => undefined);
    }
    cleanupSession(sessionId, true);
    removeRuntime(sessionId);
  }

  function cleanupSession(sessionId: string, stopShare: boolean) {
    const timer = signalTimersRef.current.get(sessionId);
    if (timer) window.clearInterval(timer);
    signalTimersRef.current.delete(sessionId);
    const reconnectTimer = reconnectTimersRef.current.get(sessionId);
    if (reconnectTimer) window.clearTimeout(reconnectTimer);
    reconnectTimersRef.current.delete(sessionId);
    reconnectAttemptsRef.current.delete(sessionId);
    hostInputRateRef.current.delete(sessionId);
    const qualityTimer = qualityTimersRef.current.get(sessionId);
    if (qualityTimer) window.clearInterval(qualityTimer);
    qualityTimersRef.current.delete(sessionId);
    statsRef.current.delete(sessionId);
    renderStatsRef.current.delete(sessionId);
    qualityTierRef.current.delete(sessionId);
    adaptiveStateRef.current.delete(sessionId);
    requestedResolutionsRef.current.delete(sessionId);
    requestedQualitiesRef.current.delete(sessionId);
    requestedFpsRef.current.delete(sessionId);
    setSessionResolutions((current) => {
      const { [sessionId]: _removed, ...next } = current;
      return next;
    });
    setRemoteAudioMuted((current) => {
      const { [sessionId]: _removed, ...next } = current;
      return next;
    });
    setAdminRequests((current) => {
      const { [sessionId]: _removed, ...next } = current;
      return next;
    });
    const recording = recordingRef.current.get(sessionId);
    if (recording?.recorder.state !== "inactive") recording?.recorder.stop();
    recordingRef.current.delete(sessionId);
    if (recordingSessionId === sessionId) setRecordingSessionId(null);
    lastSignalSeqRef.current.delete(sessionId);
    pendingCandidatesRef.current.delete(sessionId);
    for (const key of processedSignalsRef.current) {
      if (key.startsWith(`${sessionId}:`)) processedSignalsRef.current.delete(key);
    }
    controlChannelsRef.current.get(sessionId)?.close();
    controlChannelsRef.current.delete(sessionId);
    fileChannelsRef.current.get(sessionId)?.close();
    fileChannelsRef.current.delete(sessionId);
    fileCryptoRef.current.delete(sessionId);
    fileCryptoSessionsRef.current.delete(sessionId);
    incomingFilesRef.current.forEach((value, key) => {
      if (value.sessionId === sessionId) incomingFilesRef.current.delete(key);
    });
    setFileChannelReady((current) => ({ ...current, [sessionId]: false }));
    peersRef.current.get(sessionId)?.close();
    peersRef.current.delete(sessionId);
    if (stopShare) {
      const stopCapture = captureCleanupRef.current.get(sessionId);
      captureCleanupRef.current.delete(sessionId);
      if (stopCapture) stopCapture();
      else sessionsRef.current.find((item) => item.session.sessionId === sessionId)?.shareStream?.getTracks().forEach((track) => track.stop());
    }
  }

  function connectionLabel(state: RTCPeerConnectionState) {
    if (state === "connected") return "Conectado";
    if (state === "connecting") return "Conectando";
    if (state === "disconnected") return "Reconectando";
    if (state === "failed") return "Falha na conexao";
    if (state === "closed") return "Encerrado";
    return "Preparando conexao";
  }

  function onToggleFavorite(nodusId: string) {
    const next = toggleFavorite(nodusId);
    setFavorites(next);
    setRecents(loadRecents().map((item) => ({ ...item, favorite: next.includes(item.nodusId) })));
  }

  function onDeleteDevice(nodusId: string) {
    setRecents(deleteRecent(nodusId));
    setFavorites(loadFavorites());
    setFeedback("Dispositivo excluido.");
  }

  function onRenameDevice(nodusId: string, alias: string) {
    setRecents(renameDevice(nodusId, alias));
    setFeedback(alias.trim() ? "Nome do dispositivo atualizado." : "Nome original restaurado.");
  }

  async function openSupport() {
    const url = "https://wa.me/5543998453910";
    try {
      if (window.nodusDesktop?.openExternal) await window.nodusDesktop.openExternal(url);
      else window.open(url, "_blank", "noopener,noreferrer");
    } catch {
      setFeedback("Nao foi possivel abrir o WhatsApp.");
    }
  }

  async function wakeDevice(device: RecentDevice) {
    if (!device.macAddress) {
      setFeedback("Informe o endereco do computador nos detalhes do dispositivo.");
      return;
    }
    const result = await window.nodusDesktop?.wakeOnLan(device.macAddress);
    setFeedback(result?.ok ? "Sinal para ligar enviado." : result?.error || "Nao foi possivel enviar o sinal.");
  }

  function updateSettings(patch: Partial<LocalSettings>) {
    const next = { ...settings, ...patch };
    setSettings(next);
    saveSettings(next);
    if (firebaseConfigured()) saveCloudSettings(next).catch(() => undefined);
    if ("startWithWindows" in patch || "startMinimized" in patch) {
      window.nodusDesktop?.setStartupOptions({
        startWithWindows: next.startWithWindows,
        startMinimized: next.startMinimized,
        minimizeToTray: next.minimizeToTray,
      }).catch(() => undefined);
    }
    if ("allowRemoteControl" in patch) {
      window.nodusDesktop?.setRemoteControlActive(next.allowRemoteControl && sessionsRef.current.some((item) => item.session.role === "host")).catch(() => undefined);
    }
    if ("preferredResolution" in patch && activeSession) {
      if (activeSession.role === "viewer") sendRemoteInputToSession(activeSession.sessionId, { type: "resolution", resolution: next.preferredResolution });
      else switchHostCapture(activeSession.sessionId, next.preferredResolution).catch(() => setFeedback("Nao foi possivel aplicar a resolucao agora."));
    }
    if ("preferredDisplayId" in patch && activeSession?.role === "host") {
      switchHostCapture(activeSession.sessionId, undefined, next.preferredDisplayId).catch(() => setFeedback("Nao foi possivel trocar a tela agora."));
    }
    if (("connectionQuality" in patch || "maxFps" in patch) && activeSession?.role === "viewer") {
      sendRemoteInputToSession(activeSession.sessionId, { type: "quality", quality: next.connectionQuality, maxFps: next.maxFps });
    }
  }

  async function loginWithGoogle() {
    setLoginError("");
    const result = await window.nodusDesktop?.googleLogin();
    if (!result) {
      setLoginError("Login Google esta disponivel no aplicativo instalado.");
      return;
    }
    applyGoogleLoginResult(result);
  }

  function applyGoogleLoginResult(result: { ok: true; user: LocalUser; idToken?: string; accessToken?: string } | { ok: false; error: string }) {
    if (!result.ok) {
      setLoginError(result.error);
      return;
    }
    saveUser(result.user);
    setCurrentUser(result.user);
    setLoginError("");
    signInFirebaseWithGoogle(result.idToken, result.accessToken)
      .catch(() => null)
      .then(() => syncCloudUser(result.user, identity))
      .catch(() => undefined);
  }

  function loginLocal(name: string) {
    name = name.trim();
    if (!name) {
      setLoginError("Informe um nome para entrar sem login.");
      return;
    }
    const user: LocalUser = {
      id: `guest:${typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`}`,
      name,
      provider: "local",
      loggedAt: new Date().toISOString(),
    };
    saveUser(user);
    setCurrentUser(user);
    syncCloudUser(user, identity).catch(() => undefined);
  }

  async function loginWithNodus(email: string, password: string) {
    setLoginError("");
    try {
      const session = await loginCoordinationAccount(email, password);
      const user: LocalUser = { id: session.user.id, name: session.user.name, email: session.user.email, provider: "local", loggedAt: new Date().toISOString() };
      saveUser(user);
      setCurrentUser(user);
    } catch (error) {
      setLoginError(error instanceof Error ? error.message : "Nao foi possivel entrar no servidor Nodus.");
    }
  }

  async function registerWithNodus(email: string, password: string, name: string) {
    setLoginError("");
    try {
      const session = await registerCoordinationAccount(email, password, name);
      const user: LocalUser = { id: session.user.id, name: session.user.name, email: session.user.email, provider: "local", loggedAt: new Date().toISOString() };
      saveUser(user);
      setCurrentUser(user);
    } catch (error) {
      setLoginError(error instanceof Error ? error.message : "Nao foi possivel criar a conta Nodus.");
    }
  }

  function logout() {
    clearUser();
    setCurrentUser(null);
  }

  function recordAccess(entry: Omit<AccessLogEntry, "id" | "at">) {
    const next = addAccessLog({ ...entry, userName: currentUser?.name, userEmail: currentUser?.email });
    setAccessLog(next);
    if (firebaseConfigured()) saveCloudAccessLog(next[0]).catch(() => undefined);
  }

  function parseIceServers(value: string): RTCIceServer[] {
    try {
      const parsed = JSON.parse(value) as RTCIceServer[];
      return Array.isArray(parsed) && parsed.length > 0 ? parsed : [{ urls: "stun:stun.l.google.com:19302" }];
    } catch {
      return [{ urls: "stun:stun.l.google.com:19302" }];
    }
  }

  function getEffectiveIceServers(): RTCIceServer[] {
    return serverIceServers.length > 0 ? serverIceServers : parseIceServers(settings.iceServersJson);
  }

  function logDiagnostic(message: string) {
    window.nodusDesktop?.writeDiagnostic(message).catch(() => undefined);
  }

  function logMediaDiagnostic(message: string) {
    if (import.meta.env.DEV) logDiagnostic(message);
  }

  function captureConstraints(value: LocalSettings, requestedResolution?: RemoteResolution, requestedFps?: RemoteFrameRate, source?: CaptureSource): MediaTrackConstraints {
    const frameRate = requestedFps ?? value.maxFps;
    const [width, height] = (requestedResolution ?? "1920x1080").split("x").map(Number);
    const limit = value.connectionQuality === "economy" ? [Math.min(width, 1280), Math.min(height, 720)] : [width, height];
    if (source?.width && source?.height) {
      limit[0] = Math.min(limit[0], source.width);
      limit[1] = Math.min(limit[1], source.height);
    }
    return { frameRate: { ideal: frameRate, max: frameRate }, width: { ideal: limit[0], max: limit[0] }, height: { ideal: limit[1], max: limit[1] } };
  }

  function prepareCaptureStream(source: MediaStream): PooledCapture {
    // Keep the Chromium capture track on the native WebRTC path; a canvas adds a full-frame copy and pacing queue.
    const track = source.getVideoTracks()[0];
    if (track) track.contentHint = "motion";
    return {
      stream: source,
      setReduced: () => false,
      stop: () => source.getTracks().forEach((track) => track.stop()),
    };
  }

  function acquireHostCapture(resolution: RemoteResolution, frameRate: RemoteFrameRate, displayId: string, shareAudio: boolean): Promise<CaptureLease> {
    const key = JSON.stringify([displayId, resolution, frameRate, shareAudio, settings.connectionQuality === "economy"]);
    return capturePoolRef.current.acquire(key, async () => {
      const rawRequest = captureQueueRef.current.then(async () => {
        const source = captureSources.find((item) => item.id === displayId) ?? captureSources[0];
        await window.nodusDesktop?.setCaptureOptions({ sourceId: displayId, displayId: source?.displayId, shareAudio });
        return navigator.mediaDevices.getDisplayMedia({
          video: captureConstraints(settings, resolution, frameRate, source),
          audio: shareAudio,
        });
      });
      captureQueueRef.current = rawRequest.then(() => undefined, () => undefined);
      const raw = await rawRequest;
      logDiagnostic(`capture-started video=${raw.getVideoTracks().length} audio=${raw.getAudioTracks().length}`);
      const capture = raw.getVideoTracks()[0]?.getSettings();
      logMediaDiagnostic(`capture-settings width=${capture?.width || 0} height=${capture?.height || 0} fps=${capture?.frameRate || 0}`);
      return prepareCaptureStream(raw);
    });
  }

  function applyRequestedResolution(sender: RTCRtpSender, resolution: RemoteResolution) {
    try {
      const [targetWidth, targetHeight] = resolution.split("x").map(Number);
      const source = sender.track?.getSettings();
      const scale = Math.max(1, (source?.width ?? targetWidth) / targetWidth, (source?.height ?? targetHeight) / targetHeight);
      const parameters = sender.getParameters();
      if (!parameters.encodings.length) parameters.encodings = [{}];
      parameters.encodings[0].scaleResolutionDownBy = scale;
      sender.setParameters(parameters).catch(() => undefined);
    } catch {}
  }

  async function switchHostCapture(sessionId: string, requestedResolution?: RemoteResolution, requestedDisplayId?: string, requestedFps?: RemoteFrameRate) {
    const runtime = sessionsRef.current.find((item) => item.session.sessionId === sessionId);
    const peer = peersRef.current.get(sessionId);
    if (!runtime?.shareStream || !peer) return;
    const resolution = requestedResolution ?? requestedResolutionsRef.current.get(sessionId) ?? settings.preferredResolution;
    requestedResolutionsRef.current.set(sessionId, resolution);
    const frameRate = requestedFps ?? requestedFpsRef.current.get(sessionId) ?? settings.maxFps;
    requestedFpsRef.current.set(sessionId, frameRate);
    const displayId = requestedDisplayId || settings.preferredDisplayId;
    const captureLease = await acquireHostCapture(resolution, frameRate, displayId, runtime.session.permissions.includes("audio:remote"));
    const stream = captureLease.stream;
    const track = stream.getVideoTracks()[0];
    const sender = peer.getSenders().find((item) => item.track?.kind === "video");
    if (!track || !sender) {
      captureLease.release();
      return;
    }
    track.contentHint = settings.connectionQuality === "economy" ? "detail" : "motion";
    const capture = track.getSettings();
    logMediaDiagnostic(`capture-switched width=${capture.width || 0} height=${capture.height || 0} fps=${capture.frameRate || 0}`);
    try {
      await sender.replaceTrack(track);
      const audioTrack = stream.getAudioTracks()[0];
      const audioSender = peer.getSenders().find((item) => item.track?.kind === "audio");
      if (audioTrack && audioSender) await audioSender.replaceTrack(audioTrack);
      tuneVideoSender(sender, frameRate);
      applyRequestedResolution(sender, resolution);
      qualityTierRef.current.delete(sessionId);
      adaptiveStateRef.current.delete(sessionId);
      const previousCleanup = captureCleanupRef.current.get(sessionId);
      captureCleanupRef.current.set(sessionId, captureLease.release);
      updateRuntime(sessionId, { shareStream: stream });
      previousCleanup?.();
    } catch (error) {
      captureLease.release();
      throw error;
    }
  }

  async function hashPassword(value: string): Promise<string> {
    if (!value) return "";
    const bytes = new TextEncoder().encode(value);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  function notifyIncomingRequest(request: SessionRequestRecord) {
    if (!("Notification" in window)) return;
    const show = () => new Notification("Nodus Connect", { body: `${request.requesterName} quer acessar este computador.` });
    if (Notification.permission === "granted") show();
    else if (Notification.permission !== "denied") Notification.requestPermission().then((permission) => permission === "granted" && show());
  }

  function playRequestTone() {
    try {
      const context = new AudioContext();
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.frequency.value = 880;
      gain.gain.value = 0.035;
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.start();
      oscillator.stop(context.currentTime + 0.16);
    } catch {}
  }

  function sendRemoteInput(message: RemoteInputMessage) {
    sendRemoteInputToSession(activeSession?.sessionId, message);
  }

  function sendRemoteInputToSession(sessionId: string | null | undefined, message: RemoteInputMessage) {
    const channel = sessionId ? controlChannelsRef.current.get(sessionId) : null;
    if (!channel || channel.readyState !== "open") return;
    channel.send(JSON.stringify(message));
  }

  async function sendClipboardToSession(sessionId = selectedSessionId) {
    const session = sessionsRef.current.find((item) => item.session.sessionId === sessionId)?.session;
    if (!sessionId || !settings.allowClipboard || !session?.permissions.includes("clipboard:sync")) return;
    const text = await window.nodusDesktop?.readClipboard().catch(() => "");
    if (!text) {
      updateRuntime(sessionId, { error: "Nao ha texto copiado para enviar." });
      return;
    }
    sendRemoteInputToSession(sessionId, { type: "clipboard", text });
    updateRuntime(sessionId, { error: "Texto copiado enviado." });
    window.setTimeout(() => updateRuntime(sessionId, { error: "" }), 1800);
  }

  function toggleRemoteAudio(sessionId: string) {
    const muted = !remoteAudioMuted[sessionId];
    const runtime = sessionsRef.current.find((item) => item.session.sessionId === sessionId);
    runtime?.remoteStream?.getAudioTracks().forEach((track) => { track.enabled = !muted; });
    setRemoteAudioMuted((current) => ({ ...current, [sessionId]: muted }));
  }

  function requestAdministrator(sessionId: string) {
    sendRemoteInputToSession(sessionId, { type: "admin-request" });
    updateRuntime(sessionId, { error: "Pedido enviado. O proprietário precisa aprovar localmente no Windows." });
  }

  async function resolveAdministratorRequest(sessionId: string, approved: boolean) {
    setAdminRequests((current) => {
      const { [sessionId]: _removed, ...next } = current;
      return next;
    });
    const channel = controlChannelsRef.current.get(sessionId);
    if (!approved) {
      channel?.readyState === "open" && channel.send(JSON.stringify({ type: "admin-status", status: "denied" } satisfies RemoteInputMessage));
      return;
    }
    const result = await window.nodusDesktop?.installService();
    const status = result?.ok ? "approved" : "unavailable";
    if (channel?.readyState === "open") channel.send(JSON.stringify({ type: "admin-status", status } satisfies RemoteInputMessage));
    updateRuntime(sessionId, { error: result?.ok ? "Serviço do Windows autorizado localmente." : result?.error || "Não foi possível concluir a autorização no Windows." });
  }

  function toggleRecording(sessionId = selectedSessionId) {
    if (!sessionId) return;
    const active = recordingRef.current.get(sessionId);
    if (active) {
      if (active.recorder.state !== "inactive") active.recorder.stop();
      return;
    }
    const stream = sessionsRef.current.find((item) => item.session.sessionId === sessionId)?.remoteStream;
    if (!stream || typeof MediaRecorder === "undefined") {
      updateRuntime(sessionId, { error: "A gravacao ainda nao esta pronta." });
      return;
    }
    const mimeType = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"].find((type) => MediaRecorder.isTypeSupported(type));
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    const entry = { recorder, chunks: [] as BlobPart[] };
    recordingRef.current.set(sessionId, entry);
    recorder.ondataavailable = (event) => event.data.size && entry.chunks.push(event.data);
    recorder.onstop = () => {
      recordingRef.current.delete(sessionId);
      setRecordingSessionId((current) => current === sessionId ? null : current);
      if (!entry.chunks.length) return;
      const url = URL.createObjectURL(new Blob(entry.chunks, { type: recorder.mimeType || "video/webm" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = `Nodus-${new Date().toISOString().replace(/[:.]/g, "-")}.webm`;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
    };
    recorder.start(1000);
    setRecordingSessionId(sessionId);
  }

  function sendPointerMove(event: ReactMouseEvent<HTMLElement>) {
    if (!activeSession || activeSession.role !== "viewer") return;
    const now = performance.now();
    if (now - lastControlMoveRef.current < 8) return;
    lastControlMoveRef.current = now;
    sendRemoteInput({ type: "mouseMove", ...remotePoint(event.currentTarget, event.nativeEvent) });
  }

  function sendPointerButton(type: "mouseDown" | "mouseUp", event: ReactMouseEvent<HTMLElement>) {
    if (!activeSession || activeSession.role !== "viewer") return;
    event.preventDefault();
    sendRemoteInput({ type: "mouseMove", ...remotePoint(event.currentTarget, event.nativeEvent) });
    sendRemoteInput({ type, button: event.button });
  }

  function sendWheel(event: ReactWheelEvent<HTMLElement>) {
    if (!activeSession || activeSession.role !== "viewer") return;
    event.preventDefault();
    sendRemoteInput({ type: "wheel", delta: -event.deltaY });
  }

  function sendKey(type: "keyDown" | "keyUp", event: ReactKeyboardEvent<HTMLElement>) {
    if (!activeSession || activeSession.role !== "viewer") return;
    if (!event.keyCode) return;
    event.preventDefault();
    sendRemoteInput({ type, keyCode: event.keyCode });
  }

  if (!identity.deviceNameConfirmed) {
    return (
      <main className="onboarding">
        <div className="brand-mark">
          <span>N</span>
        </div>
        <form className="onboarding-panel" onSubmit={completeOnboarding}>
          <p className="eyebrow">Nodus Connect</p>
          <h1>Bem-vindo ao Nodus Connect.</h1>
          <p>Conecte seus dispositivos de qualquer lugar com seguranca e consentimento claro.</p>
          <label>
            Nome deste dispositivo
            <input value={deviceName} onChange={(event) => setDeviceName(event.target.value)} />
          </label>
          <button type="submit">Comecar</button>
        </form>
      </main>
    );
  }

  if (!currentUser) {
    return (
      <AccessGate
        error={loginError}
        identity={identity}
        onGoogle={loginWithGoogle}
        googleReady={nativeGoogleClient}
        onLocal={loginLocal}
        onNodus={loginWithNodus}
        onNodusRegister={registerWithNodus}
      />
    );
  }

  return (
    <div className={`${settings.lightweightMode ? "apex-app simple-mode" : "apex-app"}${activeSession ? " remote-mode" : ""}`}>
      {!settings.lightweightMode && <div className="page-noise" />}
      <aside className="app-sidebar">
        <div className="sidebar-brand">
          <div className="product logo">
            <div className="product-icon">
              <span>N</span>
            </div>
            <div>
              <strong>NODUS</strong>
              <small>Connect</small>
            </div>
          </div>
        </div>
        <nav className="side-nav" aria-label="Navegação principal">
            {navItems.map((item) => (
              <button className={activeView === item.view ? "active" : ""} key={item.view} onClick={() => setActiveView(item.view)} type="button">
                <item.icon aria-hidden="true" size={18} strokeWidth={1.8} />
                {item.label}
              </button>
            ))}
        </nav>
        <div className="sidebar-status">
          <span className="sidebar-kicker">Conexão real.<br />Sem limites.</span>
          <div className="sidebar-footer-row">
            <span>v{appVersion}</span>
          </div>
        </div>
      </aside>
      <div className="app-workspace">
        <header className="workspace-header">
          <div>
            <h1>{activeSession ? `Acessando ${activeSession.remoteName}` : activeView === "connection" ? `${pageTitle}, ${currentUser.name.split(" ")[0]}.` : pageTitle}</h1>
            {!activeSession && <p className="workspace-subtitle">{pageSubtitle}</p>}
          </div>
          <div className="workspace-actions">
          <button className="icon-button" title="Notificacoes" type="button"><Bell aria-hidden="true" size={18} /></button>
          <button className="user-chip" onClick={logout} title="Sair" type="button">
            {currentUser.picture ? <img alt="" src={currentUser.picture} /> : <span>{currentUser.name.slice(0, 1)}</span>}
            <span className="user-meta"><b>{currentUser.name}</b><small><i /> Online</small></span>
          </button>
          </div>
        </header>
        <main className={activeSession ? "desktop-main session-main" : `desktop-main ${activeView}-main`}>
          {incomingRequests[0] && (
            <IncomingRequest request={incomingRequests[0]} onAccept={acceptIncoming} onDeny={denyIncoming} />
          )}
        {activeSession ? (
          <>
            <RemoteSessionPanel
              session={activeSession}
              remoteVideoRef={remoteVideoRef}
              controlReady={controlReady}
              hasRemoteStream={Boolean(remoteStream)}
              error={sessionError}
              fileReady={activeFileReady}
              metrics={activeRuntime?.metrics ?? emptyMetrics()}
              recording={recordingSessionId === activeSession.sessionId}
              transfers={fileTransfers.filter((item) => item.sessionId === activeSession.sessionId)}
              remoteResolution={activeSession.role === "viewer" ? settings.preferredResolution : sessionResolutions[activeSession.sessionId] ?? settings.preferredResolution}
              remoteDisplays={remoteDisplays[activeSession.sessionId] ?? []}
              remoteAudioMuted={Boolean(remoteAudioMuted[activeSession.sessionId])}
              adminRequest={adminRequests[activeSession.sessionId]}
              connectionQuality={settings.connectionQuality}
              maxFps={settings.maxFps}
              runtimes={sessionRuntimes}
              connectingNodusId={outgoingRequest?.targetNodusId}
              onResolutionChange={(resolution) => updateSettings({ preferredResolution: resolution })}
              onQualityChange={(connectionQuality) => updateSettings({ connectionQuality })}
              onFpsChange={(maxFps) => updateSettings({ maxFps })}
              onConnectNodusId={connectToDevice}
              onSelectSession={setSelectedSessionId}
              onDisplayChange={(displayId) => sendRemoteInputToSession(activeSession.sessionId, { type: "display", displayId })}
              onDisconnect={() => disconnectSession(activeSession.sessionId)}
              onClipboard={() => sendClipboardToSession(activeSession.sessionId)}
              onRecord={() => toggleRecording(activeSession.sessionId)}
              onSendFile={sendFile}
              onToggleRemoteAudio={() => toggleRemoteAudio(activeSession.sessionId)}
              onRequestAdmin={() => requestAdministrator(activeSession.sessionId)}
              onResolveAdmin={(approved) => resolveAdministratorRequest(activeSession.sessionId, approved)}
              onKeyInput={sendKey}
              onPointerButton={sendPointerButton}
              onPointerMove={sendPointerMove}
              onWheelInput={sendWheel}
            />
          </>
        ) : (
          <>
            {activeView === "connection" && <ConnectionHome
              feedback={feedback}
              favorites={favorites}
              identity={identity}
              items={recents}
              nodusIdLabel={visibleNodusId}
              onConnect={connectToDevice}
              onCopy={copyNodusId}
              onDeleteDevice={onDeleteDevice}
              onRenameDevice={onRenameDevice}
              onOpenDevices={() => setActiveView("devices")}
              onOpenSettings={() => { setSettingsSection("general"); setActiveView("settings"); }}
              onOpenConnectionSettings={() => { setSettingsSection("connection"); setActiveView("settings"); }}
              onOpenPasswordSettings={() => { setSettingsSection("access"); setActiveView("settings"); }}
              onOpenSupport={openSupport}
              onSubmit={connect}
              onTargetChange={updateTargetId}
              onTargetPasswordChange={setTargetPassword}
              onRememberTargetPasswordChange={setRememberTargetPassword}
              onToggleFavorite={onToggleFavorite}
              outgoingRequest={outgoingRequest}
              recentDevices={recents.slice(0, 3)}
              serviceState={serviceState}
              statusLabel={statusLabel}
              targetId={targetId}
              targetPassword={targetPassword}
              rememberTargetPassword={rememberTargetPassword}
            />}
            {activeView === "devices" && <Devices identity={identity} items={recents} favorites={favorites} nodusIdLabel={visibleNodusId} onAddDevice={() => setFeedback("Digite o Nodus ID no campo acima para adicionar um dispositivo.")} onConnect={connectToDevice} onDeleteDevice={onDeleteDevice} onRenameDevice={onRenameDevice} onToggleFavorite={onToggleFavorite} statusLabel={statusLabel} />}
            {activeView === "favorites" && <FavoritesPage favorites={favorites} items={recents.filter((item) => favorites.includes(item.nodusId))} onConnect={connectToDevice} onDeleteDevice={onDeleteDevice} onRenameDevice={onRenameDevice} onOpenDevices={() => setActiveView("devices")} onToggleFavorite={onToggleFavorite} />}
            {activeView === "recents" && <DeviceList empty="Nenhum dispositivo recente." favorites={favorites} items={recents} folders={folders} onCreateFolder={(name) => setFolders(createFolder(name))} onMove={setRecents} onRename={setRecents} onUpdate={setRecents} onWake={wakeDevice} onToggleFavorite={onToggleFavorite} />}
            {activeView === "files" && <FileTransferPanel activeSession={activeSession} channelReady={activeFileReady} transfers={fileTransfers} onSendFile={sendFile} />}
            {activeView === "settings" && <Settings
              appVersion={appVersion}
              captureSources={captureSources}
              initialSection={settingsSection}
              serviceStatus={windowsServiceStatus}
              onInstallService={() => changeWindowsService("install")}
              onUninstallService={() => changeWindowsService("uninstall")}
              onStartService={() => setWindowsServiceRunning(true)}
              onStopService={() => setWindowsServiceRunning(false)}
              settings={settings}
              updateSettings={updateSettings}
            />}
          </>
        )}
      </main>
      {!activeSession && <footer className="workspace-footer"><div><span className="footer-online" /> Nodus conectado</div><div><LockKeyhole aria-hidden="true" size={15} /> Conexão criptografada</div></footer>}
      {confirmDisconnectId && (
        <ConfirmDialog
          remoteName={sessionsRef.current.find((item) => item.session.sessionId === confirmDisconnectId)?.session.remoteName ?? "este acesso"}
          onCancel={() => setConfirmDisconnectId(null)}
          onConfirm={() => disconnectSession(confirmDisconnectId, true)}
        />
      )}
      {standby && <StandbyScreen />}
      </div>
    </div>
  );
}

function StandbyScreen() {
  return (
    <div className="standby-screen" role="status" aria-label="Aguardando conexao">
      <section className="standby-console">
        <div className="standby-symbol" aria-hidden="true">
          <i />
          <i />
          <b />
          <span>N</span>
        </div>
        <div className="standby-copy">
          <small>Canal Nodus pronto</small>
          <strong>Aguardando conexao</strong>
          <span>Pronto para receber acesso seguro.</span>
        </div>
        <div className="standby-status"><i /> Conexao segura disponivel</div>
      </section>
    </div>
  );
}

function ConfirmDialog({
  onCancel,
  onConfirm,
  remoteName,
}: {
  onCancel: () => void;
  onConfirm: () => void;
  remoteName: string;
}) {
  return (
    <div className="confirm-backdrop" role="presentation">
      <section className="confirm-modal" role="dialog" aria-modal="true" aria-label="Encerrar acesso remoto">
        <p className="eyebrow">Encerrar acesso</p>
        <h2>Desconectar de {remoteName}?</h2>
        <p className="note">A tela e o controle remoto serao encerrados neste computador.</p>
        <div className="confirm-actions">
          <button className="secondary-button" onClick={onCancel} type="button">Cancelar</button>
          <button className="danger-button" onClick={onConfirm} type="button">Desconectar</button>
        </div>
      </section>
    </div>
  );
}

function remoteWindowMarkup(session: RemoteSession) {
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Nodus Connect</title><style>
    *{box-sizing:border-box}body{margin:0;height:100vh;display:grid;grid-template-rows:80px minmax(0,1fr) 34px;overflow:hidden;background:#050811;color:#f4f8ff;font-family:Segoe UI,system-ui,sans-serif}
    body:before{content:"";position:fixed;inset:0;background:linear-gradient(rgba(72,142,215,.08) 1px,transparent 1px),linear-gradient(90deg,rgba(72,142,215,.08) 1px,transparent 1px),radial-gradient(circle at 78% 30%,rgba(19,140,255,.22),transparent 34%);background-size:56px 56px,56px 56px,auto;pointer-events:none}
    header,footer{position:relative;z-index:1;display:flex;align-items:center;justify-content:space-between;gap:16px;padding:12px 24px;border-color:rgba(110,197,255,.2);background:rgba(5,8,17,.94);backdrop-filter:blur(18px)}
    header{border-bottom:1px solid rgba(110,197,255,.2)}footer{border-top:1px solid rgba(110,197,255,.16);color:#9aa9bc;font-size:13px}
    small{display:block;color:#6ec5ff;text-transform:uppercase;letter-spacing:.14em;font-weight:800;font-size:11px}strong{font-size:18px}.actions{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:8px}button{border:1px solid rgba(81,169,255,.34);border-radius:8px;background:#0a1a2d;color:#fff;font-weight:800;padding:10px 14px;cursor:pointer}button[data-disconnect]{border-color:rgba(255,119,142,.38);background:linear-gradient(135deg,#5e1726,#d94463)}
    .brand{display:flex;align-items:center;gap:12px}.mark{display:grid;place-items:center;width:46px;height:46px;border:1px solid #37c6ff;border-radius:9px;background:linear-gradient(145deg,#1aafff,#0768c9);font-size:25px;font-weight:900}.brand small{color:#dff5ff;font-size:15px;letter-spacing:.08em}.brand small span{display:block;color:#26baff;font-size:12px;letter-spacing:0}.peer{flex:1}.peer b{display:block;font-size:16px}.peer span{color:#9ec9e8;font-size:12px}.workspace{display:grid;grid-template-columns:minmax(0,1fr) 342px;min-height:0;gap:12px;padding:9px 12px 12px}.remote-screen{position:relative;z-index:1;display:grid;place-items:center;min-width:0;min-height:0;outline:none;border:1px solid rgba(48,152,226,.36);border-radius:9px;background:#02050b;cursor:crosshair}.side{padding:18px;border:1px solid rgba(48,152,226,.36);border-radius:10px;background:linear-gradient(145deg,rgba(6,26,46,.95),rgba(2,13,24,.95))}.side h3{margin:0 0 17px;font-size:16px}.quality{padding:0 0 14px;border-bottom:1px solid rgba(65,161,226,.17);color:#20dba0;font-weight:800}.quality span{display:block;margin-top:5px;color:#a6c7df;font-size:12px;font-weight:400}.metrics{display:grid;gap:0;margin:12px 0}.metrics div{display:flex;justify-content:space-between;padding:6px 0;color:#9fc4e2;font-size:12px}.metrics b{color:#d7edff;font-weight:600}.filebox{margin-top:16px;padding-top:14px;border-top:1px solid rgba(65,161,226,.17);color:#9fc4e2;font-size:12px}.filebox strong{display:block;margin-bottom:5px;color:#e6f5ff;font-size:13px}
    video{width:100%;height:100%;object-fit:contain}.waiting{position:absolute;color:#9aa9bc;font-weight:800}body[data-ready="true"] .waiting{display:none}
    @media (max-width:760px){body{grid-template-rows:auto minmax(280px,1fr) auto}header,footer{align-items:flex-start;flex-direction:column}.actions{justify-content:flex-start}button{padding:9px 11px}}
  </style></head><body data-ready="false"><header><div class="brand"><div class="mark">N</div><small>NODUS <span>Connect</span></small></div><div class="peer"><b>${escapeMarkup(session.remoteName)}</b><span>Acesso remoto em andamento</span></div><div class="actions"><button data-clipboard>Area de transf.</button><button data-record>Gravar</button><button data-disconnect>Encerrar sessao</button></div></header><main class="workspace"><div class="remote-screen" tabindex="0"><video autoplay playsinline></video><p class="waiting">Aguardando imagem do outro computador...</p></div><aside class="side"><h3>Status da conexao</h3><div class="quality">Conectado<span data-control>Aguardando controle</span></div><div class="metrics"><div><span>Status</span><b data-status>${escapeMarkup(session.status)}</b></div><div><span>Rota</span><b>Verificando</b></div><div><span>Qualidade</span><b>Adaptativa</b></div><div><span>Seguranca</span><b>Criptografada</b></div></div><div class="filebox"><strong>Transferencia de arquivos</strong>Use o painel principal para enviar arquivos nesta sessao.</div></aside></main><footer><span>Clique na tela para controlar mouse e teclado.</span><span>Conexao criptografada</span></footer></body></html>`;
}

function pendingRemoteWindowMarkup(targetLabel: string) {
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Nodus Connect - Conectando</title><style>
    *{box-sizing:border-box}body{margin:0;height:100vh;display:grid;place-items:center;overflow:hidden;background:#030812;color:#f4f8ff;font-family:Segoe UI,system-ui,sans-serif}
    body:before,body:after{content:"";position:fixed;inset:0;pointer-events:none}body:before{background:linear-gradient(rgba(72,168,235,.07) 1px,transparent 1px),linear-gradient(90deg,rgba(72,168,235,.07) 1px,transparent 1px);background-size:56px 56px;mask-image:linear-gradient(90deg,transparent,#000 24%,#000 76%,transparent)}body:after{background:radial-gradient(circle at 50% 46%,rgba(15,165,255,.28),transparent 28%);animation:ambient 3.6s ease-in-out infinite alternate}
    main{position:relative;z-index:1;display:grid;place-items:center;padding:28px}.console{position:relative;display:grid;justify-items:center;gap:13px;width:min(420px,calc(100vw - 44px));padding:38px 34px 30px;overflow:hidden;border:1px solid rgba(61,173,245,.36);border-radius:14px;background:linear-gradient(145deg,rgba(6,27,48,.9),rgba(2,12,24,.94));box-shadow:0 30px 80px rgba(0,0,0,.4),inset 0 1px rgba(222,244,255,.08);text-align:center;animation:enter .36s ease-out both}.console:before{position:absolute;top:0;width:68%;height:1px;background:linear-gradient(90deg,transparent,#31c8ff,transparent);box-shadow:0 0 16px rgba(47,194,255,.7);content:""}
    .signal{position:relative;display:grid;width:126px;height:126px;place-items:center;border-radius:50%;animation:pulse 2.2s ease-in-out infinite}.signal i,.signal b{position:absolute;inset:0;border:1px solid rgba(110,197,255,.35);border-radius:50%}.signal i:first-child{animation:ring 2.4s ease-out infinite}.signal i:nth-child(2){animation:ring 2.4s ease-out .8s infinite}.signal b{inset:21px;display:grid;place-items:center;background:linear-gradient(145deg,rgba(8,20,38,.96),rgba(5,10,20,.98));box-shadow:0 0 0 10px rgba(19,140,255,.08),0 0 46px rgba(19,140,255,.34);color:#6ec5ff;font-size:38px}.signal:after{position:absolute;right:13px;bottom:28px;width:44px;height:2px;border-radius:99px;background:#2bd0ff;box-shadow:0 0 14px #2bd0ff;content:"";animation:scan 1.4s ease-in-out infinite alternate}
    small{color:#6ec5ff;text-transform:uppercase;font-weight:900;font-size:11px;letter-spacing:.14em}strong{font-size:24px}span{color:#a7c8e1;font-size:13px;font-weight:700}.secure{display:flex;align-items:center;gap:8px;margin-top:3px;color:#a9d6ee;font-size:12px}.secure i{width:8px;height:8px;border-radius:50%;background:#1ce69b;box-shadow:0 0 12px rgba(28,230,155,.9)}@keyframes enter{from{opacity:0;transform:translateY(10px) scale(.985)}to{opacity:1;transform:translateY(0) scale(1)}}@keyframes pulse{0%,100%{transform:scale(.96);opacity:.72}50%{transform:scale(1.04);opacity:1}}@keyframes ring{0%{transform:scale(.55);opacity:.9}100%{transform:scale(1.3);opacity:0}}@keyframes scan{from{opacity:.45;transform:scaleX(.55);transform-origin:right}to{opacity:1;transform:scaleX(1);transform-origin:right}}@keyframes ambient{from{opacity:.58;transform:scale(.94)}to{opacity:1;transform:scale(1.08)}}
  </style></head><body><main><section class="console"><div class="signal"><i></i><i></i><b>N</b></div><small>Canal Nodus pronto</small><strong data-remote>${escapeMarkup(targetLabel)}</strong><span data-status>Localizando dispositivo...</span><div class="secure"><i></i>Conexao segura disponivel</div></section></main></body></html>`;
}

function standbyPendingWindowMarkup(targetLabel: string) {
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Nodus Connect - Conectando</title><style>
    *{box-sizing:border-box}body{margin:0;height:100vh;display:grid;place-items:center;overflow:hidden;background:#030812;color:#f4f8ff;font-family:Segoe UI,system-ui,sans-serif}body:before,body:after{position:fixed;inset:0;content:"";pointer-events:none}body:before{background:linear-gradient(rgba(72,168,235,.07) 1px,transparent 1px),linear-gradient(90deg,rgba(72,168,235,.07) 1px,transparent 1px);background-size:56px 56px;mask-image:linear-gradient(90deg,transparent,#000 24%,#000 76%,transparent)}body:after{background:radial-gradient(circle at 50% 48%,rgba(14,165,255,.22),transparent 26%);animation:ambient 4s ease-in-out infinite alternate}main{position:relative;z-index:1;display:grid;place-items:center;padding:28px}.console{position:relative;display:grid;justify-items:center;gap:12px;width:min(420px,calc(100vw - 44px));padding:36px 34px 30px;overflow:hidden;border:1px solid rgba(61,173,245,.36);border-radius:14px;background:linear-gradient(145deg,rgba(6,27,48,.9),rgba(2,12,24,.94));box-shadow:0 30px 80px rgba(0,0,0,.4),inset 0 1px rgba(222,244,255,.08);text-align:center}.console:before{position:absolute;top:0;width:68%;height:1px;background:linear-gradient(90deg,transparent,#31c8ff,transparent);box-shadow:0 0 16px rgba(47,194,255,.7);content:""}.symbol{position:relative;display:grid;width:126px;height:126px;place-items:center;border-radius:50%;animation:pulse 2.2s ease-in-out infinite}.symbol i,.symbol b{position:absolute;inset:0;border:1px solid rgba(110,197,255,.35);border-radius:50%}.symbol i:first-child{animation:ring 2.4s ease-out infinite}.symbol i:nth-child(2){animation:ring 2.4s ease-out .8s infinite}.symbol b{inset:21px;display:grid;place-items:center;background:linear-gradient(145deg,rgba(8,20,38,.96),rgba(5,10,20,.98));box-shadow:0 0 0 10px rgba(19,140,255,.08),0 0 46px rgba(19,140,255,.34);color:#6ec5ff;font-size:38px}small{color:#6ec5ff;text-transform:uppercase;font-weight:900;font-size:11px;letter-spacing:.14em}strong{font-size:24px}.target,.status{color:#a7c8e1;font-size:13px;font-weight:700}.status{display:flex;align-items:center;gap:8px}.status i{width:8px;height:8px;border-radius:50%;background:#1ce69b;box-shadow:0 0 12px rgba(28,230,155,.9)}@keyframes pulse{0%,100%{transform:scale(.96);opacity:.72}50%{transform:scale(1.04);opacity:1}}@keyframes ring{0%{transform:scale(.55);opacity:.9}100%{transform:scale(1.3);opacity:0}}@keyframes ambient{from{opacity:.58;transform:scale(.94)}to{opacity:1;transform:scale(1.08)}}
  </style></head><body><main><section class="console"><div class="symbol"><i></i><i></i><b>N</b></div><small>Canal Nodus pronto</small><strong>Aguardando conexão</strong><span class="target" data-remote>${escapeMarkup(targetLabel)}</span><span class="status"><i></i><span data-status>Localizando dispositivo...</span></span></section></main></body></html>`;
}

function escapeMarkup(value: string) {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char);
}

function NetworkPulse() {
  return (
    <div className="network-pulse" aria-hidden="true">
      <i />
      <i />
      <i />
      <b />
      <strong>N</strong>
    </div>
  );
}

function ConnectionHome({
  feedback,
  favorites,
  identity,
  items,
  nodusIdLabel,
  onConnect,
  onCopy,
  onDeleteDevice,
  onRenameDevice,
  onOpenDevices,
  onOpenSettings,
  onOpenConnectionSettings,
  onOpenPasswordSettings,
  onOpenSupport,
  onSubmit,
  onTargetChange,
  onTargetPasswordChange,
  onRememberTargetPasswordChange,
  onToggleFavorite,
  outgoingRequest,
  recentDevices,
  serviceState,
  statusLabel,
  targetId,
  targetPassword,
  rememberTargetPassword,
}: {
  feedback: string;
  favorites: string[];
  identity: LocalIdentity;
  items: RecentDevice[];
  nodusIdLabel: string;
  onConnect: (nodusId: string) => void;
  onCopy: () => void;
  onDeleteDevice: (nodusId: string) => void;
  onRenameDevice: (nodusId: string, currentName: string) => void;
  onOpenDevices: () => void;
  onOpenSettings: () => void;
  onOpenConnectionSettings: () => void;
  onOpenPasswordSettings: () => void;
  onOpenSupport: () => void;
  onSubmit: (event: FormEvent) => void;
  onTargetChange: (value: string) => void;
  onTargetPasswordChange: (value: string) => void;
  onRememberTargetPasswordChange: (value: boolean) => void;
  onToggleFavorite: (nodusId: string) => void;
  outgoingRequest: SessionRequestRecord | null;
  recentDevices: RecentDevice[];
  serviceState: ServiceState;
  statusLabel: string;
  targetId: string;
  targetPassword: string;
  rememberTargetPassword: boolean;
}) {
  return (
    <section className="connection-home">
      <div className="connection-overview">
        <section className="identity-card">
          <div className="panel-label"><span>Seu Nodus ID</span><button aria-label="Sobre o Nodus ID" className="help-icon" data-tooltip="O Nodus ID identifica este computador. Compartilhe-o apenas com pessoas de confiança para que elas possam solicitar acesso." type="button">?</button></div>
          <strong className="nodus-id-value">{formatNodusId(nodusIdLabel).slice(0, -3)}<em>{formatNodusId(nodusIdLabel).slice(-3)}</em></strong>
          <span><i /> Disponível para conexões</span>
          <button className="icon-button copy-id" onClick={onCopy} title="Copiar Nodus ID" type="button"><Copy aria-hidden="true" size={18} /></button>
        </section>
        <ConnectBox feedback={feedback} outgoingRequest={outgoingRequest} recentDevices={recentDevices} targetId={targetId} targetPassword={targetPassword} rememberTargetPassword={rememberTargetPassword} onSubmit={onSubmit} onTargetChange={onTargetChange} onTargetPasswordChange={onTargetPasswordChange} onRememberTargetPasswordChange={onRememberTargetPasswordChange} />
        <SystemStatusCard serviceState={serviceState} statusLabel={statusLabel} />
      </div>
      <div className="connection-content">
        <RecentDeviceList favorites={favorites} items={items.slice(0, 4)} onConnect={onConnect} onDeleteDevice={onDeleteDevice} onRenameDevice={onRenameDevice} onToggleFavorite={onToggleFavorite} onViewAll={onOpenDevices} />
        <section className="quick-access-panel">
          <h2>Acesso rápido</h2>
          <button onClick={onOpenPasswordSettings} type="button"><LockKeyhole aria-hidden="true" /><span>Configurar senha</span><ArrowRight aria-hidden="true" /></button>
          <button onClick={onOpenConnectionSettings} type="button"><Activity aria-hidden="true" /><span>Conexão</span><ArrowRight aria-hidden="true" /></button>
          <button onClick={onOpenSupport} type="button"><ShieldCheck aria-hidden="true" /><span>Ajuda e suporte</span><ArrowRight aria-hidden="true" /></button>
        </section>
      </div>
    </section>
  );
}

function RecentDeviceList({
  favorites,
  items,
  onConnect,
  onDeleteDevice,
  onRenameDevice,
  onToggleFavorite,
  onViewAll,
}: {
  favorites: string[];
  items: RecentDevice[];
  onConnect: (nodusId: string) => void;
  onDeleteDevice: (nodusId: string) => void;
  onRenameDevice: (nodusId: string, currentName: string) => void;
  onToggleFavorite: (nodusId: string) => void;
  onViewAll: () => void;
}) {
  return (
    <section className="recent-device-panel">
      <div className="section-heading"><h2>Dispositivos recentes</h2><button className="panel-action" onClick={onViewAll} type="button">Ver todos <ArrowRight aria-hidden="true" size={15} /></button></div>
      {items.length ? <div className="recent-device-list">{items.map((item, index) => <RecentDeviceRow favorite={favorites.includes(item.nodusId)} item={item} key={item.nodusId} onConnect={onConnect} onDeleteDevice={onDeleteDevice} onRenameDevice={onRenameDevice} onToggleFavorite={onToggleFavorite} tone={["blue", "red", "sunset", "forest"][index % 4] as DeviceTone} />)}</div> : <p className="note">Os computadores acessados aparecerão aqui para conexões mais rápidas.</p>}
    </section>
  );
}

type DeviceTone = "blue" | "red" | "sunset" | "forest";

function RecentDeviceRow({ favorite, item, onConnect, onDeleteDevice, onRenameDevice, onToggleFavorite, tone }: { favorite?: boolean; item: RecentDevice; onConnect: (nodusId: string) => void; onDeleteDevice: (nodusId: string) => void; onRenameDevice: (nodusId: string, currentName: string) => void; onToggleFavorite?: (nodusId: string) => void; tone: DeviceTone }) {
  const online = item.status === "online";
  const lastAccess = new Date(item.lastConnectionAt).toLocaleDateString(currentLocale());
  return (
    <article className="recent-device-row">
      <div className={`recent-device-art tone-${tone}`} aria-hidden="true" />
      <div className="recent-device-name"><strong>{item.alias || item.deviceName}</strong><small><Monitor aria-hidden="true" size={15} /> Windows</small></div>
      <div className={online ? "recent-device-status online" : "recent-device-status"}><span><i /> {online ? "Online" : "Offline"}</span><small><Clock3 aria-hidden="true" size={15} /> Último acesso: {lastAccess}</small></div>
      <button className="secondary-button recent-device-connect" onClick={() => onConnect(item.nodusId)} type="button">Conectar <ArrowRight aria-hidden="true" size={16} /></button>
      {onToggleFavorite && <button className={favorite ? "favorite-row active" : "favorite-row"} onClick={() => onToggleFavorite(item.nodusId)} title={favorite ? "Remover dos favoritos" : "Adicionar aos favoritos"} type="button"><Star aria-hidden="true" fill={favorite ? "currentColor" : "none"} size={18} /></button>}
      <DeviceMenu className="row-menu" name={item.alias || item.deviceName} onDelete={() => onDeleteDevice(item.nodusId)} onRename={(name) => onRenameDevice(item.nodusId, name)} />
    </article>
  );
}

function DeviceMenu({ className, name, onDelete, onRename }: { className: string; name: string; onDelete: () => void; onRename?: (name: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [draftName, setDraftName] = useState(name);
  return <details className={`${className} device-menu-control`}>
    <summary title="Mais ações"><MoreHorizontal aria-hidden="true" size={18} /></summary>
    <div className="device-menu-actions">
      {onRename && (editing ? <form onSubmit={(event) => { event.preventDefault(); onRename(draftName); setEditing(false); }}><input aria-label="Novo nome do dispositivo" autoFocus onChange={(event) => setDraftName(event.target.value)} value={draftName} /><button type="submit">Salvar</button></form> : <button onClick={() => setEditing(true)} type="button">Renomear</button>)}
      <button className="device-menu-delete" onClick={onDelete} type="button">Excluir dispositivo</button>
    </div>
  </details>;
}

function FavoritesPage({ favorites, items, onConnect, onDeleteDevice, onRenameDevice, onOpenDevices, onToggleFavorite }: { favorites: string[]; items: RecentDevice[]; onConnect: (nodusId: string) => void; onDeleteDevice: (nodusId: string) => void; onRenameDevice: (nodusId: string, currentName: string) => void; onOpenDevices: () => void; onToggleFavorite: (nodusId: string) => void }) {
  const [query, setQuery] = useState("");
  const visibleItems = items.filter((item) => `${item.alias ?? ""} ${item.deviceName} ${item.nodusId}`.toLocaleLowerCase(currentLocale()).includes(query.toLocaleLowerCase(currentLocale())));
  return (
    <section className="favorites-page">
      <div className="favorites-tools"><label><Search aria-hidden="true" size={19} /><input placeholder="Buscar nos favoritos..." value={query} onChange={(event) => setQuery(event.target.value)} /></label><span>{favorites.length} favorito{favorites.length === 1 ? "" : "s"}</span></div>
      {visibleItems.length ? <div className="favorites-list">{visibleItems.map((item, index) => <RecentDeviceRow favorite item={item} key={item.nodusId} onConnect={onConnect} onDeleteDevice={onDeleteDevice} onRenameDevice={onRenameDevice} onToggleFavorite={onToggleFavorite} tone={["blue", "red", "sunset", "forest"][index % 4] as DeviceTone} />)}</div> : <section className="favorites-empty"><Star aria-hidden="true" /><h2>Nenhum dispositivo favorito</h2><p>Adicione dispositivos aos favoritos para encontrá-los rapidamente aqui.</p><button className="secondary-button" onClick={onOpenDevices} type="button">Ver dispositivos <ArrowRight aria-hidden="true" size={16} /></button></section>}
    </section>
  );
}

function Devices({
  identity,
  items,
  favorites,
  nodusIdLabel,
  onAddDevice,
  onConnect,
  onDeleteDevice,
  onRenameDevice,
  onToggleFavorite,
  statusLabel,
}: {
  identity: LocalIdentity;
  items: RecentDevice[];
  favorites: string[];
  nodusIdLabel: string;
  onAddDevice: () => void;
  onConnect: (nodusId: string) => void;
  onDeleteDevice: (nodusId: string) => void;
  onRenameDevice: (nodusId: string, currentName: string) => void;
  onToggleFavorite: (nodusId: string) => void;
  statusLabel: string;
}) {
  const [filter, setFilter] = useState<"all" | "online" | "offline">("all");
  const [layout, setLayout] = useState<"grid" | "list">("grid");
  const onlineCount = items.filter((item) => item.status === "online").length + 1;
  const offlineCount = items.filter((item) => item.status !== "online").length;
  const visibleItems = items.filter((item) => filter === "all" || (filter === "online" ? item.status === "online" : item.status !== "online"));
  return (
    <section className="content-panel device-catalog">
      <div className="catalog-heading">
        <div className="catalog-title-row">
          <h2>Meus dispositivos</h2>
          <div className="device-filters" role="tablist" aria-label="Filtrar dispositivos">
            <button className={filter === "all" ? "active" : ""} onClick={() => setFilter("all")} role="tab" type="button">Todos ({items.length + 1})</button>
            <button className={filter === "online" ? "active" : ""} onClick={() => setFilter("online")} role="tab" type="button">Online ({onlineCount})</button>
            <button className={filter === "offline" ? "active" : ""} onClick={() => setFilter("offline")} role="tab" type="button">Offline ({offlineCount})</button>
          </div>
        </div>
        <div className="catalog-actions">
          <button className="add-device" onClick={onAddDevice} type="button"><Plus aria-hidden="true" size={16} /> Adicionar dispositivo</button>
          <button className={`view-toggle ${layout === "grid" ? "active" : ""}`} onClick={() => setLayout("grid")} title="Exibição em grade" type="button"><Grid2X2 aria-hidden="true" size={16} /></button>
          <button className={`view-toggle ${layout === "list" ? "active" : ""}`} onClick={() => setLayout("list")} title="Exibição em lista" type="button"><List aria-hidden="true" size={17} /></button>
        </div>
      </div>
      <div className={`device-cards ${layout === "list" ? "list-view" : ""}`}>
        <DeviceCard current identity={identity} nodusIdLabel={nodusIdLabel} onConnect={onConnect} statusLabel={statusLabel} tone="blue" />
        {visibleItems.map((item, index) => (
          <DeviceCard
            key={item.nodusId}
            favorite={favorites.includes(item.nodusId)}
            item={item}
            nodusIdLabel={formatNodusId(item.nodusId)}
            onConnect={onConnect}
            onDelete={() => onDeleteDevice(item.nodusId)}
            onRename={(name) => onRenameDevice(item.nodusId, name)}
            onToggleFavorite={onToggleFavorite}
            tone={["red", "sunset", "forest"][index % 3] as "red" | "sunset" | "forest"}
          />
        ))}
      </div>
      {items.length === 0 && <p className="note">Os computadores acessados aparecerao aqui para conexoes mais rapidas.</p>}
    </section>
  );
}

function DeviceCard({
  current = false,
  favorite = false,
  identity,
  item,
  nodusIdLabel,
  onConnect,
  onDelete,
  onRename,
  onToggleFavorite,
  statusLabel = "Online",
  tone = "blue",
}: {
  current?: boolean;
  favorite?: boolean;
  identity?: LocalIdentity;
  item?: RecentDevice;
  nodusIdLabel: string;
  onConnect: (nodusId: string) => void;
  onDelete?: () => void;
  onRename?: (name: string) => void;
  onToggleFavorite?: (nodusId: string) => void;
  statusLabel?: string;
  tone?: "blue" | "red" | "sunset" | "forest";
}) {
  const name = current ? identity?.deviceName ?? "Este computador" : item?.alias || item?.deviceName || "Dispositivo";
  const deviceInitial = name.trim().slice(0, 1).toLocaleUpperCase(currentLocale()) || "N";
  const online = current || item?.status === "online";
  const nodusId = item?.nodusId ?? "";
  const lastAccess = current ? "agora" : new Date(item?.lastConnectionAt ?? Date.now()).toLocaleDateString(currentLocale());
  return (
    <article className={`device-card ${current ? "current-device" : ""}`}>
      <div className={`device-card-art tone-${tone}`}>
        <span className="device-card-initial" aria-hidden="true">{deviceInitial}</span>
      </div>
      <span className={online ? "device-online" : "device-offline"}><i /> {online ? (current ? statusLabel : "Online") : "Offline"}</span>
      {!current && <button className={favorite ? "device-favorite active" : "device-favorite"} onClick={() => onToggleFavorite?.(nodusId)} title={favorite ? "Remover dos favoritos" : "Adicionar aos favoritos"} type="button"><Star aria-hidden="true" size={17} fill={favorite ? "currentColor" : "none"} /></button>}
      {!current && onDelete && <DeviceMenu className="device-menu" name={item?.alias || name} onDelete={onDelete} onRename={onRename} />}
      <strong>{name}</strong>
      <small>{nodusIdLabel}</small>
      <div className="device-card-meta"><span><Monitor aria-hidden="true" size={14} /> Windows</span><span><Clock3 aria-hidden="true" size={14} /> Último acesso: {lastAccess}</span></div>
      <button className={current ? "secondary-button device-access" : "device-access"} disabled={current} onClick={() => !current && onConnect(nodusId)} type="button">{current ? "Este computador" : "Acessar"}<ArrowRight aria-hidden="true" size={15} /></button>
    </article>
  );
}

function SystemStatusCard({ serviceState, statusLabel }: { serviceState: ServiceState; statusLabel: string }) {
  return <section className="system-status-card">
    <div className="section-heading"><h2>Status do Sistema</h2></div>
    <div className="system-check"><CheckCircle2 aria-hidden="true" size={16} /> Serviço Nodus <b>{statusLabel}</b></div>
    <div className="system-check"><LockKeyhole aria-hidden="true" size={16} /> Conexão protegida <b>{serviceState === "online" ? "Estável" : statusLabel}</b></div>
  </section>;
}

function ConnectBox({
  compact = false,
  feedback,
  onSubmit,
  onTargetChange,
  onTargetPasswordChange,
  onRememberTargetPasswordChange,
  outgoingRequest,
  recentDevices = [],
  targetId,
  targetPassword,
  rememberTargetPassword,
}: {
  compact?: boolean;
  feedback: string;
  onSubmit: (event: FormEvent) => void;
  onTargetChange: (value: string) => void;
  onTargetPasswordChange: (value: string) => void;
  onRememberTargetPasswordChange: (value: boolean) => void;
  outgoingRequest: SessionRequestRecord | null;
  recentDevices?: RecentDevice[];
  targetId: string;
  targetPassword: string;
  rememberTargetPassword: boolean;
}) {
  const handlePaste = (event: ReactClipboardEvent<HTMLInputElement>) => {
    const pastedId = event.clipboardData.getData("text");
    if (!pastedId) return;
    event.preventDefault();
    onTargetChange(formatNodusId(pastedId));
  };

  return (
    <form className={compact ? "connect-box session-connect" : "connect-box"} onSubmit={onSubmit}>
      <label>
        Conectar a outro dispositivo
        <input
          inputMode="numeric"
          placeholder="Digite o Nodus ID"
          value={targetId}
          disabled={Boolean(outgoingRequest)}
          onChange={(event) => onTargetChange(formatNodusId(event.target.value))}
          onPaste={handlePaste}
        />
      </label>
      <button disabled={Boolean(outgoingRequest)} type="submit">{outgoingRequest ? "Aguardando" : <><span>Conectar</span><ArrowRight aria-hidden="true" size={18} /></>}</button>
      <details className="connect-password">
        <summary>Usar senha de acesso</summary>
        <input autoComplete="current-password" disabled={Boolean(outgoingRequest)} onChange={(event) => onTargetPasswordChange(event.target.value)} placeholder="Senha definida no outro Nodus" type="password" value={targetPassword} />
        <label className="remember-password"><input checked={rememberTargetPassword} disabled={Boolean(outgoingRequest)} onChange={(event) => onRememberTargetPasswordChange(event.target.checked)} type="checkbox" /><span>Salvar senha neste dispositivo</span></label>
      </details>
      {!compact && recentDevices.length > 0 && <div className="recent-connects"><span>Recentes:</span>{recentDevices.map((device) => <button key={device.nodusId} onClick={() => onTargetChange(formatNodusId(device.nodusId))} type="button">{device.alias || device.deviceName}</button>)}<button className="recent-more" title="Mais dispositivos" type="button"><ChevronDown aria-hidden="true" size={16} /></button></div>}
      {outgoingRequest
        ? <p className="session-banner">Aguardando aceite de {formatNodusId(outgoingRequest.targetNodusId)}.</p>
        : feedback && <p className="feedback">{feedback}</p>}
    </form>
  );
}

function SessionTabs({
  onSelect,
  runtimes,
  selectedSessionId,
}: {
  onSelect: (sessionId: string) => void;
  runtimes: SessionRuntime[];
  selectedSessionId: string;
}) {
  return (
    <div className="session-tabs">
      {runtimes.map((item) => (
        <button
          className={item.session.sessionId === selectedSessionId ? "active" : ""}
          key={item.session.sessionId}
          onClick={() => onSelect(item.session.sessionId)}
          type="button"
        >
          <strong>{item.session.remoteName}</strong>
          <small>{item.session.role === "viewer" ? "Acessando" : "Compartilhando"} - {item.session.status}</small>
        </button>
      ))}
    </div>
  );
}

function AccessGate({
  error,
  googleReady,
  identity,
  onGoogle,
  onLocal,
  onNodus,
  onNodusRegister,
}: {
  error: string;
  googleReady: boolean;
  identity: LocalIdentity;
  onGoogle: () => void;
  onLocal: (name: string) => void;
  onNodus: (email: string, password: string) => void;
  onNodusRegister: (email: string, password: string, name: string) => void;
}) {
  const [authName, setAuthName] = useState(identity.deviceName);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [registering, setRegistering] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [remember, setRemember] = useState(true);
  const [notice, setNotice] = useState("");

  const selectMode = (nextRegistering: boolean) => {
    setRegistering(nextRegistering);
    setNotice("");
  };

  return (
    <main className="access-gate">
      <div className="page-noise" />
      <section className="access-card">
        <header className="account-heading">
          <h1>Bem-vindo ao Nodus.</h1>
          <p>Entre para sincronizar seus dispositivos e preferências.</p>
        </header>
        <div className="account-tabs" role="tablist" aria-label="Tipo de conta">
          <button className={!registering ? "active" : ""} onClick={() => selectMode(false)} type="button" role="tab" aria-selected={!registering}>Entrar</button>
          <button className={registering ? "active" : ""} onClick={() => selectMode(true)} type="button" role="tab" aria-selected={registering}>Criar conta</button>
        </div>
        <button className="account-google" data-available={googleReady} onClick={onGoogle} type="button" title={googleReady ? "Continuar com Google" : "O login Google requer o aplicativo instalado"}>
          <span aria-hidden="true">G</span>
          Continuar com o Google
        </button>
        <div className="account-divider" aria-hidden="true"><span />ou<span /></div>
        <form className="account-form" onSubmit={(event) => {
          event.preventDefault();
          if (registering) onNodusRegister(email, password, authName);
          else onNodus(email, password);
        }}>
          {registering && <label>Nome<div className="account-input"><input autoComplete="name" value={authName} onChange={(event) => setAuthName(event.target.value)} placeholder="Como devemos chamar você" /></div></label>}
          <label>E-mail<div className="account-input"><Mail aria-hidden="true" size={17} /><input autoComplete="email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="Digite seu e-mail" /></div></label>
          <label>Senha<div className="account-input"><LockKeyhole aria-hidden="true" size={17} /><input autoComplete={registering ? "new-password" : "current-password"} type={showPassword ? "text" : "password"} value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Digite sua senha" /><button className="password-toggle" onClick={() => setShowPassword((value) => !value)} type="button" aria-label={showPassword ? "Ocultar senha" : "Mostrar senha"}>{showPassword ? <EyeOff size={17} /> : <Eye size={17} />}</button></div></label>
          {!registering && <div className="account-options"><label className="remember-control"><input checked={remember} onChange={(event) => setRemember(event.target.checked)} type="checkbox" />Lembrar de mim</label><button className="forgot-password" onClick={() => setNotice("A recuperação por e-mail ainda não está disponível. Entre com Google ou crie uma nova conta.")} type="button">Esqueceu a senha?</button></div>}
          <button className="account-submit" disabled={!email || !password || (registering && !authName.trim())} type="submit">{registering ? "Criar conta Nodus" : "Entrar no Nodus"}<ArrowRight size={18} /></button>
        </form>
        <div className="account-separator" />
        <button className="guest-access" onClick={() => onLocal(identity.deviceName)} type="button">Continuar sem uma conta<ArrowRight size={17} /></button>
        <p className="account-security"><ShieldCheck size={17} />Seus dados estão protegidos com criptografia de ponta a ponta.</p>
        {(notice || error) && <p className="account-feedback">{notice || error}</p>}
      </section>
    </main>
  );
}

function AccessHistory({ entries, onViewAll }: { entries: AccessLogEntry[]; onViewAll: () => void }) {
  return (
    <section className="content-panel activity-panel">
      <div className="section-heading">
        <h2>Atividade recente</h2>
        <button className="panel-action" onClick={onViewAll} type="button">Ver tudo <ArrowRight aria-hidden="true" size={15} /></button>
      </div>
      {entries.length === 0 ? (
        <p className="note">Nenhum acesso registrado ainda.</p>
      ) : (
        <div className="activity-list">
          {entries.slice(0, 8).map((entry) => (
            <div className={`activity-item activity-${entry.result}`} key={entry.id}>
              <span className="activity-icon"><CheckCircle2 aria-hidden="true" size={15} /></span>
              <div>
                <strong>{entry.deviceName}</strong>
                <small>
                  {directionLabel(entry.direction)} - {resultLabel(entry.result)}
                </small>
              </div>
              <time>{new Date(entry.at).toLocaleTimeString(currentLocale(), { hour: "2-digit", minute: "2-digit" })}</time>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function DashboardPromo() {
  return <article className="dashboard-promo"><div><strong>"Controle a distância.</strong><span>Liberdade de perto."</span><small>NODUS</small></div></article>;
}

function DashboardHighlights({ onOpenFiles, onOpenRemote, onOpenSupport }: { onOpenFiles: () => void; onOpenRemote: () => void; onOpenSupport: () => void }) {
  return (
    <section className="dashboard-highlights">
        <article className="dashboard-tool-card">
          <span className="tool-icon"><FolderUp aria-hidden="true" size={26} /></span>
          <div><h3>Transferência de arquivos</h3><p>Envie e receba arquivos com segurança durante a sessão.</p><button onClick={onOpenFiles} type="button">Abrir gerenciador <ArrowRight aria-hidden="true" size={15} /></button></div>
        </article>
        <article className="dashboard-tool-card">
          <span className="tool-icon"><MonitorUp aria-hidden="true" size={26} /></span>
          <div><h3>Acesso remoto</h3><p>Controle dispositivos de forma rápida e estável, de onde estiver.</p><button onClick={onOpenRemote} type="button">Ver dispositivos <ArrowRight aria-hidden="true" size={15} /></button></div>
        </article>
        <article className="dashboard-tool-card">
          <span className="tool-icon"><ShieldCheck aria-hidden="true" size={26} /></span>
          <div><h3>Ajuda e suporte</h3><p>Gerencie segurança, permissões e preferências do Nodus.</p><button onClick={onOpenSupport} type="button">Central de ajuda <ArrowRight aria-hidden="true" size={15} /></button></div>
        </article>
      </section>
  );
}

function IncomingRequest({
  onAccept,
  onDeny,
  request,
}: {
  onAccept: (request: SessionRequestRecord) => Promise<string | null>;
  onDeny: (request: SessionRequestRecord) => void;
  request: SessionRequestRecord;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function handleAccept() {
    setBusy(true);
    setError("");
    const message = await onAccept(request);
    if (message) setError(message);
    setBusy(false);
  }
  return (
    <div className="request-backdrop">
      <section className="incoming-request-panel" role="dialog" aria-modal="true" aria-label="Pedido de acesso remoto">
        <div className="request-orbit" aria-hidden="true">
          <span>N</span>
        </div>
        <p className="eyebrow">Pedido de acesso remoto</p>
        <h2>{request.requesterName}</h2>
        <p className="note">Nodus ID {formatNodusId(request.requesterNodusId)} quer visualizar sua tela e controlar este computador com sua permissao.</p>
        <div className="request-permissions">
          {(request.requestedPermissions ?? ["screen:view"]).map((permission) => <span key={permission}>{permissionLabel(permission)}</span>)}
        </div>
        {error && <p className="feedback request-error">{error}</p>}
        <div className="request-actions">
          <button className="secondary-button" onClick={() => onDeny(request)} type="button">
            Recusar
          </button>
          <button disabled={busy} onClick={handleAccept} type="button">
            {busy ? "Preparando compartilhamento..." : "Aceitar e compartilhar tela"}
          </button>
        </div>
      </section>
    </div>
  );
}

function RemoteSessionPanel({
  connectionQuality,
  connectingNodusId,
  controlReady,
  error,
  fileReady,
  hasRemoteStream,
  onKeyInput,
  onClipboard,
  onDisconnect,
  onPointerButton,
  onPointerMove,
  onWheelInput,
  onRecord,
  onSendFile,
  metrics,
  maxFps,
  recording,
  remoteVideoRef,
  session,
  transfers,
  remoteResolution,
  remoteDisplays,
  remoteAudioMuted,
  runtimes,
  adminRequest,
  onResolutionChange,
  onQualityChange,
  onFpsChange,
  onConnectNodusId,
  onSelectSession,
  onDisplayChange,
  onToggleRemoteAudio,
  onRequestAdmin,
  onResolveAdmin,
}: {
  connectionQuality: LocalSettings["connectionQuality"];
  connectingNodusId?: string;
  controlReady: boolean;
  error: string;
  fileReady: boolean;
  metrics: SessionMetrics;
  maxFps: LocalSettings["maxFps"];
  recording: boolean;
  hasRemoteStream: boolean;
  onKeyInput: (type: "keyDown" | "keyUp", event: ReactKeyboardEvent<HTMLElement>) => void;
  onClipboard: () => void;
  onDisconnect: () => void;
  onPointerButton: (type: "mouseDown" | "mouseUp", event: ReactMouseEvent<HTMLElement>) => void;
  onPointerMove: (event: ReactMouseEvent<HTMLElement>) => void;
  onWheelInput: (event: ReactWheelEvent<HTMLElement>) => void;
  onRecord: () => void;
  onSendFile: (file: File) => void;
  remoteVideoRef: RefObject<HTMLVideoElement | null>;
  session: RemoteSession;
  transfers: FileTransferRecord[];
  remoteResolution: RemoteResolution;
  remoteDisplays: CaptureSource[];
  remoteAudioMuted: boolean;
  runtimes: SessionRuntime[];
  adminRequest?: string;
  onResolutionChange: (value: RemoteResolution) => void;
  onQualityChange: (value: LocalSettings["connectionQuality"]) => void;
  onFpsChange: (value: LocalSettings["maxFps"]) => void;
  onConnectNodusId: (value: string) => void;
  onSelectSession: (sessionId: string) => void;
  onDisplayChange: (value: string) => void;
  onToggleRemoteAudio: () => void;
  onRequestAdmin: () => void;
  onResolveAdmin: (approved: boolean) => void;
}) {
  const isViewer = session.role === "viewer";
  type SessionTool = "control" | "transfer" | "monitor" | "quality" | "actions" | "connection";
  const [activeTool, setActiveTool] = useState<SessionTool | null>(null);
  const [mouseControlEnabled, setMouseControlEnabled] = useState(true);
  const [keyboardControlEnabled, setKeyboardControlEnabled] = useState(true);
  const [nextNodusId, setNextNodusId] = useState("");
  const viewerSurfaceRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    setMouseControlEnabled(true);
    setKeyboardControlEnabled(true);
  }, [session.sessionId]);
  if (!isViewer) {
    return <HostSessionView
      adminRequest={adminRequest}
      error={error}
      metrics={metrics}
      onDisconnect={onDisconnect}
      onResolveAdmin={onResolveAdmin}
      session={session}
    />;
  }
  const toggleTool = (tool: SessionTool) => setActiveTool((current) => current === tool ? null : tool);
  const canControlMouse = controlReady && session.permissions.includes("mouse:control");
  const canControlKeyboard = controlReady && session.permissions.includes("keyboard:control");
  const viewerSessions = runtimes.filter((item) => item.session.role === "viewer");
  const enterFullscreen = () => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => undefined);
    else viewerSurfaceRef.current?.requestFullscreen().catch(() => undefined);
  };
  const toolbar: Array<{ id?: SessionTool; label: string; icon: LucideIcon; disabled?: boolean }> = [
    { id: "control", label: "Controle", icon: MonitorCog },
    { id: "transfer", label: "Transferência", icon: FolderUp },
    { id: "monitor", label: "Monitor", icon: Monitor },
    { id: "quality", label: "Qualidade", icon: Gauge },
    { id: "actions", label: "Ações", icon: Zap },
    { id: "connection", label: "Mais", icon: MoreHorizontal },
  ];
  return (
    <section className="remote-session viewer-session viewer-session-v2">
      <header className="viewer-topbar">
        <div className="viewer-session-switcher">
          <select aria-label="Computador ativo" onChange={(event) => onSelectSession(event.target.value)} value={session.sessionId}>
            {viewerSessions.map((item) => <option key={item.session.sessionId} value={item.session.sessionId}>{item.session.remoteName}</option>)}
          </select>
          <form onSubmit={(event) => { event.preventDefault(); if (!normalizeNodusId(nextNodusId)) return; onConnectNodusId(nextNodusId); setNextNodusId(""); }}>
            <input aria-label="Outro Nodus ID" disabled={Boolean(connectingNodusId)} inputMode="numeric" maxLength={11} onChange={(event) => setNextNodusId(formatNodusId(event.target.value))} placeholder={connectingNodusId ? "Aguardando aceite" : "Outro Nodus ID"} value={nextNodusId} />
            <button aria-label="Conectar a outro Nodus" disabled={Boolean(connectingNodusId) || !normalizeNodusId(nextNodusId)} title="Conectar a outro computador" type="submit"><Plus aria-hidden="true" size={17} /></button>
          </form>
        </div>
        <nav className="viewer-toolbar" aria-label="Ferramentas da sessão">
          {toolbar.map(({ id, label, icon: Icon, disabled }) => <button aria-pressed={id ? activeTool === id : undefined} className={id && activeTool === id ? "active" : ""} disabled={disabled} key={label} onClick={() => id && toggleTool(id)} title={disabled ? "Ainda não disponível nesta sessão" : label} type="button"><Icon aria-hidden="true" size={17} /><span>{label}</span></button>)}
        </nav>
        <div className="viewer-live-metrics">
          <button onClick={() => toggleTool("connection")} title="Métricas da conexão" type="button"><Activity aria-hidden="true" size={15} />{metrics.latencyMs ? `${metrics.latencyMs} ms` : "..."}</button>
          <button onClick={() => toggleTool("connection")} title="Quadros recebidos por segundo" type="button"><Gauge aria-hidden="true" size={15} />{metrics.fps ? `${metrics.fps} FPS` : "..."}</button>
          <button onClick={() => toggleTool("quality")} title="Resolução remota" type="button"><Monitor aria-hidden="true" size={15} />{remoteResolution.replace("x", " × ")}</button>
        </div>
        <button className="danger-button viewer-end-session" onClick={onDisconnect} type="button"><Power aria-hidden="true" size={16} /><span>Encerrar sessão</span></button>
      </header>
      <div className="viewer-session-body">
        <div className="remote-stage viewer-stage">
          <div
            className="video-shell control-surface remote-viewer-surface"
            onContextMenu={(event) => event.preventDefault()}
            onKeyDown={(event) => keyboardControlEnabled && canControlKeyboard && onKeyInput("keyDown", event)}
            onKeyUp={(event) => keyboardControlEnabled && canControlKeyboard && onKeyInput("keyUp", event)}
            onMouseDown={(event) => mouseControlEnabled && canControlMouse && onPointerButton("mouseDown", event)}
            onMouseMove={(event) => mouseControlEnabled && canControlMouse && onPointerMove(event)}
            onMouseUp={(event) => mouseControlEnabled && canControlMouse && onPointerButton("mouseUp", event)}
            onWheel={(event) => mouseControlEnabled && canControlMouse && onWheelInput(event)}
            ref={viewerSurfaceRef}
            tabIndex={0}
          >
            <video ref={remoteVideoRef} autoPlay playsInline />
            {!hasRemoteStream && <p>Aguardando imagem do outro computador...</p>}
          </div>
          {activeTool && <aside className="viewer-tool-popover">
            <div className="viewer-tool-title"><strong>{toolbar.find((item) => item.id === activeTool)?.label ?? "Conexão"}</strong><button aria-label="Fechar painel" onClick={() => setActiveTool(null)} type="button"><X aria-hidden="true" size={17} /></button></div>
            {activeTool === "control" && <div className="viewer-tool-actions control-options"><button className={mouseControlEnabled && canControlMouse ? "active" : ""} disabled={!canControlMouse} onClick={() => setMouseControlEnabled((value) => !value)} type="button"><MousePointer2 aria-hidden="true" size={18} /><span>Mouse {mouseControlEnabled ? "ativo" : "bloqueado"}</span></button><button className={keyboardControlEnabled && canControlKeyboard ? "active" : ""} disabled={!canControlKeyboard} onClick={() => setKeyboardControlEnabled((value) => !value)} type="button"><Keyboard aria-hidden="true" size={18} /><span>Teclado {keyboardControlEnabled ? "ativo" : "bloqueado"}</span></button><button onClick={onToggleRemoteAudio} type="button">{remoteAudioMuted ? <VolumeX aria-hidden="true" size={18} /> : <Volume2 aria-hidden="true" size={18} />}<span>{remoteAudioMuted ? "Ativar áudio" : "Silenciar áudio"}</span></button><button onClick={onClipboard} type="button"><Clipboard aria-hidden="true" size={18} /><span>Enviar texto copiado</span></button><button onClick={onRequestAdmin} type="button"><ShieldCheck aria-hidden="true" size={18} /><span>Solicitar administrador</span></button><button onClick={() => { setMouseControlEnabled(false); setKeyboardControlEnabled(false); }} type="button"><LockKeyhole aria-hidden="true" size={18} /><span>Somente visualizar</span></button><span className="viewer-control-state"><i className={controlReady ? "online" : ""} />{controlReady ? "Canal de controle conectado" : "Preparando controles"}</span></div>}
            {activeTool === "transfer" && <div className="viewer-transfer-panel"><div className="viewer-transfer-destination"><FolderOpen aria-hidden="true" size={16} /><span><strong>Destino</strong>Documentos no computador remoto</span></div><label className={fileReady ? "session-upload" : "session-upload disabled"}><FileUp aria-hidden="true" size={18} />Enviar arquivo<input disabled={!fileReady} type="file" onChange={(event) => { const file = event.currentTarget.files?.[0]; if (file) onSendFile(file); event.currentTarget.value = ""; }} /></label><div className="viewer-transfer-list">{transfers.length === 0 ? <p>Nenhuma transferência nesta sessão.</p> : transfers.slice(0, 3).map((item) => <div className="session-transfer-item" key={item.id}><div><strong>{item.fileName}</strong><span>{fileStatusLabel(item)} · {formatBytes(item.size)}</span></div>{item.url && !item.savedPath && <a download={item.fileName} href={item.url}>Baixar</a>}</div>)}</div></div>}
            {activeTool === "monitor" && <div className="viewer-tool-fields"><label><span>Monitor remoto</span><select defaultValue="" disabled={remoteDisplays.length < 2} onChange={(event) => event.target.value && onDisplayChange(event.target.value)}><option value="">{remoteDisplays.length > 1 ? "Selecionar monitor" : "Monitor principal"}</option>{remoteDisplays.map((display, index) => <option key={display.id} value={display.id}>Monitor {index + 1}</option>)}</select></label></div>}
            {activeTool === "quality" && <div className="viewer-tool-fields"><label><span>Perfil de qualidade</span><select value={connectionQuality} onChange={(event) => onQualityChange(event.target.value as LocalSettings["connectionQuality"])}><option value="auto">Automática</option><option value="high">Alta</option><option value="balanced">Equilibrada</option><option value="economy">Economia</option></select></label><label><span>Resolução</span><select value={remoteResolution} onChange={(event) => onResolutionChange(event.target.value as RemoteResolution)}><option value="1920x1080">1920 × 1080</option><option value="1366x768">1366 × 768</option><option value="1280x720">1280 × 720</option><option value="1024x768">1024 × 768</option></select></label><label><span>Taxa de quadros</span><select value={maxFps} onChange={(event) => onFpsChange(Number(event.target.value) as LocalSettings["maxFps"])}><option value={60}>60 FPS</option><option value={120}>120 FPS</option></select></label></div>}
            {activeTool === "actions" && <div className="viewer-tool-actions"><button onClick={enterFullscreen} type="button"><Maximize2 aria-hidden="true" size={18} /><span>Tela cheia</span></button><button onClick={onRecord} type="button"><Radio aria-hidden="true" size={18} /><span>{recording ? "Parar gravação" : "Gravar sessão"}</span></button><button onClick={onClipboard} type="button"><Clipboard aria-hidden="true" size={18} /><span>Sincronizar texto</span></button></div>}
            {activeTool === "connection" && <dl className="viewer-connection-details"><div><dt>Rota</dt><dd>{metrics.route === "relay" ? "Relay TURN" : metrics.route === "direct" ? "P2P direta" : "Verificando"}</dd></div><div><dt>Latência</dt><dd>{metrics.latencyMs ? `${metrics.latencyMs} ms` : "-"}</dd></div><div><dt>FPS exibido</dt><dd>{metrics.decodedFps || metrics.fps || "-"}</dd></div><div><dt>FPS recebido</dt><dd>{metrics.receivedFps || "-"}</dd></div><div><dt>Quadros descartados</dt><dd>{metrics.droppedFrames}</dd></div><div><dt>Decodificação</dt><dd>{metrics.decodeMs ? `${metrics.decodeMs} ms/quadro` : "-"}</dd></div><div><dt>Bitrate</dt><dd>{metrics.bitrateKbps ? formatBitrate(metrics.bitrateKbps) : "-"}</dd></div><div><dt>Perda</dt><dd>{metrics.packetLossPct ? `${metrics.packetLossPct}%` : "0%"}</dd></div><div><dt>Codec</dt><dd>{metrics.codec || "Negociando"}</dd></div></dl>}
          </aside>}
          {error && <p className="viewer-session-error">{error}</p>}
        </div>
      </div>
      <footer className="remote-footer"><span><ShieldCheck aria-hidden="true" size={14} /> Conexão segura com criptografia de ponta a ponta</span><span><i /> Conectado · {metrics.route === "relay" ? "Relay" : "P2P"}</span></footer>
    </section>
  );
}

function HostSessionView({
  adminRequest,
  error,
  metrics,
  onDisconnect,
  onResolveAdmin,
  session,
}: {
  adminRequest?: string;
  error: string;
  metrics: SessionMetrics;
  onDisconnect: () => void;
  onResolveAdmin: (approved: boolean) => void;
  session: RemoteSession;
}) {
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  useEffect(() => {
    const startedAt = Date.now();
    const timer = window.setInterval(() => setElapsedSeconds(Math.floor((Date.now() - startedAt) / 1000)), 1000);
    return () => window.clearInterval(timer);
  }, [session.sessionId]);
  const elapsed = `${String(Math.floor(elapsedSeconds / 3600)).padStart(2, "0")}:${String(Math.floor((elapsedSeconds % 3600) / 60)).padStart(2, "0")}:${String(elapsedSeconds % 60).padStart(2, "0")}`;
  const permissions: Array<{ permission: SessionPermission; label: string }> = [
    { permission: "screen:view", label: "Visualizar sua tela" },
    { permission: "mouse:control", label: "Controlar o mouse" },
    { permission: "keyboard:control", label: "Usar o teclado" },
    { permission: "clipboard:sync", label: "Sincronizar texto copiado" },
    { permission: "files:transfer", label: "Transferir arquivos" },
    { permission: "audio:remote", label: "Ouvir o áudio do computador" },
  ];
  return (
    <section className="remote-session host-session">
      <header className="host-session-header">
        <div className="remote-brand"><div className="remote-mark">N</div><strong>NODUS <span>Connect</span></strong></div>
        <div className="host-session-state"><i /> Sessão remota ativa</div>
      </header>
      <main className="host-session-main">
        <section className="host-sharing-panel">
          <div className="host-sharing-symbol" aria-hidden="true"><MonitorUp size={38} /></div>
          <p className="eyebrow">Compartilhamento em andamento</p>
          <h1>Sua tela está sendo compartilhada com <strong>{session.remoteName}</strong></h1>
          <p className="host-sharing-copy">O Nodus mantém esta sessão visível. Você pode revisar as permissões e interromper o acesso a qualquer momento.</p>
          <div className="host-live-row"><span><i /> Conectado</span><span><Clock3 aria-hidden="true" size={15} /> {elapsed}</span><span><Link aria-hidden="true" size={15} /> {metrics.route === "relay" ? "Relay TURN" : metrics.route === "direct" ? "P2P direto" : "Verificando rota"}</span></div>
          <div className="host-session-details">
            <section className="host-permissions" aria-label="Permissões desta sessão">
              <h2>Permissões desta sessão</h2>
              {permissions.map(({ permission, label }) => {
                const granted = session.permissions.includes(permission);
                return <div className={granted ? "granted" : "blocked"} key={permission}><CheckCircle2 aria-hidden="true" size={17} /><span>{label}</span><b>{granted ? "Permitido" : "Bloqueado"}</b></div>;
              })}
            </section>
            <section className="host-connection-summary">
              <h2>Conexão</h2>
              <dl>
                <div><dt>Status</dt><dd>{session.status}</dd></div>
                <div><dt>Qualidade</dt><dd>{qualityLabel(metrics.quality)}</dd></div>
                <div><dt>Latência</dt><dd>{metrics.latencyMs ? `${metrics.latencyMs} ms` : "Calculando..."}</dd></div>
                <div><dt>Captura / envio</dt><dd>{metrics.captureFps || "-"} / {metrics.sentFps || "-"} FPS</dd></div>
                <div><dt>Codificação</dt><dd>{metrics.encodeMs ? `${metrics.encodeMs} ms/quadro` : "Calculando..."}</dd></div>
                <div><dt>Limitação</dt><dd>{metrics.limitation === "cpu" ? "Processador" : metrics.limitation === "bandwidth" ? "Rede" : metrics.limitation === "none" ? "Nenhuma" : "Verificando"}</dd></div>
                <div><dt>Criptografia</dt><dd>DTLS-SRTP</dd></div>
              </dl>
            </section>
          </div>
          {adminRequest && <section className="host-admin-request"><ShieldCheck aria-hidden="true" size={22} /><div><strong>Permissão de administrador solicitada</strong><p>{adminRequest} precisa da sua confirmação local no Windows.</p></div><button onClick={() => onResolveAdmin(false)} type="button">Recusar</button><button onClick={() => onResolveAdmin(true)} type="button">Autorizar</button></section>}
          {error && <p className="feedback host-session-feedback">{error}</p>}
          <button className="danger-button host-stop-sharing" onClick={onDisconnect} type="button"><Power aria-hidden="true" size={19} /> Encerrar compartilhamento</button>
          <p className="host-stop-note"><LockKeyhole aria-hidden="true" size={14} /> O acesso termina imediatamente ao encerrar.</p>
        </section>
      </main>
      <footer className="remote-footer"><span>Nodus Connect | Compartilhamento autorizado e visível</span><span><ShieldCheck aria-hidden="true" size={15} /> Conexão criptografada</span></footer>
    </section>
  );
}

function DeviceList({
  empty,
  favorites,
  folders,
  items,
  onCreateFolder,
  onMove,
  onRename,
  onUpdate,
  onToggleFavorite,
  onWake,
}: {
  empty: string;
  favorites: string[];
  folders: DeviceFolder[];
  items: RecentDevice[];
  onCreateFolder: (name: string) => void;
  onMove: (items: RecentDevice[]) => void;
  onRename: (items: RecentDevice[]) => void;
  onUpdate: (items: RecentDevice[]) => void;
  onToggleFavorite: (nodusId: string) => void;
  onWake: (device: RecentDevice) => void;
}) {
  const [folderName, setFolderName] = useState("");
  return (
    <section className="content-panel">
      <div className="section-heading">
        <h2>Dispositivos</h2>
        <span>{items.length}</span>
      </div>
      <form
        className="folder-form"
        onSubmit={(event) => {
          event.preventDefault();
          onCreateFolder(folderName);
          setFolderName("");
        }}
      >
        <input placeholder="Nova pasta de clientes" value={folderName} onChange={(event) => setFolderName(event.target.value)} />
        <button type="submit">Criar pasta</button>
      </form>
      {items.length === 0 ? (
        <p className="note">{empty}</p>
      ) : (
        <div className="device-list">
          {items.map((item) => (
            <div className="device-row" key={item.nodusId}>
              <div>
                <strong>{item.alias || item.deviceName}</strong>
                <small>
                  {item.nodusId} - {new Date(item.lastConnectionAt).toLocaleString(currentLocale())}
                </small>
              </div>
              <div className="row-actions">
                <input
                  aria-label="Renomear cliente"
                  placeholder="Renomear"
                  value={item.alias ?? ""}
                  onChange={(event) => onRename(renameDevice(item.nodusId, event.target.value))}
                />
                <select value={item.folderId ?? ""} onChange={(event) => onMove(moveDeviceToFolder(item.nodusId, event.target.value))}>
                  <option value="">Sem pasta</option>
                  {folders.map((folder) => (
                    <option key={folder.id} value={folder.id}>
                      {folder.name}
                    </option>
                  ))}
                </select>
                <span className="pill">{item.status}</span>
                <button onClick={() => onToggleFavorite(item.nodusId)} type="button">
                  {favorites.includes(item.nodusId) ? "Favorito" : "Favoritar"}
                </button>
                <button onClick={() => onWake(item)} type="button">Ligar</button>
              </div>
              <details className="device-details">
                <summary>Detalhes</summary>
                <input
                  defaultValue={item.tags?.join(", ") ?? ""}
                  onBlur={(event) => onUpdate(updateDevice(item.nodusId, { tags: event.target.value.split(",").map((tag) => tag.trim()).filter(Boolean) }))}
                  placeholder="Marcadores: cliente, suporte"
                />
                <input
                  defaultValue={item.macAddress ?? ""}
                  onBlur={(event) => onUpdate(updateDevice(item.nodusId, { macAddress: event.target.value.trim() || undefined }))}
                  placeholder="Endereco para ligar pela rede"
                />
                <textarea
                  defaultValue={item.notes ?? ""}
                  onBlur={(event) => onUpdate(updateDevice(item.nodusId, { notes: event.target.value.trim() || undefined }))}
                  placeholder="Observacoes"
                />
              </details>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function FileTransferPanel({
  activeSession,
  channelReady,
  onSendFile,
  transfers,
}: {
  activeSession: RemoteSession | null;
  channelReady: boolean;
  onSendFile: (file: File) => void;
  transfers: FileTransferRecord[];
}) {
  return (
    <section className="content-panel file-panel">
      <div className="section-heading">
        <h2>Transferencia de arquivos</h2>
        <span>{channelReady ? "Pronto" : "Aguardando"}</span>
      </div>
      <div className="file-drop">
        <div>
          <strong>{activeSession ? `Sessao com ${activeSession.remoteName}` : "Nenhuma sessao ativa"}</strong>
          <small>{channelReady ? "Escolha um arquivo para enviar." : "Conecte a outro computador para liberar o envio."}</small>
        </div>
        <label className={channelReady ? "file-button" : "file-button disabled"}>
          Enviar arquivo
          <input
            disabled={!channelReady}
            type="file"
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              if (file) onSendFile(file);
              event.currentTarget.value = "";
            }}
          />
        </label>
      </div>
      <div className="file-list">
        {transfers.length === 0 && <p className="note">Nenhum arquivo transferido nesta execucao.</p>}
        {transfers.map((item) => (
          <div className="file-row" key={item.id}>
            <div>
              <strong>{item.fileName}</strong>
              <small>
                {item.direction === "sent" ? "Enviado para" : "Recebido de"} {item.remoteName} - {formatBytes(item.size)}
              </small>
            </div>
            <div className="file-status">
              <span>{fileStatusLabel(item)}</span>
              <progress max={100} value={item.progress} />
              {item.url && (
                <a href={item.url} download={item.fileName}>
                  Baixar
                </a>
              )}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function Settings({
  appVersion,
  captureSources,
  initialSection,
  serviceStatus,
  onInstallService,
  onUninstallService,
  onStartService,
  onStopService,
  settings,
  updateSettings,
}: {
  appVersion: string;
  captureSources: CaptureSource[];
  initialSection: SettingsSection;
  serviceStatus: WindowsServiceStatus;
  onInstallService: () => void;
  onUninstallService: () => void;
  onStartService: () => void;
  onStopService: () => void;
  settings: LocalSettings;
  updateSettings: (patch: Partial<LocalSettings>) => void;
}) {
  const [draft, setDraft] = useState(settings);
  const [passwordDraft, setPasswordDraft] = useState("");
  const [section, setSection] = useState<SettingsSection>(initialSection);
  const dirty = JSON.stringify(draft) !== JSON.stringify(settings);
  const updateDraft = (patch: Partial<LocalSettings>) => setDraft((current) => ({ ...current, ...patch }));

  useEffect(() => {
    setDraft(settings);
  }, [settings]);

  useEffect(() => {
    setSection(initialSection);
  }, [initialSection]);

  useEffect(() => {
    document.documentElement.dataset.theme = draft.theme;
    return () => { document.documentElement.dataset.theme = settings.theme; };
  }, [draft.theme, settings.theme]);

  return (
    <section className="content-panel settings-panel">
      <div className="settings-heading">
        <div>
          <h2>Configurações</h2>
          <p>Personalize o Nodus Connect do seu jeito. O futuro é glorioso.</p>
        </div>
        <span className={dirty ? "settings-save-state dirty" : "settings-save-state"}>{dirty ? "Alterações não salvas" : "Tudo salvo"}</span>
      </div>
      <div className="settings-tabs" role="tablist">
        <button className={section === "general" ? "active" : ""} onClick={() => setSection("general")} type="button"><Settings2 /><span>Geral<small>Sistema e aparência</small></span></button>
        <button className={section === "access" ? "active" : ""} onClick={() => setSection("access")} type="button"><LockKeyhole /><span>Acesso<small>Segurança e permissões</small></span></button>
        <button className={section === "connection" ? "active" : ""} onClick={() => setSection("connection")} type="button"><Activity /><span>Conexão<small>Qualidade e desempenho</small></span></button>
        <button className={section === "appearance" ? "active" : ""} onClick={() => setSection("appearance")} type="button"><Palette /><span>Aparência<small>Tema e idioma</small></span></button>
      </div>
      <div className="settings-page">
        {section === "general" && <>
          <SettingsGroup icon={MonitorCog} title="Inicialização e Sistema" description="Defina como o Nodus deve se comportar com o seu sistema.">
            <Switch checked={draft.startWithWindows} icon={Power} label="Iniciar Nodus com o Windows" description="O aplicativo será iniciado automaticamente." onChange={(value) => updateDraft({ startWithWindows: value })} />
            <Switch checked={draft.startMinimized} icon={Monitor} label="Iniciar minimizado" description="Abrir o Nodus na bandeja do sistema." onChange={(value) => updateDraft({ startMinimized: value })} />
            <Switch checked={draft.minimizeToTray} icon={ChevronDown} label="Minimizar para bandeja" description="Ao fechar a janela, manter o Nodus em execução." onChange={(value) => updateDraft({ minimizeToTray: value })} />
            <Switch checked={draft.lightweightMode} icon={Zap} label="Modo leve" description="Reduz o uso de memória e efeitos gráficos." onChange={(value) => updateDraft({ lightweightMode: value })} />
            <Switch checked={draft.notifyIncomingRequests} icon={BellRing} label="Notificar pedidos recebidos" description="Exibe notificações de novas conexões." onChange={(value) => updateDraft({ notifyIncomingRequests: value })} />
            <Switch checked={draft.playRequestSound} icon={Volume2} label="Som ao receber pedido" description="Reproduz um som quando alguém solicitar acesso." onChange={(value) => updateDraft({ playRequestSound: value })} />
          </SettingsGroup>
          <SettingsGroup icon={ShieldCheck} title="Privacidade" description="Controle sua privacidade no aplicativo.">
            <Switch checked={draft.showNodusId} icon={Monitor} label="Mostrar meu Nodus ID" description="Oculta o ID na tela inicial, sem encerrar o serviço." onChange={(value) => updateDraft({ showNodusId: value })} />
            <Switch checked={draft.confirmBeforeDisconnect} icon={ShieldCheck} label="Confirmar antes de encerrar" description="Evita o encerramento acidental de uma sessão." onChange={(value) => updateDraft({ confirmBeforeDisconnect: value })} />
          </SettingsGroup>
          <SettingsGroup icon={RefreshCw} title="Atualizações" description="Mantenha o Nodus sempre atualizado.">
            <div className="update-row"><span>Versão atual: {appVersion}</span></div>
          </SettingsGroup>
        </>}
        {section === "access" && <>
          <Switch checked={draft.allowRemoteControl} label="Permitir mouse e teclado" onChange={(value) => updateDraft({ allowRemoteControl: value })} />
          <Switch checked={draft.allowFileTransfer} label="Permitir envio de arquivos" onChange={(value) => updateDraft({ allowFileTransfer: value })} />
          <Switch checked={draft.allowClipboard} label="Permitir texto copiado" onChange={(value) => updateDraft({ allowClipboard: value })} />
          <Switch checked={draft.shareAudio} label="Compartilhar som do computador" onChange={(value) => updateDraft({ shareAudio: value })} />
          <Switch checked={draft.unattendedAccess} label="Aceitar automaticamente computadores confiaveis" onChange={(value) => updateDraft({ unattendedAccess: value })} />
          <div className="service-setting">
            <strong>Servico do Windows</strong>
            <span>{serviceStatus.running ? "Ativo" : serviceStatus.installed ? "Instalado, parado" : "Nao instalado"}</span>
            <div>
              {!serviceStatus.installed && <button className="secondary-button" onClick={onInstallService} type="button">Instalar servico</button>}
              {serviceStatus.installed && !serviceStatus.running && <button className="secondary-button" onClick={onStartService} type="button">Iniciar servico</button>}
              {serviceStatus.installed && serviceStatus.running && <button className="secondary-button" onClick={onStopService} type="button">Parar servico</button>}
              {serviceStatus.installed && <button className="secondary-button" onClick={onUninstallService} type="button">Remover servico</button>}
            </div>
            <small className="note">O Windows solicitara permissao de administrador. O acesso continua sujeito a senha e permissoes.</small>
          </div>
          <div className="settings-field">
            <span>Senha deste Nodus</span>
            <div className="password-setting">
              <input
                autoComplete="new-password"
                type="password"
                value={passwordDraft}
                onChange={(event) => setPasswordDraft(event.target.value)}
                placeholder={draft.accessPasswordHash ? "Senha configurada" : "Defina uma senha para este computador"}
              />
              <button className="secondary-button" onClick={async () => {
                const bytes = new TextEncoder().encode(passwordDraft);
                const digest = await crypto.subtle.digest("SHA-256", bytes);
                const hash = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
                updateDraft({ accessPasswordHash: hash });
                setPasswordDraft("");
              }} disabled={!passwordDraft} type="button">Definir senha</button>
              {draft.accessPasswordHash && <button className="secondary-button" onClick={() => updateDraft({ accessPasswordHash: "" })} type="button">Remover</button>}
            </div>
            <small className="note">Quem informar esta senha corretamente entra na conexão sem um novo aceite.</small>
          </div>
          <div className="trusted-list">
            <strong>Computadores confiaveis</strong>
            {draft.trustedNodusIds.length === 0 && <span>Nenhum computador autorizado.</span>}
            {draft.trustedNodusIds.map((nodusId) => (
              <button key={nodusId} onClick={() => updateDraft({ trustedNodusIds: draft.trustedNodusIds.filter((id) => id !== nodusId) })} type="button">
                {formatNodusId(nodusId)} <span>Remover</span>
              </button>
            ))}
          </div>
        </>}
        {section === "connection" && <>
          <label className="select-row">Resolucao preferida
            <select value={draft.preferredResolution} onChange={(event) => updateDraft({ preferredResolution: event.target.value as LocalSettings["preferredResolution"] })}>
              <option value="1366x768">1366 x 768</option>
              <option value="1280x720">1280 x 720</option>
              <option value="1920x1080">1920 x 1080</option>
              <option value="1024x768">1024 x 768</option>
            </select>
          </label>
          <label className="select-row">Qualidade da tela
            <select value={draft.connectionQuality} onChange={(event) => updateDraft({ connectionQuality: event.target.value as LocalSettings["connectionQuality"] })}>
              <option value="auto">Automatica</option><option value="high">Alta</option><option value="balanced">Equilibrada</option><option value="economy">Economia de internet</option>
            </select>
          </label>
          <label className="select-row">Movimento da imagem
            <select value={draft.maxFps} onChange={(event) => updateDraft({ maxFps: Number(event.target.value) as LocalSettings["maxFps"] })}>
              <option value={60}>60 FPS</option><option value={120}>120 FPS</option>
            </select>
          </label>
          <label className="select-row">Tela compartilhada
            <select value={draft.preferredDisplayId} onChange={(event) => updateDraft({ preferredDisplayId: event.target.value })}>
              <option value="">Tela principal</option>
              {captureSources.map((source) => <option key={source.id} value={source.id}>{source.name}</option>)}
            </select>
          </label>
        </>}
        {section === "appearance" && <section className="appearance-page">
          <div className="appearance-intro"><div><h3>Temas</h3><p>Escolha o ambiente visual do Nodus Connect.</p></div><span>{themeOptions.find((theme) => theme.id === draft.theme)?.label}</span></div>
          <div className="theme-grid" role="radiogroup" aria-label="Tema visual">
            {themeOptions.map((theme) => <button aria-checked={draft.theme === theme.id} className={`theme-option theme-${theme.id} ${draft.theme === theme.id ? "active" : ""}`} key={theme.id} onClick={() => updateDraft({ theme: theme.id })} role="radio" type="button"><span className="theme-option-preview" aria-hidden="true" /><span><b>{theme.label}</b><small>{theme.description}</small></span></button>)}
          </div>
          <label className="appearance-language"><span><Globe2 />Idioma</span><select value={draft.language} onChange={(event) => updateDraft({ language: event.target.value as LocalSettings["language"] })}><option value="pt-BR">Português (Brasil)</option><option value="en-US">English</option><option value="ru-RU">Русский</option><option value="ja-JP">日本語</option></select></label>
        </section>}
      </div>
      <div className="settings-actions">
        <button className="secondary-button" disabled={!dirty} onClick={() => setDraft(settings)} type="button">
          Descartar
        </button>
        <button className="settings-save-button" disabled={!dirty} onClick={() => updateSettings(draft)} type="button">
          <Save aria-hidden="true" size={16} /> Salvar
        </button>
      </div>
    </section>
  );
}

function directionLabel(value: AccessLogEntry["direction"]): string {
  return value === "outgoing" ? "saida" : "entrada";
}

function fileStatusLabel(item: FileTransferRecord): string {
  if (item.savedPath) return `Salvo em ${item.savedPath}`;
  if (item.status === "sending") return `Enviando ${item.progress}%`;
  if (item.status === "receiving") return `Recebendo ${item.progress}%`;
  if (item.status === "sent") return "Enviado";
  if (item.status === "received") return "Recebido";
  return item.error || "Falhou";
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  return `${(value / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

function emptyMetrics(): SessionMetrics {
  return { bitrateKbps: 0, fps: 0, captureFps: 0, encodedFps: 0, sentFps: 0, receivedFps: 0, decodedFps: 0, renderFps: 0, renderDroppedFrames: 0, latencyMs: 0, route: "unknown", quality: "balanced", codec: "", packetLossPct: 0, jitterMs: 0, availableKbps: 0, captureWidth: 0, captureHeight: 0, encodeMs: 0, decodeMs: 0, droppedFrames: 0, limitation: "none", encoder: "", decoder: "" };
}

function hasTurnServer(iceServers: RTCIceServer[]): boolean {
  return iceServerUrls(iceServers).some((url) => /^turns?:/i.test(url));
}

function iceServerUrls(iceServers: RTCIceServer[]): string[] {
  return iceServers.flatMap((server) => Array.isArray(server.urls) ? server.urls : [server.urls]).filter(Boolean);
}

function candidateType(candidate: string): string {
  return candidate.match(/\btyp\s+([a-z0-9-]+)/i)?.[1] ?? "unknown";
}

function preferDesktopCodecs(transceiver: RTCRtpTransceiver) {
  const capabilities = RTCRtpReceiver.getCapabilities("video");
  if (!capabilities?.codecs.length || !transceiver.setCodecPreferences) return;
  const preferred = ["h264", "vp8", "vp9", "av1"];
  const rank = (codec: { mimeType: string }) => {
    const name = codec.mimeType.split("/")[1]?.toLowerCase() ?? "";
    const index = preferred.indexOf(name);
    return index < 0 ? preferred.length : index;
  };
  transceiver.setCodecPreferences([...capabilities.codecs].sort((a, b) => rank(a) - rank(b)));
}

function allowedPermissions(request: SessionRequestRecord, settings: LocalSettings): SessionPermission[] {
  const requested = new Set(request.requestedPermissions?.length ? request.requestedPermissions : [
    "screen:view", "mouse:control", "keyboard:control", "clipboard:sync", "files:transfer", "audio:remote",
  ] satisfies SessionPermission[]);
  return ([
    "screen:view",
    ...(settings.allowRemoteControl ? ["mouse:control", "keyboard:control"] : []),
    ...(settings.allowClipboard ? ["clipboard:sync"] : []),
    ...(settings.allowFileTransfer ? ["files:transfer"] : []),
    ...(settings.shareAudio ? ["audio:remote"] : []),
  ] as SessionPermission[]).filter((permission) => requested.has(permission));
}

function qualityLabel(value: SessionMetrics["quality"]): string {
  return value === "high" ? "Qualidade alta" : value === "economy" ? "Modo economia" : "Qualidade equilibrada";
}

function permissionLabel(value: SessionPermission): string {
  return {
    "screen:view": "Ver tela",
    "mouse:control": "Usar mouse",
    "keyboard:control": "Usar teclado",
    "clipboard:sync": "Enviar texto copiado",
    "files:transfer": "Enviar arquivos",
    "audio:remote": "Ouvir som",
    "admin:actions": "Acoes do computador",
  }[value];
}

function formatBitrate(value: number): string {
  return value >= 1000 ? `${(value / 1000).toFixed(1)} Mbps` : `${value} Kbps`;
}

function maskNodusId(value: string): string {
  const digits = normalizeNodusId(value) ?? value.replace(/\D/g, "");
  if (digits.length < 4) return "***";
  return `*** *** ${digits.slice(-3)}`;
}

function resultLabel(value: AccessLogEntry["result"]): string {
  return {
    requested: "pedido enviado",
    accepted: "aceito",
    denied: "recusado",
    connected: "conectado",
    disconnected: "encerrado",
    error: "falhou",
  }[value];
}

function SettingsGroup({ icon: Icon, title, description, children }: { icon: LucideIcon; title: string; description: string; children: React.ReactNode }) {
  return <section className="settings-group"><header><span className="settings-group-icon"><Icon /></span><div><h3>{title}</h3><p>{description}</p></div></header><div className="settings-group-body">{children}</div></section>;
}

function Switch({ checked, label, description, icon: Icon, onChange }: { checked: boolean; label: string; description?: string; icon?: LucideIcon; onChange: (value: boolean) => void }) {
  return (
    <label className="switch-row">
      {Icon && <span className="switch-icon"><Icon /></span>}
      <span className="switch-copy"><strong>{label}</strong>{description && <small>{description}</small>}</span>
      <input checked={checked} onChange={(event) => onChange(event.target.checked)} type="checkbox" />
      <span className="switch-control" aria-hidden="true" />
    </label>
  );
}
