import type { SupportProfile } from "../../../packages/common/src/quick-support";
declare const support: {
  validateProfile(value: unknown): SupportProfile;
  passwordVerifier(password: string): Promise<SupportProfile["passwordVerifier"]>;
  verifyPassword(password: unknown, verifier: SupportProfile["passwordVerifier"]): Promise<boolean>;
  signProfile(profile: SupportProfile, key: string): string;
  verifyProfile(token: string, key: string): SupportProfile;
  readProfile(executable: string, key: string): SupportProfile;
  appendProfile(source: string, destination: string, token: string, key: string): SupportProfile;
};
export = support;
