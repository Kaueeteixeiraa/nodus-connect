import { useEffect, useRef, useState } from "react";
import { KeyRound, RefreshCw, ExternalLink, ShieldCheck } from "lucide-react";
import { LICENSE_MESSAGES, type LicenseInfo } from "../../../packages/licensing/src/index";
import { activateLicense, checkLicense, licenseConfigured, licenseFeedback, prepareOfflineLicense } from "./core/licensing";
import type { LocalIdentity } from "./core/identity";

export default function LicensePanel({ identity }: { identity: LocalIdentity }) {
  const [info, setInfo] = useState<LicenseInfo | null>(null), [key, setKey] = useState(""), [target, setTarget] = useState(""), [busy, setBusy] = useState<"refresh" | "activate" | "offline" | null>(null), [feedback, setFeedback] = useState("");
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
  return <section className="license-panel" aria-labelledby="license-heading">
    <header><ShieldCheck aria-hidden="true" /><h2 id="license-heading">Controle da empresa</h2></header>
    {!licenseConfigured() ? <p>O vínculo empresarial está indisponível neste momento.</p> : <>
      {info && <dl><dt>Perfil</dt><dd>{info.plan === "business" ? "Empresarial" : "Uso pessoal gratuito"}</dd><dt>Autorização</dt><dd>{info.allowed ? "Disponível" : "Requer atenção"}</dd>
        {info.plan === "free" ? <><dt>Empresa</dt><dd>Não vinculado</dd><dt>Tempo por sessão</dt><dd>Até 10 minutos</dd></> : <><dt>Empresa</dt><dd>{info.organization}</dd><dt>Dispositivos vinculados</dt><dd>{info.devices} / {info.maxDevices}</dd><dt>Sessões em andamento</dt><dd>{info.sessions} / {info.maxConcurrentSessions}</dd><dt>Tempo por sessão</dt><dd>Sem limite de tempo</dd><dt>Token da empresa</dt><dd translate="no">{info.keyMasked}</dd></>}
      </dl>}
      {info && !info.allowed && <p role="status">{LICENSE_MESSAGES[info.code]}</p>}
      <p>Para manter o registro do computador após reinstalações, identificadores técnicos são transformados criptograficamente antes do envio ao servidor. O vínculo e o histórico de uso permanecem após a desinstalação. Você pode solicitar revisão pelo suporte.</p>
      <button className="themed-action" disabled={busy === "refresh"} aria-disabled={Boolean(busy)} aria-busy={busy === "refresh"} onClick={() => run("refresh", () => checkLicense(identity))} type="button"><RefreshCw aria-hidden="true" size={16} className={busy === "refresh" ? "spinning" : ""} />Atualizar vínculo</button>
      <label>Token da empresa<input autoComplete="off" maxLength={128} placeholder="NODUS-…" value={key} onChange={event => setKey(event.target.value)} /></label>
      <button className="themed-action" disabled={busy === "activate" || !key.trim()} aria-disabled={Boolean(busy) || !key.trim()} aria-busy={busy === "activate"} onClick={() => run("activate", () => activateLicense(identity, key))} type="button"><KeyRound aria-hidden="true" size={16} />Participar da empresa</button>
      {info?.plan === "business" && <><label>Nodus ID para autorização offline<input inputMode="numeric" maxLength={9} value={target} onChange={event => setTarget(event.target.value.replace(/\D/g, ""))} /></label><button className="themed-action" disabled={busy === "offline" || target.length !== 9} aria-disabled={Boolean(busy) || target.length !== 9} aria-busy={busy === "offline"} onClick={() => run("offline", async () => { await prepareOfflineLicense(identity, target); setFeedback("Autorização offline preparada para este dispositivo."); })} type="button"><ShieldCheck aria-hidden="true" size={16} />Preparar autorização offline</button></>}
    </>}
    <button className="themed-action" onClick={() => window.nodusDesktop?.openExternal("https://nodus-connect-download.vercel.app/licen%C3%A7a")} type="button"><ExternalLink aria-hidden="true" size={16} />Apoiar o projeto</button>
    {feedback && <p role="status">{feedback}</p>}
  </section>;
}
