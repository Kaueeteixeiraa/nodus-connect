/// <reference types="vite/client" />

interface Window {
  nodusDesktop?: {
    setTrayIdentity(identity: { nodusId: string; deviceName: string; status: string }): void;
    getIdentity(): Promise<unknown>;
    saveIdentity(identity: unknown): Promise<void>;
    getServerInfo(): Promise<{ port: number; urls: string[] }>;
    getAppInfo(): Promise<{ version: string; googleClientConfigured?: boolean }>;
    getNativeCaptureStatus(): Promise<{ available: boolean; supported: boolean; backend?: string }>;
    getServiceStatus(): Promise<{ installed: boolean; running: boolean }>;
    installService(): Promise<{ ok: boolean; error?: string }>;
    uninstallService(): Promise<{ ok: boolean; error?: string }>;
    startService(): Promise<{ ok: boolean; error?: string }>;
    stopService(): Promise<{ ok: boolean; error?: string }>;
    setRemoteControlActive(active: boolean): Promise<void>;
    setStartupOptions(options: { startWithWindows: boolean; startMinimized: boolean }): Promise<void>;
    applyRemoteInput(input: unknown): Promise<{ ok: boolean; error?: string }>;
    getCaptureSources(): Promise<Array<{ id: string; name: string; displayId: string; width: number; height: number }>>;
    setCaptureOptions(options: { sourceId: string; displayId?: string; shareAudio: boolean }): Promise<void>;
    readClipboard(): Promise<string>;
    writeClipboard(text: string): Promise<void>;
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
  };
}
