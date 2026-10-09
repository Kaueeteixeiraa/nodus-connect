/// <reference types="vite/client" />

interface Window {
  nodusDesktop?: {
    iceDiagnosticsEnabled: boolean;
    setTrayIdentity(identity: { nodusId: string; deviceName: string; status: string }): void;
    getIdentity(legacyIdentity?: unknown): Promise<unknown>;
    getSupportProfile(): Promise<import("../../../packages/common/src/quick-support").SupportProfile | null>;
    generateSupportPackage(input: { token: string; template: { version: string; sha256: string } | null }): Promise<{ canceled?: boolean; path?: string }>;
    quit(): Promise<void>;
    saveIdentity(identity: unknown): Promise<unknown>;
    getLicenseIdentity(): Promise<import("../../../packages/licensing/src/index").NodusDeviceIdentity>;
    getLicenseCredentials(): Promise<{ deviceId: string; deviceToken: string; identityVersion?: number } | null>;
    saveLicenseCredentials(credentials: { deviceId: string; deviceToken: string; identityVersion?: number }): Promise<boolean>;
    getServerInfo(): Promise<{ port: number; urls: string[] }>;
    getAppInfo(): Promise<{ version: string; googleClientConfigured?: boolean }>;
    markUiReady?(): void;
    setThemeIcon(theme: string, dataUrl: string): Promise<boolean>;
    getPerformanceDiagnostic(): Promise<{ label: string; preset?: string | null; source?: "cli" | "env" | "json"; videoOnly: boolean; inputLatency?: boolean; inputOnly?: boolean; resolution?: string; fps?: number; bitrate?: number; maxFramerate?: number; scaleResolutionDownBy?: number; lockAdaptive: boolean; nativeResolution?: boolean; contentHint?: "detail" | "motion"; degradationPreference?: "maintain-resolution" | "maintain-framerate" } | null>;
    getNativeCaptureStatus(): Promise<{ available: boolean; supported: boolean; requestedBackend?: "chromium" | "wgc"; allowLegacyFallback?: boolean; nativeMediaExperimental?: boolean; nativeMediaAvailable?: boolean; cursorSuppressionSupported?: boolean; backend?: string; d3d11Hardware?: boolean; hardwareH264?: boolean; hardwareH264Encoders?: number; adapter?: string }>;
    startNativeMedia(options: { sessionId: string; monitor: number; fps: number; bitrateKbps: number; width: number; height: number; shareAudio: boolean; iceServers: RTCIceServer[] }): Promise<{ backend: "wgc"; cursorCapture: false; encoderImplementation?: string; hardwareEncode?: boolean }>;
    signalNativeMedia(signal: { sessionId: string; type: "answer" | "candidate" | "bitrate"; sdp?: string; candidate?: string; sdpMLineIndex?: number; bitrateKbps?: number }): Promise<boolean>;
    stopNativeMedia(sessionId: string): Promise<void>;
    onNativeMediaSignal(callback: (signal: { sessionId: string; type: "offer" | "candidate" | "metrics" | "source" | "connected" | "error" | "exit"; sdp?: string; candidate?: string; sdpMLineIndex?: number; captureFrames?: number; encodeFrames?: number; encodeTimeUs?: number; encodeSamples?: number; encodeP95Ms?: number; rtpPackets?: number; rtpBytes?: number; width?: number; height?: number; message?: string }) => void): () => void;
    getGpuDiagnostics(): Promise<{ adapter: string; videoEncode: string; videoDecode: string; gpuCompositing: string; gpuProcessAvailable: boolean }>;
    getRenderDisplayInfo(viewport?: { devicePixelRatio: number; viewportWidth: number; viewportHeight: number }): Promise<{ displayId: string; displayWidth: number; displayHeight: number; refreshRateHz: number | null; scaleFactor: number; devicePixelRatio: number; viewportWidth: number; viewportHeight: number; fullscreen: boolean; rendererCpuPercent: number | null }>;
    getServiceStatus(): Promise<{ installed: boolean; running: boolean }>;
    installService(): Promise<{ ok: boolean; error?: string }>;
    uninstallService(): Promise<{ ok: boolean; error?: string }>;
    startService(): Promise<{ ok: boolean; error?: string }>;
    stopService(): Promise<{ ok: boolean; error?: string }>;
    setRemoteControlActive(active: boolean): Promise<void>;
    setHostInputLock(input: { sessionId: string; mouse: boolean; keyboard: boolean }): Promise<{ ok: boolean; mouse?: boolean; keyboard?: boolean; error?: string }>;
    setHostCursorActive(active: boolean, hideOnRemote?: boolean): Promise<void>;
    setRemoteKeyboardCapture(active: boolean): Promise<void>;
    toggleFullScreen(enabled?: boolean): Promise<boolean>;
    checkForUpdates(): Promise<{ ok: boolean; version?: string; available?: boolean; installing?: boolean; error?: string }>;
    setActiveSessionCount(count: number): void;
    onUpdateProgress(callback: (progress: { phase: "checking" | "downloading" | "installing"; percent: number }) => void): () => void;
    restartComputer(): Promise<{ ok: boolean; error?: string }>;
    sendSecureAttention(): Promise<{ ok: boolean; error?: string }>;
    setStartupOptions(options: { startWithWindows: boolean; startMinimized: boolean; minimizeToTray: boolean }): Promise<void>;
    applyRemoteInput(input: unknown): void;
    measureRemoteInput(input: unknown): Promise<{ ok: boolean; error?: string; positionConfirmed?: boolean; mainToWindowsAckMs?: number; windowsPosition?: { x: number; y: number } }>;
    getCaptureSources(): Promise<Array<{ id: string; name: string; displayId: string; width: number; height: number }>>;
    setCaptureOptions(options: { sourceId: string; displayId?: string; shareAudio: boolean }): Promise<void>;
    readClipboard(): Promise<string>;
    writeClipboard(text: string): Promise<void>;
    getConnectionPassword(nodusId: string): Promise<string>;
    saveConnectionPassword(nodusId: string, password: string): Promise<{ ok: boolean }>;
    openExternal(url: string): Promise<void>;
    saveReceivedFile(fileName: string, data: ArrayBuffer): Promise<{ ok: boolean; path?: string; name?: string; error?: string }>;
    wakeOnLan(macAddress: string): Promise<{ ok: boolean; error?: string }>;
    openDiagnostics(): Promise<void>;
    writeDiagnostic(message: string): Promise<void>;
    writePerformance(message: string): Promise<void>;
    googleLogin(options?: { clientId?: string }): Promise<
      | { ok: true; idToken?: string; accessToken?: string; user: { id: string; name: string; email?: string; picture?: string; provider: "google"; loggedAt: string } }
      | { ok: false; error: string }
    >;
    onGoogleLoginResult?(
      callback: (
        result:
          | { ok: true; idToken?: string; accessToken?: string; user: { id: string; name: string; email?: string; picture?: string; provider: "google"; loggedAt: string } }
          | { ok: false; error: string },
      ) => void,
    ): () => void;
    onRemoteKeyInput?(callback: (type: "keyDown" | "keyUp", input: { keyCode: number; code: string; location: number; repeat: boolean }) => void): () => void;
    onHostMouseActivity?(callback: (positions?: { displayId: string; x: number; y: number; visible: boolean }[]) => void): () => void;
    onOpenWorkspace?(callback: () => void): () => void;
  };
}
