import {
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
  MonitorCog,
  Monitor,
  MonitorUp,
  MoreHorizontal,
  Plus,
  Radio,
  Palette,
  Power,
  RefreshCw,
  Search,
  Settings2,
  ShieldCheck,
  Star,
  Volume2,
  VolumeX,
  Wifi,
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
  type SessionRequestRecord,
  type SignalMessage,
} from "./core/api";
import { loadNativeIdentity, loadOrCreateIdentity, regenerateNodusId, saveIdentity, type LocalIdentity } from "./core/identity";
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

type ServiceState = "connecting" | "online" | "offline" | "error";
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
  latencyMs: number;
  route: "direct" | "relay" | "unknown";
  quality: "high" | "balanced" | "economy";
  codec: string;
  packetLossPct: number;
};
type RemoteInputMessage =
  | { type: "mouseMove"; x: number; y: number }
  | { type: "mouseDown" | "mouseUp"; button: number }
  | { type: "wheel"; delta: number }
  | { type: "keyDown" | "keyUp"; keyCode: number }
  | { type: "clipboard"; text: string }
  | { type: "resolution"; resolution: RemoteResolution }
  | { type: "display"; displayId: string }
  | { type: "screen-options"; displays: CaptureSource[] }
  | { type: "admin-request" }
  | { type: "admin-status"; status: "approved" | "denied" | "unavailable" };
