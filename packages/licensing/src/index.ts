export const LICENSE_DEFAULTS = Object.freeze({ freeAccessLimit: 200, businessPriceCents: 20_000, maxDevices: 20, maxConcurrentSessions: 5, offlineGraceHours: 24, gracePeriodDays: 2, reservationSeconds: 120, heartbeatSeconds: 30 });
export const FREE_SESSION_LIMIT_MS = 10 * 60_000;
export type LicenseStatus = "TRIAL" | "ACTIVE" | "PAST_DUE" | "GRACE_PERIOD" | "SUSPENDED" | "CANCELED" | "EXPIRED";
export type LicenseCode = "LICENSE_ACTIVE" | "LICENSE_EXPIRED" | "LICENSE_SUSPENDED" | "PAYMENT_OVERDUE" | "DEVICE_LIMIT_REACHED" | "CONCURRENT_LIMIT_REACHED" | "LICENSE_REVOKED" | "DEVICE_REVOKED" | "INVALID_LICENSE" | "SERVER_UNAVAILABLE" | "TRIAL_LIMIT_REACHED" | "INVALID_INPUT" | "UNAUTHORIZED" | "FORBIDDEN" | "REAUTH_REQUIRED" | "SESSION_EXPIRED" | "FREE_SESSION_LIMIT_REACHED" | "SESSION_RECONCILIATION_REQUIRED" | "ROLLOUT_NOT_READY" | "DEVICE_REVIEW_REQUIRED";
export class LicenseError extends Error { constructor(public readonly code: LicenseCode) { super(code); } }
export type LicensePolicy = { enforced: boolean; identityEnabled?: boolean; allowNewIdentities?: boolean } & { -readonly [K in keyof typeof LICENSE_DEFAULTS]: number };
export interface NodusDeviceIdentity { version: 1; anchors: Partial<Record<"system" | "board" | "bios", string>>; virtual: boolean; }
export interface DeviceLicenseIdentity { id: string; freeLicenseId: string; version: 1; status: "ACTIVE" | "BLOCKED"; anchors: string[]; createdAt: number; schemaVersion: 1; }
export interface IdentityReview { deviceId: string; uid: string; candidates: string[]; anchors: string[]; reason: string; status: "PENDING" | "RESOLVED"; createdAt: number; }
export interface DesktopUpdatePolicy {
  enabled: boolean; updatedAt: number;
  release: { tag_name: string; assets: { name: string; browser_download_url: string; digest: string; size: number }[]; draft?: boolean; prerelease?: boolean } | null;
}
export interface Slot { deviceId: string; expiresAt: number; established: boolean; offline: boolean; endsAt?: number; }
export interface License {
  id: string; organizationId: string; plan: "free" | "business"; status: LicenseStatus;
  maxDevices: number; maxConcurrentSessions: number; trialLimit: number; trialUsed: number;
  expiresAt: number; graceUntil: number; deviceIds: string[]; slots: Record<string, Slot>;
  keyLast4: string; keyHash: string; keyRevoked: boolean; createdAt: number; updatedAt: number;
}
export interface LicenseDevice { id: string; licenseId: string; uid: string; nodusId: string; deviceName: string; claimHash: string; tokenHash: string; status: "ACTIVE" | "REVOKED" | "BLOCKED"; activatedAt: number; lastSeenAt: number; deviceIdentityId?: string; identityReview?: boolean; freeLicenseId?: string; lastAuthorizedAccessAt?: number; }
export interface LicenseAccessRequest { id: string; licenseId: string; deviceId: string; uid: string; amount: number; status: "PENDING" | "APPROVED" | "DENIED"; notificationStatus: "PENDING" | "SENT" | "FAILED"; createdAt: number; updatedAt: number; resolvedAt: number; adminUserId: string; }
export interface LicenseSession { id: string; licenseId: string; deviceId: string; requesterUid: string; targetUid: string; requesterNodusId: string; targetNodusId: string; status: "RESERVED" | "ESTABLISHED" | "ENDED"; connectedUids: string[]; consumed: boolean; createdAt: number; establishedAt: number; lastHeartbeatAt: number; endedAt: number; expiresAt: number; offline: boolean; endsAt?: number; eventDriven?: boolean; }
export interface LicenseInfo { allowed: boolean; code: LicenseCode; enforced: boolean; plan: "free" | "business"; status: LicenseStatus; organization: string; trialUsed: number; trialLimit: number; devices: number; maxDevices: number; sessions: number; maxConcurrentSessions: number; expiresAt: number; keyMasked: string; serverTime: number; }
export interface LeaseClaims { iss: "nodus-license"; aud: "nodus-session"; sessionId: string; deviceId: string; requesterUid: string; targetUid: string; requesterNodusId: string; targetNodusId: string; iat: number; exp: number; }
export function effectiveStatus(license: License, now: number): LicenseStatus {
  if (license.plan === "free" || ["SUSPENDED", "CANCELED", "EXPIRED"].includes(license.status)) return license.status;
  if (now < license.expiresAt) return "ACTIVE";
  return now < license.graceUntil ? "GRACE_PERIOD" : "SUSPENDED";
}
export function licenseCode(license: License, now: number): LicenseCode {
  if (license.status === "CANCELED") return "LICENSE_REVOKED";
  if (license.plan === "free") return license.trialUsed >= license.trialLimit ? "TRIAL_LIMIT_REACHED" : "LICENSE_ACTIVE";
  const status = effectiveStatus(license, now);
  if (status === "ACTIVE" || status === "GRACE_PERIOD") return "LICENSE_ACTIVE";
  return status === "EXPIRED" ? "LICENSE_EXPIRED" : status === "PAST_DUE" ? "PAYMENT_OVERDUE" : "LICENSE_SUSPENDED";
}
export const LICENSE_MESSAGES: Record<LicenseCode, string> = {
  DEVICE_REVIEW_REQUIRED: "Este computador precisa de uma revisão de licença. Entre em contato com o suporte para recuperar seus acessos.",
  FREE_SESSION_LIMIT_REACHED: "Sessão encerrada: o plano gratuito permite até 10 minutos por acesso remoto. Ative o Nodus Business para continuar sem esse limite.",
  LICENSE_ACTIVE: "Licença ativa.", LICENSE_EXPIRED: "Licença expirada. Regularize a assinatura para iniciar novas conexões.", LICENSE_SUSPENDED: "Licença suspensa. Regularize a assinatura para iniciar novas conexões.", PAYMENT_OVERDUE: "Pagamento pendente.",
  DEVICE_LIMIT_REACHED: "Limite de dispositivos atingido. Solicite a remoção de um dispositivo antigo.", CONCURRENT_LIMIT_REACHED: "Limite de sessões simultâneas atingido.", LICENSE_REVOKED: "Licença revogada.", DEVICE_REVOKED: "Dispositivo revogado ou bloqueado.", INVALID_LICENSE: "Chave ou licença inválida.",
  SERVER_UNAVAILABLE: "Não foi possível validar a licença. Tente novamente quando o servidor estiver disponível.", TRIAL_LIMIT_REACHED: "Você utilizou os 200 acessos gratuitos deste computador. Para continuar utilizando o Nodus Connect, ative um plano.", INVALID_INPUT: "Verifique os dados informados.", UNAUTHORIZED: "Autenticação necessária.", FORBIDDEN: "Operação não autorizada.", REAUTH_REQUIRED: "Entre novamente para confirmar esta operação.", SESSION_EXPIRED: "Autorização da sessão expirada.", SESSION_RECONCILIATION_REQUIRED: "Há uma sessão sem confirmação de encerramento. Atualize a licença antes de iniciar outra.", ROLLOUT_NOT_READY: "O bloqueio comercial ainda não foi homologado.",
};
