import type { DesktopUpdatePolicy } from "../../../packages/licensing/src/index";
type Release = NonNullable<DesktopUpdatePolicy["release"]>;
declare const updates: {
  updateRelease(release: Release, currentVersion: string): { version: string; available: boolean; url: string; sha256: string; size: number };
  releaseCompanions(release: Release): { support: Release["assets"][number]; manifest: Release["assets"][number] } | null;
  signPolicy(policy: DesktopUpdatePolicy, key: string, now?: number): string;
  verifyPolicy(token: string, key: string, now?: number): DesktopUpdatePolicy & { issuedAt: number };
};
export = updates;
