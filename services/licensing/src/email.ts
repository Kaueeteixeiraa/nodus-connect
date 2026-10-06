import type { LicenseAccessRequest } from "../../../packages/licensing/src/index.js";

export async function notifyAccessRequest(request: LicenseAccessRequest): Promise<boolean> {
  const apiKey = process.env.RESEND_API_KEY, from = process.env.LICENSE_EMAIL_FROM, to = process.env.LICENSE_ADMIN_EMAIL, adminUrl = process.env.LICENSE_ADMIN_URL;
  if (!apiKey || !from || !to || !adminUrl) return false;
  const reviewUrl = new URL(adminUrl); reviewUrl.searchParams.set("request", request.id);
  const response = await fetch("https://api.resend.com/emails", { method: "POST", headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json", "idempotency-key": request.id }, body: JSON.stringify({ from, to: [to], subject: "Nodus Connect: solicitação de mais 200 acessos", html: `<p>Um usuário solicitou mais 200 acessos.</p><p><a href="${reviewUrl}">Revisar solicitação no Nodus Admin</a></p>` }), signal: AbortSignal.timeout(10_000) });
  return response.ok;
}