type CaptureSource = { id: string; name: string; displayId: string };
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
  const [feedback, setFeedback] = useState("");
  const [activeView, setActiveView] = useState<View>("connection");
  const [recents, setRecents] = useState<RecentDevice[]>(() => loadRecents());
  const [favorites, setFavorites] = useState<string[]>(() => loadFavorites());
  const [settings, setSettings] = useState<LocalSettings>(() => loadSettings());
  const [currentUser, setCurrentUser] = useState<LocalUser | null>(() => loadUser());
  const [folders, setFolders] = useState<DeviceFolder[]>(() => loadFolders());
  const [accessLog, setAccessLog] = useState<AccessLogEntry[]>(() => loadAccessLog());
  const [appVersion, setAppVersion] = useState("0.4.0");
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
  const statsRef = useRef(new Map<string, { bytes: number; frames: number; at: number }>());
  const qualityTierRef = useRef(new Map<string, SessionMetrics["quality"]>());
  const requestedResolutionsRef = useRef(new Map<string, RemoteResolution>());
  const recordingRef = useRef(new Map<string, { recorder: MediaRecorder; chunks: BlobPart[] }>());
  const autoAcceptingRef = useRef(new Set<string>());
  const processedSignalsRef = useRef(new Set<string>());
  const lastIncomingAlertRef = useRef("");
  const sessionsRef = useRef<SessionRuntime[]>([]);
  const remoteVideoRef = useRef<HTMLVideoElement | null>(null);
  const shareVideoRef = useRef<HTMLVideoElement | null>(null);
  const activeRuntime = useMemo(
    () => sessionRuntimes.find((item) => item.session.sessionId === selectedSessionId) ?? sessionRuntimes[0] ?? null,
    [selectedSessionId, sessionRuntimes],
  );
  const activeSession = activeRuntime?.session ?? null;
  const remoteStream = activeRuntime?.remoteStream ?? null;
  const shareStream = activeRuntime?.shareStream ?? null;
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
    document.documentElement.dataset.theme = settings.theme;
  }, [settings.theme]);

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
    }).catch(() => undefined);
  }, [settings.startMinimized, settings.startWithWindows]);

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
      window.nodusDesktop?.writeDiagnostic(`capture-backend=${status.backend || (status.supported ? "windows-graphics-capture" : "chromium-fallback")}`);
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
        if (outgoingRequest?.id !== request.id) return;
        setOutgoingRequest(request);
        if (request.status === "denied") {
          setFeedback("Pedido recusado pelo outro computador.");
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
          setOutgoingRequest(null);
          startViewerSession(request).catch(() => setFeedback("Nao foi possivel iniciar o acesso remoto."));
        }
      },
      onSignal: (signal) => {
        handleSignal(signal).catch(() => updateRuntime(signal.sessionId, { error: "Falha temporaria na conexao." }));
      },
    });
    return () => realtime.close();
  }, [identity.deviceNameConfirmed, identity.nodusId, outgoingRequest, settings.coordinationUrl]);

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
    return () => video.removeEventListener("loadedmetadata", play);
  }, [remoteStream]);

  useEffect(() => {
    const video = shareVideoRef.current;
    if (!video) return;
    video.srcObject = shareStream;
    video.muted = true;
    const play = () => video.play().catch(() => undefined);
    video.addEventListener("loadedmetadata", play);
    play();
    return () => video.removeEventListener("loadedmetadata", play);
  }, [shareStream]);

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
    const request = incomingRequests.find((item) => settings.trustedNodusIds.includes(item.requesterNodusId));
    if (!settings.unattendedAccess || !request || autoAcceptingRef.current.has(request.id)) return;
    autoAcceptingRef.current.add(request.id);
    acceptIncoming(request).finally(() => autoAcceptingRef.current.delete(request.id));
  }, [incomingRequests, settings.trustedNodusIds, settings.unattendedAccess]);

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
    await connectToDevice(targetId);
  }

  async function connectToDevice(target: string) {
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
        passwordHash: await hashPassword(settings.remoteAccessPassword),
        preferredResolution: settings.preferredResolution,
      });
      recordAccess({
        nodusId: device.nodusId,
        deviceName: device.deviceName,
        direction: "outgoing",
        result: "requested",
      });
      setOutgoingRequest(request);
      setFeedback("Dispositivo encontrado. Aguardando autorizacao...");
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "Nao foi possivel conectar ao dispositivo.");
    }
  }

  async function acceptIncoming(request: SessionRequestRecord): Promise<string | null> {
    try {
      setFeedback("");
      if (settings.accessPasswordHash && request.passwordHash !== settings.accessPasswordHash) {
        setFeedback("Senha incorreta. O solicitante precisa informar a senha deste Nodus.");
        return "Senha incorreta. Configure a senha de acesso nas configuracoes do computador que esta iniciando a conexao.";
      }
      const iceWarmup = fetchIceServers(settings.coordinationUrl).then((servers) => {
        if (servers.length) setServerIceServers(servers);
        return servers;
      }).catch(() => [] as RTCIceServer[]);
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: captureConstraints(settings, request.preferredResolution),
        audio: settings.shareAudio,
      });
      logDiagnostic(`capture-started video=${stream.getVideoTracks().length} audio=${stream.getAudioTracks().length}`);
      const accepted = await acceptSessionRequest(request.id, identity.deviceName, allowedPermissions(request, settings));
      recordAccess({
        nodusId: request.requesterNodusId,
        deviceName: request.requesterName,
        direction: "incoming",
        result: "accepted",
      });
      setIncomingRequests((items) => items.filter((item) => item.id !== request.id));
      await startHostSession(accepted, stream);
      return null;
    } catch {
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

  async function startHostSession(request: SessionRequestRecord, stream: MediaStream) {
    if (!request.sessionId) return;
    if (peersRef.current.has(request.sessionId)) {
      setSelectedSessionId(request.sessionId);
      return;
    }
    const remoteNodusId = request.requesterNodusId;
    const peer = createPeer(request.sessionId, identity.nodusId, remoteNodusId, "host", getEffectiveIceServers());
    stream.getTracks().forEach((track) => {
      if (track.kind === "video") track.contentHint = "detail";
      const sender = peer.addTrack(track, stream);
      logDiagnostic(`track-added id=${request.sessionId} kind=${track.kind} state=${track.readyState}`);
      const transceiver = peer.getTransceivers().find((item) => item.sender === sender);
      if (track.kind === "video" && transceiver) preferDesktopCodecs(transceiver, settings.lightweightMode);
      if (track.kind === "video") {
        requestedResolutionsRef.current.set(request.sessionId!, request.preferredResolution ?? settings.preferredResolution);
        setSessionResolutions((current) => ({ ...current, [request.sessionId!]: request.preferredResolution ?? settings.preferredResolution }));
        tuneVideoSender(sender);
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
        permissions: request.grantedPermissions ?? allowedPermissions(request, settings),
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
    preferDesktopCodecs(peer.addTransceiver("video", { direction: "recvonly" }), settings.lightweightMode);
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
    const inspect = async () => {
      if (peer.connectionState === "closed") return;
      try {
        const reports = await peer.getStats();
        let bytes = 0;
        let frames = 0;
        let latencyMs = 0;
        let lost = 0;
        let received = 0;
        let route: SessionMetrics["route"] = "unknown";
        let codecId = "";
        let codec = "";
        const codecs = new Map<string, string>();
        const candidates = new Map<string, string>();
        let selectedPair: { localCandidateId?: string; remoteCandidateId?: string; currentRoundTripTime?: number } | undefined;
        for (const report of reports.values()) {
          const item = report as RTCStats & Record<string, number | string | boolean | undefined>;
          if (item.type === "codec") codecs.set(item.id, String(item.mimeType || "").split("/").pop()?.toUpperCase() || "");
          if (item.type === "local-candidate" || item.type === "remote-candidate") candidates.set(item.id, String(item.candidateType || ""));
          if (item.type === "candidate-pair" && item.state === "succeeded" && (item.nominated || item.selected)) {
            selectedPair = {
              localCandidateId: String(item.localCandidateId || ""),
              remoteCandidateId: String(item.remoteCandidateId || ""),
              currentRoundTripTime: Number(item.currentRoundTripTime || 0),
            };
          }
          if (item.type === "inbound-rtp" && item.kind === "video" && role === "viewer") {
            bytes += Number(item.bytesReceived || 0);
            frames += Number(item.framesDecoded || 0);
            lost += Number(item.packetsLost || 0);
            received += Number(item.packetsReceived || 0);
            codecId = String(item.codecId || codecId);
          }
          if (item.type === "outbound-rtp" && item.kind === "video" && role === "host") {
            bytes += Number(item.bytesSent || 0);
            frames += Number(item.framesEncoded || 0);
            codecId = String(item.codecId || codecId);
          }
        }
        codec = codecs.get(codecId) || "";
        if (selectedPair) {
          latencyMs = Math.round(Number(selectedPair.currentRoundTripTime || 0) * 1000);
          route = candidates.get(String(selectedPair.localCandidateId)) === "relay" || candidates.get(String(selectedPair.remoteCandidateId)) === "relay" ? "relay" : "direct";
        }
        const now = performance.now();
        const previous = statsRef.current.get(sessionId);
        const bitrateKbps = previous ? Math.max(0, Math.round(((bytes - previous.bytes) * 8) / (now - previous.at))) : 0;
        const fps = previous ? Math.max(0, Math.round(((frames - previous.frames) * 1000) / (now - previous.at))) : 0;
        statsRef.current.set(sessionId, { bytes, frames, at: now });
        const loss = lost / Math.max(1, lost + received);
        const quality = await applyAdaptiveQuality(sessionId, peer, role, latencyMs, loss);
        updateRuntime(sessionId, { metrics: { bitrateKbps, fps, latencyMs, route, quality, codec, packetLossPct: Math.round(loss * 1000) / 10 } });
      } catch {}
    };
    inspect();
    qualityTimersRef.current.set(sessionId, window.setInterval(inspect, 2500));
  }

  async function applyAdaptiveQuality(
    sessionId: string,
    peer: RTCPeerConnection,
    role: RemoteSession["role"],
    latencyMs: number,
    loss: number,
  ): Promise<SessionMetrics["quality"]> {
    let quality: SessionMetrics["quality"] = settings.connectionQuality === "auto"
      ? latencyMs > 300 || loss > 0.08 ? "economy" : latencyMs > 160 || loss > 0.03 ? "balanced" : "high"
      : settings.connectionQuality;
    if (role !== "host" || qualityTierRef.current.get(sessionId) === quality) return quality;
    const sender = peer.getSenders().find((item) => item.track?.kind === "video");
    if (!sender) return quality;
    const limits = quality === "economy"
      ? { bitrate: 900_000, fps: 15, scale: 2 }
      : quality === "balanced"
        ? { bitrate: 2_500_000, fps: Math.min(30, settings.maxFps), scale: 1 }
        : { bitrate: 6_000_000, fps: settings.maxFps, scale: 1 };
    try {
      const parameters = sender.getParameters();
      if (!parameters.encodings.length) parameters.encodings = [{}];
      parameters.encodings[0].maxBitrate = limits.bitrate;
      parameters.encodings[0].maxFramerate = limits.fps;
      const requestedResolution = requestedResolutionsRef.current.get(sessionId);
      if (requestedResolution) {
        const [targetWidth, targetHeight] = requestedResolution.split("x").map(Number);
        const source = sender.track?.getSettings();
        const requestedScale = Math.max(1, (source?.width ?? targetWidth) / targetWidth, (source?.height ?? targetHeight) / targetHeight);
        parameters.encodings[0].scaleResolutionDownBy = Math.max(limits.scale, requestedScale);
      } else {
        parameters.encodings[0].scaleResolutionDownBy = limits.scale;
      }
      await sender.setParameters(parameters);
      qualityTierRef.current.set(sessionId, quality);
    } catch {}
    return quality;
  }

  function tuneVideoSender(sender: RTCRtpSender) {
    try {
      const parameters = sender.getParameters();
      if (!parameters.encodings.length) parameters.encodings = [{}];
      parameters.degradationPreference = "maintain-framerate";
      parameters.encodings[0].maxBitrate = settings.connectionQuality === "high" ? 6_000_000 : 3_000_000;
      parameters.encodings[0].maxFramerate = settings.maxFps;
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
        const url = URL.createObjectURL(new Blob(transfer.chunks, { type: transfer.mime }));
        incomingFilesRef.current.delete(message.id);
        patchFileTransfer(message.id, { status: "received", progress: 100, url });
      }
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
    qualityTierRef.current.delete(sessionId);
    requestedResolutionsRef.current.delete(sessionId);
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
      sessionsRef.current.find((item) => item.session.sessionId === sessionId)?.shareStream?.getTracks().forEach((track) => track.stop());
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
      }).catch(() => undefined);
    }
    if ("allowRemoteControl" in patch) {
      window.nodusDesktop?.setRemoteControlActive(next.allowRemoteControl && sessionsRef.current.some((item) => item.session.role === "host")).catch(() => undefined);
    }
    if ("preferredResolution" in patch && activeSession) {
      if (activeSession.role === "viewer") sendRemoteInputToSession(activeSession.sessionId, { type: "resolution", resolution: next.preferredResolution });
      else switchHostCapture(activeSession.sessionId, next.preferredResolution).catch(() => setFeedback("Nao foi possivel aplicar a resolucao agora."));
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

  function captureConstraints(value: LocalSettings, requestedResolution?: RemoteResolution): MediaTrackConstraints {
    const frameRate = value.maxFps;
    const [width, height] = (requestedResolution ?? "1920x1080").split("x").map(Number);
    const limit = value.connectionQuality === "economy" ? [Math.min(width, 1280), Math.min(height, 720)] : [width, height];
    return { frameRate, width: { ideal: limit[0], max: limit[0] }, height: { ideal: limit[1], max: limit[1] } };
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

  async function switchHostCapture(sessionId: string, requestedResolution?: RemoteResolution, requestedDisplayId?: string) {
    const runtime = sessionsRef.current.find((item) => item.session.sessionId === sessionId);
    const peer = peersRef.current.get(sessionId);
    if (!runtime?.shareStream || !peer) return;
    const resolution = requestedResolution ?? requestedResolutionsRef.current.get(sessionId) ?? settings.preferredResolution;
    requestedResolutionsRef.current.set(sessionId, resolution);
    const displayId = requestedDisplayId || settings.preferredDisplayId;
    const source = captureSources.find((item) => item.id === displayId);
    await window.nodusDesktop?.setCaptureOptions({ sourceId: displayId, displayId: source?.displayId, shareAudio: settings.shareAudio });
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: captureConstraints(settings, resolution),
      audio: settings.shareAudio,
    });
    const track = stream.getVideoTracks()[0];
    const sender = peer.getSenders().find((item) => item.track?.kind === "video");
    if (!track || !sender) {
      stream.getTracks().forEach((item) => item.stop());
      return;
    }
    track.contentHint = "detail";
    await sender.replaceTrack(track);
    const audioTrack = stream.getAudioTracks()[0];
    const audioSender = peer.getSenders().find((item) => item.track?.kind === "audio");
    if (audioTrack && audioSender) await audioSender.replaceTrack(audioTrack);
    tuneVideoSender(sender);
    applyRequestedResolution(sender, resolution);
    runtime.shareStream.getTracks().forEach((item) => item.stop());
    updateRuntime(sessionId, { shareStream: stream });
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
    if (now - lastControlMoveRef.current < 30) return;
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
              shareVideoRef={shareVideoRef}
              controlReady={controlReady}
              hasRemoteStream={Boolean(remoteStream)}
              hasShareStream={Boolean(shareStream)}
              error={sessionError}
              fileReady={activeFileReady}
              metrics={activeRuntime?.metrics ?? emptyMetrics()}
              recording={recordingSessionId === activeSession.sessionId}
              transfers={fileTransfers.filter((item) => item.sessionId === activeSession.sessionId)}
              remoteResolution={activeSession.role === "viewer" ? settings.preferredResolution : sessionResolutions[activeSession.sessionId] ?? settings.preferredResolution}
              remoteDisplays={remoteDisplays[activeSession.sessionId] ?? []}
              remoteAudioMuted={Boolean(remoteAudioMuted[activeSession.sessionId])}
              adminRequest={adminRequests[activeSession.sessionId]}
              onResolutionChange={(resolution) => updateSettings({ preferredResolution: resolution })}
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
              onCopy={() => navigator.clipboard.writeText(identity.nodusId).then(() => setFeedback("Nodus ID copiado."))}
              onOpenDevices={() => setActiveView("devices")}
              onOpenFiles={() => setActiveView("files")}
              onOpenSettings={() => setActiveView("settings")}
              onSubmit={connect}
              onTargetChange={setTargetId}
              onToggleFavorite={onToggleFavorite}
              onViewStatus={() => setActiveView("settings")}
              outgoingRequest={outgoingRequest}
              recentDevices={recents.slice(0, 3)}
              serviceState={serviceState}
              statusLabel={statusLabel}
              targetId={targetId}
            />}
            {activeView === "devices" && <Devices identity={identity} items={recents} favorites={favorites} nodusIdLabel={visibleNodusId} onAddDevice={() => setFeedback("Digite o Nodus ID no campo acima para adicionar um dispositivo.")} onConnect={connectToDevice} onOpenFiles={() => setActiveView("files")} onToggleFavorite={onToggleFavorite} statusLabel={statusLabel} />}
            {activeView === "favorites" && <FavoritesPage favorites={favorites} items={recents.filter((item) => favorites.includes(item.nodusId))} onConnect={connectToDevice} onOpenDevices={() => setActiveView("devices")} onToggleFavorite={onToggleFavorite} />}
            {activeView === "recents" && <DeviceList empty="Nenhum dispositivo recente." favorites={favorites} items={recents} folders={folders} onCreateFolder={(name) => setFolders(createFolder(name))} onMove={setRecents} onRename={setRecents} onUpdate={setRecents} onWake={wakeDevice} onToggleFavorite={onToggleFavorite} />}
            {activeView === "files" && <FileTransferPanel activeSession={activeSession} channelReady={activeFileReady} transfers={fileTransfers} onSendFile={sendFile} />}
            {activeView === "settings" && <Settings
              captureSources={captureSources}
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
  onOpenDevices,
  onOpenFiles,
  onOpenSettings,
  onSubmit,
  onTargetChange,
  onToggleFavorite,
  onViewStatus,
  outgoingRequest,
  recentDevices,
  serviceState,
  statusLabel,
  targetId,
}: {
  feedback: string;
  favorites: string[];
  identity: LocalIdentity;
  items: RecentDevice[];
  nodusIdLabel: string;
  onConnect: (nodusId: string) => void;
  onCopy: () => void;
  onOpenDevices: () => void;
  onOpenFiles: () => void;
  onOpenSettings: () => void;
  onSubmit: (event: FormEvent) => void;
  onTargetChange: (value: string) => void;
  onToggleFavorite: (nodusId: string) => void;
  onViewStatus: () => void;
  outgoingRequest: SessionRequestRecord | null;
  recentDevices: RecentDevice[];
  serviceState: ServiceState;
  statusLabel: string;
  targetId: string;
}) {
  return (
    <section className="connection-home">
      <div className="connection-overview">
        <section className="identity-card">
          <div className="panel-label"><span>Seu Nodus ID</span><button className="help-icon" title="Sobre o Nodus ID" type="button">?</button></div>
          <strong className="nodus-id-value">{formatNodusId(nodusIdLabel).slice(0, -3)}<em>{formatNodusId(nodusIdLabel).slice(-3)}</em></strong>
          <span><i /> Disponível para conexões</span>
          <button className="icon-button copy-id" onClick={onCopy} title="Copiar Nodus ID" type="button"><Copy aria-hidden="true" size={18} /></button>
        </section>
        <ConnectBox feedback={feedback} outgoingRequest={outgoingRequest} recentDevices={recentDevices} targetId={targetId} onSubmit={onSubmit} onTargetChange={onTargetChange} />
        <SystemStatusCard onViewMore={onViewStatus} serviceState={serviceState} statusLabel={statusLabel} />
      </div>
      <div className="connection-content">
        <RecentDeviceList favorites={favorites} items={items.slice(0, 4)} onConnect={onConnect} onToggleFavorite={onToggleFavorite} onViewAll={onOpenDevices} />
        <section className="quick-access-panel">
          <h2>Acesso rápido</h2>
          <button onClick={onOpenFiles} type="button"><FolderUp aria-hidden="true" /><span>Transferir arquivos</span><ArrowRight aria-hidden="true" /></button>
          <button onClick={onOpenSettings} type="button"><Settings2 aria-hidden="true" /><span>Configurações</span><ArrowRight aria-hidden="true" /></button>
          <button disabled title="Ajuda e suporte estará disponível em breve" type="button"><ShieldCheck aria-hidden="true" /><span>Ajuda e suporte</span><ArrowRight aria-hidden="true" /></button>
        </section>
      </div>
    </section>
  );
}

function RecentDeviceList({
  favorites,
  items,
  onConnect,
  onToggleFavorite,
  onViewAll,
}: {
  favorites: string[];
  items: RecentDevice[];
  onConnect: (nodusId: string) => void;
  onToggleFavorite: (nodusId: string) => void;
  onViewAll: () => void;
}) {
  return (
    <section className="recent-device-panel">
      <div className="section-heading"><h2>Dispositivos recentes</h2><button className="panel-action" onClick={onViewAll} type="button">Ver todos <ArrowRight aria-hidden="true" size={15} /></button></div>
      {items.length ? <div className="recent-device-list">{items.map((item, index) => <RecentDeviceRow favorite={favorites.includes(item.nodusId)} item={item} key={item.nodusId} onConnect={onConnect} onToggleFavorite={onToggleFavorite} tone={["blue", "red", "sunset", "forest"][index % 4] as DeviceTone} />)}</div> : <p className="note">Os computadores acessados aparecerão aqui para conexões mais rápidas.</p>}
    </section>
  );
}

type DeviceTone = "blue" | "red" | "sunset" | "forest";

function RecentDeviceRow({ favorite, item, onConnect, onToggleFavorite, tone }: { favorite?: boolean; item: RecentDevice; onConnect: (nodusId: string) => void; onToggleFavorite?: (nodusId: string) => void; tone: DeviceTone }) {
  const online = item.status === "online";
  const lastAccess = new Date(item.lastConnectionAt).toLocaleDateString("pt-BR");
  return (
    <article className="recent-device-row">
      <div className={`recent-device-art tone-${tone}`} aria-hidden="true" />
      <div className="recent-device-name"><strong>{item.alias || item.deviceName}</strong><small><Monitor aria-hidden="true" size={15} /> Windows</small></div>
      <div className={online ? "recent-device-status online" : "recent-device-status"}><span><i /> {online ? "Online" : "Offline"}</span><small><Clock3 aria-hidden="true" size={15} /> Último acesso: {lastAccess}</small></div>
      <button className="secondary-button recent-device-connect" onClick={() => onConnect(item.nodusId)} type="button">Conectar <ArrowRight aria-hidden="true" size={16} /></button>
      {onToggleFavorite && <button className={favorite ? "favorite-row active" : "favorite-row"} onClick={() => onToggleFavorite(item.nodusId)} title={favorite ? "Remover dos favoritos" : "Adicionar aos favoritos"} type="button"><Star aria-hidden="true" fill={favorite ? "currentColor" : "none"} size={18} /></button>}
      <span className="row-menu" aria-hidden="true"><MoreHorizontal size={19} /></span>
    </article>
  );
}

function FavoritesPage({ favorites, items, onConnect, onOpenDevices, onToggleFavorite }: { favorites: string[]; items: RecentDevice[]; onConnect: (nodusId: string) => void; onOpenDevices: () => void; onToggleFavorite: (nodusId: string) => void }) {
  const [query, setQuery] = useState("");
  const visibleItems = items.filter((item) => `${item.alias ?? ""} ${item.deviceName} ${item.nodusId}`.toLocaleLowerCase("pt-BR").includes(query.toLocaleLowerCase("pt-BR")));
  return (
    <section className="favorites-page">
      <div className="favorites-tools"><label><Search aria-hidden="true" size={19} /><input placeholder="Buscar nos favoritos..." value={query} onChange={(event) => setQuery(event.target.value)} /></label><span>{favorites.length} favorito{favorites.length === 1 ? "" : "s"}</span></div>
      {visibleItems.length ? <div className="favorites-list">{visibleItems.map((item, index) => <RecentDeviceRow favorite item={item} key={item.nodusId} onConnect={onConnect} onToggleFavorite={onToggleFavorite} tone={["blue", "red", "sunset", "forest"][index % 4] as DeviceTone} />)}</div> : <section className="favorites-empty"><Star aria-hidden="true" /><h2>Nenhum dispositivo favorito</h2><p>Adicione dispositivos aos favoritos para encontrá-los rapidamente aqui.</p><button className="secondary-button" onClick={onOpenDevices} type="button">Ver dispositivos <ArrowRight aria-hidden="true" size={16} /></button></section>}
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
  onOpenFiles,
  onToggleFavorite,
  statusLabel,
}: {
  identity: LocalIdentity;
  items: RecentDevice[];
  favorites: string[];
  nodusIdLabel: string;
  onAddDevice: () => void;
  onConnect: (nodusId: string) => void;
  onOpenFiles: () => void;
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
        <DeviceCard current identity={identity} nodusIdLabel={nodusIdLabel} onConnect={onConnect} onOpenFiles={onOpenFiles} statusLabel={statusLabel} tone="blue" />
        {visibleItems.map((item, index) => (
          <DeviceCard
            key={item.nodusId}
            favorite={favorites.includes(item.nodusId)}
            item={item}
            nodusIdLabel={formatNodusId(item.nodusId)}
            onConnect={onConnect}
            onOpenFiles={onOpenFiles}
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
  onOpenFiles,
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
  onOpenFiles: () => void;
  onToggleFavorite?: (nodusId: string) => void;
  statusLabel?: string;
  tone?: "blue" | "red" | "sunset" | "forest";
}) {
  const name = current ? identity?.deviceName ?? "Este computador" : item?.deviceName ?? "Dispositivo";
  const deviceInitial = name.trim().slice(0, 1).toLocaleUpperCase("pt-BR") || "N";
  const online = current || item?.status === "online";
  const nodusId = item?.nodusId ?? "";
  const lastAccess = current ? "agora" : new Date(item?.lastConnectionAt ?? Date.now()).toLocaleDateString("pt-BR");
  return (
    <article className={`device-card ${current ? "current-device" : ""}`}>
      <div className={`device-card-art tone-${tone}`}>
        <span className="device-card-initial" aria-hidden="true">{deviceInitial}</span>
      </div>
      <span className={online ? "device-online" : "device-offline"}><i /> {online ? (current ? statusLabel : "Online") : "Offline"}</span>
      {!current && <button className={favorite ? "device-favorite active" : "device-favorite"} onClick={() => onToggleFavorite?.(nodusId)} title={favorite ? "Remover dos favoritos" : "Adicionar aos favoritos"} type="button"><Star aria-hidden="true" size={17} fill={favorite ? "currentColor" : "none"} /></button>}
      <span className="device-menu" aria-hidden="true"><MoreHorizontal size={17} /></span>
      <strong>{name}</strong>
      <small>{nodusIdLabel}</small>
      <div className="device-card-meta"><span><Monitor aria-hidden="true" size={14} /> Windows</span><span><Clock3 aria-hidden="true" size={14} /> Último acesso: {lastAccess}</span></div>
      <button className={current ? "secondary-button device-access" : "device-access"} disabled={current} onClick={() => !current && onConnect(nodusId)} type="button">{current ? "Este computador" : "Acessar"}<ArrowRight aria-hidden="true" size={15} /></button>
      <div className="device-quick-actions">
        <button onClick={onOpenFiles} title="Abrir transferência de arquivos" type="button"><FolderOpen aria-hidden="true" size={15} /><span>Arquivos</span></button>
        <button disabled title="Terminal estará disponível em uma próxima sessão" type="button"><MonitorUp aria-hidden="true" size={15} /><span>Terminal</span></button>
        <button disabled title="Mais ações em breve" type="button"><MoreHorizontal aria-hidden="true" size={17} /><span>Mais</span></button>
      </div>
    </article>
  );
}

function SystemStatusCard({ onViewMore, serviceState, statusLabel }: { onViewMore: () => void; serviceState: ServiceState; statusLabel: string }) {
  return <section className="system-status-card">
    <div className="section-heading"><h2>Status do Sistema</h2><button className="panel-action" onClick={onViewMore} type="button">Ver mais <ArrowRight aria-hidden="true" size={15} /></button></div>
    <div className="system-check"><CheckCircle2 aria-hidden="true" size={16} /> Serviço Nodus <b>{statusLabel}</b></div>
    <div className="system-check"><LockKeyhole aria-hidden="true" size={16} /> Conexão protegida <b>{serviceState === "online" ? "Estável" : statusLabel}</b></div>
  </section>;
}

function ConnectBox({
  compact = false,
  feedback,
  onSubmit,
  onTargetChange,
  outgoingRequest,
  recentDevices = [],
  targetId,
}: {
  compact?: boolean;
  feedback: string;
  onSubmit: (event: FormEvent) => void;
  onTargetChange: (value: string) => void;
  outgoingRequest: SessionRequestRecord | null;
  recentDevices?: RecentDevice[];
  targetId: string;
}) {
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
        />
      </label>
      <button disabled={Boolean(outgoingRequest)} type="submit">{outgoingRequest ? "Aguardando" : <><span>Conectar</span><ArrowRight aria-hidden="true" size={18} /></>}</button>
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
              <time>{new Date(entry.at).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}</time>
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
  controlReady,
  error,
  fileReady,
  hasRemoteStream,
  hasShareStream,
  onKeyInput,
  onClipboard,
  onDisconnect,
  onPointerButton,
  onPointerMove,
  onWheelInput,
  onRecord,
  onSendFile,
  metrics,
  recording,
  remoteVideoRef,
  session,
  shareVideoRef,
  transfers,
  remoteResolution,
  remoteDisplays,
  remoteAudioMuted,
  adminRequest,
  onResolutionChange,
  onDisplayChange,
  onToggleRemoteAudio,
  onRequestAdmin,
  onResolveAdmin,
}: {
  controlReady: boolean;
  error: string;
  fileReady: boolean;
  metrics: SessionMetrics;
  recording: boolean;
  hasRemoteStream: boolean;
  hasShareStream: boolean;
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
  shareVideoRef: RefObject<HTMLVideoElement | null>;
  transfers: FileTransferRecord[];
  remoteResolution: RemoteResolution;
  remoteDisplays: CaptureSource[];
  remoteAudioMuted: boolean;
  adminRequest?: string;
  onResolutionChange: (value: RemoteResolution) => void;
  onDisplayChange: (value: string) => void;
  onToggleRemoteAudio: () => void;
  onRequestAdmin: () => void;
  onResolveAdmin: (approved: boolean) => void;
}) {
  const isViewer = session.role === "viewer";
  const [inspectorTab, setInspectorTab] = useState<"controls" | "connection" | "files">(isViewer ? "controls" : "connection");
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
  return (
    <section className="remote-session viewer-session">
      <header className="remote-header">
        <div className="remote-brand"><div className="remote-mark">N</div><strong>NODUS <span>Connect</span></strong></div>
        <div className="remote-peer"><Monitor aria-hidden="true" size={24} /><div><strong>{session.remoteName}</strong><small>{isViewer ? "Acesso remoto em andamento" : "Sua tela esta sendo compartilhada"}</small></div></div>
        <div className="remote-chips"><span><CheckCircle2 aria-hidden="true" size={14} /> Conectado</span><span><Link aria-hidden="true" size={14} /> {metrics.route === "relay" ? "Relay" : "P2P"}</span><span><Activity aria-hidden="true" size={14} /> {metrics.latencyMs ? `${metrics.latencyMs} ms` : "Medindo"}</span><span><Gauge aria-hidden="true" size={14} /> {metrics.fps ? `${metrics.fps} FPS` : "Imagem"}</span></div>
        <div className="remote-top-actions"><button className="danger-button remote-end" onClick={onDisconnect} type="button">Encerrar sessao</button></div>
      </header>
      <div className="remote-layout">
        <div className="remote-stage">
          <div
            className={isViewer ? "video-shell control-surface remote-viewer-surface" : "video-shell host-share-surface"}
            onContextMenu={(event) => event.preventDefault()}
            onKeyDown={(event) => onKeyInput("keyDown", event)}
            onKeyUp={(event) => onKeyInput("keyUp", event)}
            onMouseDown={(event) => onPointerButton("mouseDown", event)}
            onMouseMove={onPointerMove}
            onMouseUp={(event) => onPointerButton("mouseUp", event)}
            onWheel={onWheelInput}
            tabIndex={isViewer ? 0 : -1}
          >
            {isViewer ? <video ref={remoteVideoRef} autoPlay playsInline /> : <video ref={shareVideoRef} autoPlay muted playsInline />}
            {isViewer && !hasRemoteStream && <p>Aguardando imagem do outro computador...</p>}
            {!isViewer && !hasShareStream && <p>Preparando compartilhamento da sua tela...</p>}
          </div>
          {isViewer && <nav className="remote-command-bar" aria-label="Ações da sessão">
            <button className="active" onClick={() => setInspectorTab("controls")} type="button"><MonitorUp aria-hidden="true" size={18} /><span>Monitores</span><small>{remoteDisplays.length || 1}</small></button>
            <button onClick={() => setInspectorTab("connection")} type="button"><Gauge aria-hidden="true" size={18} /><span>Qualidade</span><small>{qualityLabel(metrics.quality)}</small></button>
            <button onClick={onToggleRemoteAudio} type="button"><Volume2 aria-hidden="true" size={18} /><span>Áudio</span><small>{remoteAudioMuted ? "Silenciado" : "Ativo"}</small></button>
            <button onClick={() => setInspectorTab("controls")} type="button"><Keyboard aria-hidden="true" size={18} /><span>Teclado</span><small>Controle</small></button>
            <button onClick={onClipboard} type="button"><Clipboard aria-hidden="true" size={18} /><span>Área de transf.</span></button>
            <button onClick={() => setInspectorTab("files")} type="button"><FolderOpen aria-hidden="true" size={18} /><span>Arquivos</span></button>
            <button onClick={onRecord} type="button"><Radio aria-hidden="true" size={18} /><span>Gravação</span><small>{recording ? "Ativa" : ""}</small></button>
            <button onClick={() => setInspectorTab("connection")} type="button"><MoreHorizontal aria-hidden="true" size={18} /><span>Mais</span></button>
          </nav>}
        </div>
        <aside className="remote-inspector">
          <div className="inspector-tabs" role="tablist" aria-label="Ferramentas da sessão">
            {isViewer && <button className={inspectorTab === "controls" ? "active" : ""} onClick={() => setInspectorTab("controls")} role="tab" type="button"><MonitorCog aria-hidden="true" size={18} />Controles</button>}
            <button className={inspectorTab === "connection" ? "active" : ""} onClick={() => setInspectorTab("connection")} role="tab" type="button"><Activity aria-hidden="true" size={18} />Conexão</button>
            {isViewer && <button className={inspectorTab === "files" ? "active" : ""} onClick={() => setInspectorTab("files")} role="tab" type="button"><FolderOpen aria-hidden="true" size={18} />Arquivos</button>}
          </div>
          {isViewer && inspectorTab === "controls" && <section className="inspector-card session-tools"><h3>Controles remotos</h3>
            <label className="session-tool-field"><Monitor aria-hidden="true" size={17} /><span>Resolução</span><select value={remoteResolution} onChange={(event) => onResolutionChange(event.target.value as RemoteResolution)}><option value="1366x768">1366 x 768</option><option value="1280x720">1280 x 720</option><option value="1920x1080">1920 x 1080</option><option value="1024x768">1024 x 768</option></select></label>
            {remoteDisplays.length > 1 && <label className="session-tool-field"><MonitorUp aria-hidden="true" size={17} /><span>Monitor</span><select defaultValue="" onChange={(event) => event.target.value && onDisplayChange(event.target.value)}><option value="">Selecionar</option>{remoteDisplays.map((display, index) => <option key={display.id} value={display.id}>Monitor {index + 1}</option>)}</select></label>}
            <div className="session-tool-grid"><button onClick={onToggleRemoteAudio} type="button">{remoteAudioMuted ? <VolumeX aria-hidden="true" size={18} /> : <Volume2 aria-hidden="true" size={18} />}<span>{remoteAudioMuted ? "Ativar som" : "Silenciar som"}</span></button><button onClick={onClipboard} type="button"><Clipboard aria-hidden="true" size={18} /><span>Área de transf.</span></button><button onClick={onRecord} type="button"><Radio aria-hidden="true" size={18} /><span>{recording ? "Parar gravação" : "Gravar sessão"}</span></button><button onClick={onRequestAdmin} type="button"><ShieldCheck aria-hidden="true" size={18} /><span>Solicitar admin</span></button></div>
            <p className="session-tool-note">A autorização de administrador é confirmada pelo proprietário no próprio Windows.</p>
          </section>}
          {inspectorTab === "connection" && <section className="inspector-card"><h3>Status da conexão</h3><div className="connection-quality"><CheckCircle2 aria-hidden="true" size={20} /><div><strong>{qualityLabel(metrics.quality)}</strong><span>{controlReady || !isViewer ? "Conexão ativa e protegida." : "Preparando controle remoto."}</span></div></div><dl><div><dt>Latência</dt><dd>{metrics.latencyMs ? `${metrics.latencyMs} ms` : "-"}</dd></div><div><dt>FPS</dt><dd>{metrics.fps || "-"}</dd></div><div><dt>Bitrate</dt><dd>{metrics.bitrateKbps ? formatBitrate(metrics.bitrateKbps) : "-"}</dd></div><div><dt>Perda de pacotes</dt><dd>{metrics.packetLossPct ? `${metrics.packetLossPct}%` : "0%"}</dd></div><div><dt>Rota</dt><dd>{metrics.route === "relay" ? "Relay TURN" : metrics.route === "direct" ? "P2P" : "Verificando"}</dd></div><div><dt>Codec</dt><dd>{metrics.codec || "WebRTC"}</dd></div><div><dt>Resolução</dt><dd>{remoteResolution.replace("x", " x ")}</dd></div></dl></section>}
          {isViewer && inspectorTab === "files" && <section className="inspector-card transfer-card"><h3>Transferência de arquivos</h3><label className={fileReady ? "session-upload" : "session-upload disabled"}><FileUp aria-hidden="true" size={18} />Enviar arquivo<input disabled={!fileReady} type="file" onChange={(event) => { const file = event.currentTarget.files?.[0]; if (file) onSendFile(file); event.currentTarget.value = ""; }} /></label>{transfers.length === 0 ? <p>Nenhuma transferência nesta sessão.</p> : transfers.slice(0, 4).map((item) => <div className="session-transfer-item" key={item.id}><div><strong>{item.fileName}</strong><span>{fileStatusLabel(item)} · {formatBytes(item.size)}</span></div>{item.url && <a download={item.fileName} href={item.url}>Baixar</a>}</div>)}</section>}
          {!isViewer && adminRequest && <section className="inspector-card admin-request"><h3>Administrador solicitado</h3><p>{adminRequest} pediu permissão de administrador para esta sessão.</p><div><button onClick={() => onResolveAdmin(false)} type="button">Recusar</button><button onClick={() => onResolveAdmin(true)} type="button">Autorizar no Windows</button></div></section>}
          {error && <p className="feedback">{error}</p>}
        </aside>
      </div>
      <footer className="remote-footer"><span>{isViewer ? "Clique na tela remota para controlar mouse e teclado." : "O compartilhamento continua ativo ate o encerramento da sessao."}</span><span><ShieldCheck aria-hidden="true" size={15} /> Conexao criptografada</span></footer>
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
                <div><dt>FPS</dt><dd>{metrics.fps || "Calculando..."}</dd></div>
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
                  {item.nodusId} - {new Date(item.lastConnectionAt).toLocaleString("pt-BR")}
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
  captureSources,
  serviceStatus,
  onInstallService,
  onUninstallService,
  onStartService,
  onStopService,
  settings,
  updateSettings,
}: {
  captureSources: CaptureSource[];
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
  const [section, setSection] = useState<"general" | "access" | "connection" | "appearance">("general");
  const dirty = JSON.stringify(draft) !== JSON.stringify(settings);
  const updateDraft = (patch: Partial<LocalSettings>) => setDraft((current) => ({ ...current, ...patch }));

  useEffect(() => {
    setDraft(settings);
  }, [settings]);

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
            <Switch checked={draft.showNodusId} icon={Monitor} label="Mostrar meu status como online" description="Exibe este computador para conexões autorizadas." onChange={(value) => updateDraft({ showNodusId: value })} />
            <Switch checked={draft.confirmBeforeDisconnect} icon={ShieldCheck} label="Confirmar antes de encerrar" description="Evita o encerramento acidental de uma sessão." onChange={(value) => updateDraft({ confirmBeforeDisconnect: value })} />
          </SettingsGroup>
          <SettingsGroup icon={RefreshCw} title="Atualizações" description="Mantenha o Nodus sempre atualizado.">
            <div className="update-row"><span>Versão atual: 0.4.0</span></div>
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
            <small className="note">Pedidos sem a senha correta nao serao aceitos.</small>
          </div>
          <label className="settings-field">Senha para acessar outros Nodus
            <input
              autoComplete="current-password"
              type="password"
              value={draft.remoteAccessPassword}
              onChange={(event) => updateDraft({ remoteAccessPassword: event.target.value })}
              placeholder="Senha usada nos acessos de saida"
            />
          </label>
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
              <option value={15}>Economico</option><option value={30}>Suave</option><option value={60}>Muito suave</option>
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
          <label className="appearance-language"><span><Globe2 />Idioma</span><select value={draft.language} onChange={(event) => updateDraft({ language: event.target.value as "pt-BR" })}><option value="pt-BR">Português (Brasil)</option></select></label>
        </section>}
      </div>
      <div className="settings-actions">
        <button className="secondary-button" disabled={!dirty} onClick={() => setDraft(settings)} type="button">
          Descartar
        </button>
        <button disabled={!dirty} onClick={() => updateSettings(draft)} type="button">
          Salvar
        </button>
      </div>
    </section>
  );
}

function directionLabel(value: AccessLogEntry["direction"]): string {
  return value === "outgoing" ? "saida" : "entrada";
}

function fileStatusLabel(item: FileTransferRecord): string {
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
  return { bitrateKbps: 0, fps: 0, latencyMs: 0, route: "unknown", quality: "balanced", codec: "", packetLossPct: 0 };
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

function preferDesktopCodecs(transceiver: RTCRtpTransceiver, lightweight: boolean) {
  const capabilities = RTCRtpReceiver.getCapabilities("video");
  if (!capabilities?.codecs.length || !transceiver.setCodecPreferences) return;
  const preferred = lightweight ? ["h264", "vp8", "vp9", "av1"] : ["vp9", "h264", "av1", "vp8"];
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
