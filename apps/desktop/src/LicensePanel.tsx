import { useEffect, useRef, useState } from "react";
import { KeyRound, RefreshCw, ExternalLink, MailPlus, ShieldCheck } from "lucide-react";
import { LICENSE_MESSAGES, type LicenseInfo } from "../../../packages/licensing/src/index";
import { activateLicense, checkLicense, licenseConfigured, licenseFeedback, prepareOfflineLicense, requestMoreAccesses } from "./core/licensing";
import type { LocalIdentity } from "./core/identity";

export default function LicensePanel({ identity }: { identity: LocalIdentity }) {
  const [info, setInfo] = useState<LicenseInfo | null>(null), [key, setKey] = useState(""), [target, setTarget] = useState(""), [busy, setBusy] = useState<"refresh" | "request" | "activate" | "offline" | null>(null), [feedback, setFeedback] = useState("");
  const running = useRef(false);
  useEffect(() => {
    if (!licenseConfigured()) return;
    let active = true;
    let pending = false;
    const refresh = async () => {
      if (pending) return;
      pending = true;
      try { const value = await checkLicense(identity); if (active) { setInfo(value); setFeedback(""); } }
      catch (error) { if (active) setFeedback(licenseFeedback(error)); }
      finally { pending = false; }
    };
    void refresh();
    window.addEventListener("nodus:license-changed", refresh);
    window.addEventListener("focus", refresh);
    return () => { active = false; window.removeEventListener("nodus:license-changed", refresh); window.removeEventListener("focus", refresh); };
  }, [identity]);
  async function run(name: NonNullable<typeof busy>, action: () => Promise<LicenseInfo | void>) {
    if (running.current) return; running.current = true; setBusy(name); setFeedback("");
    try { const result = await action(); if (result) setInfo(result); } catch (error) { setFeedback(licenseFeedback(error)); } finally { if (name === "activate") setKey(""); running.current = false; setBusy(null); }
  }
  const remaining = info ? Math.max(0, info.trialLimit - info.trialUsed) : 0;
  return <section className="license-panel" aria-labelledby="license-heading">
    <header><ShieldCheck aria-hidden="true" /><h2 id="license-heading">Conta e Licença</h2></header>
    {!licenseConfigured() ? <p>Licenciamento ainda não configurado. O funcionamento atual do Nodus foi preservado.</p> : <>
      {info && <dl><dt>Plano</dt><dd>{info.plan === "business" ? "Nodus Business" : "Nodus Free"}</dd><dt>Status</dt><dd>{info.status}</dd>
        {info.plan === "free" ? <><dt>Acessos</dt><dd>Plano gratuito — {info.trialUsed} de {info.trialLimit} acessos utilizados<progress aria-label="Acessos gratuitos utilizados" max={Math.max(1, info.trialLimit)} value={info.trialUsed} />{remaining} conexões restantes</dd><dt>Tempo por sessão</dt><dd>Até 10 minutos</dd></> : <><dt>Licenciado para</dt><dd>{info.organization}</dd><dt>Dispositivos</dt><dd>{info.devices} / {info.maxDevices}</dd><dt>Sessões</dt><dd>{info.sessions} / {info.maxConcurrentSessions}</dd><dt>Renovação</dt><dd>{new Date(info.expiresAt).toLocaleDateString()}</dd><dt>Chave</dt><dd translate="no">{info.keyMasked}</dd></>}
      </dl>}
      {info && (!info.allowed || (info.plan === "free" && remaining <= 50)) && <p role="status">{info.allowed ? `${remaining} conexões gratuitas restantes.` : LICENSE_MESSAGES[info.code]}</p>}
      {info?.plan === "free" && info.code === "TRIAL_LIMIT_REACHED" && <p role="status">O período de teste foi concluído. Solicite mais acessos ou adquira uma licença. Você pode continuar recebendo acesso remoto.</p>}
      <p>Para preservar a franquia após reinstalações, identificadores técnicos do computador são transformados criptograficamente antes do envio ao servidor. O vínculo e o histórico de uso permanecem após a desinstalação. Você pode solicitar revisão pelo suporte.</p>
      <button className="themed-action" disabled={busy === "refresh"} aria-disabled={Boolean(busy)} aria-busy={busy === "refresh"} onClick={() => run("refresh", () => checkLicense(identity))} type="button"><RefreshCw aria-hidden="true" size={16} className={busy === "refresh" ? "spinning" : ""} />Atualizar licença</button>
      {info?.plan === "free" && <button className="themed-action" disabled={busy === "request"} aria-disabled={Boolean(busy)} aria-busy={busy === "request"} onClick={() => run("request", async () => { const result = await requestMoreAccesses(identity); setFeedback(result.notificationStatus !== "SENT" ? "Solicitação registrada no painel. O envio do e-mail não foi confirmado." : result.duplicate ? "Sua solicitação já está aguardando análise." : "Solicitação enviada. Você receberá a liberação após a aprovação."); })} type="button"><MailPlus aria-hidden="true" size={16} />Solicitar mais 200 acessos</button>}
      <label>Chave empresarial<input autoComplete="off" maxLength={128} placeholder="NODUS-…" value={key} onChange={event => setKey(event.target.value)} /></label>
      <button className="themed-action" disabled={busy === "activate" || !key.trim()} aria-disabled={Boolean(busy) || !key.trim()} aria-busy={busy === "activate"} onClick={() => run("activate", () => activateLicense(identity, key))} type="button"><KeyRound aria-hidden="true" size={16} />Ativar Nodus Business</button>
      {info?.plan === "business" && <><label>Nodus ID para autorização offline<input inputMode="numeric" maxLength={9} value={target} onChange={event => setTarget(event.target.value.replace(/\D/g, ""))} /></label><button className="themed-action" disabled={busy === "offline" || target.length !== 9} aria-disabled={Boolean(busy) || target.length !== 9} aria-busy={busy === "offline"} onClick={() => run("offline", async () => { await prepareOfflineLicense(identity, target); setFeedback("Autorização offline preparada para este dispositivo."); })} type="button"><ShieldCheck aria-hidden="true" size={16} />Preparar autorização offline</button></>}
    </>}
    <button className="themed-action" onClick={() => window.nodusDesktop?.openExternal("https://nodus-connect-download.vercel.app")} type="button"><ExternalLink aria-hidden="true" size={16} />Site oficial</button>
    {feedback && <p role="status">{feedback}</p>}
  </section>;
}
