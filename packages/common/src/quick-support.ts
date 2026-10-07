export type SupportPermission = "screen:view" | "mouse:control" | "keyboard:control" | "clipboard:sync" | "files:transfer" | "audio:remote";
export interface SupportProfile {
  version: 1; id: string; organizationId: string; licenseId: string; name: string; company: string;
  message: string; logo: string; permissions: SupportPermission[]; confirmation: boolean;
  passwordVerifier: { salt: string; hash: string; iterations: number }; createdAt: number;
  template?: { version: string; sha256: string };
}
export interface SupportDraft {
  name: string; company: string; message: string; logo: string; permissions: SupportPermission[];
  confirmation: boolean; password: string;
}
