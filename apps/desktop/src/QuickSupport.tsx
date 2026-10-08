import { useState, type ReactNode } from "react";
import { Check, Copy, Download, LoaderCircle, Pencil, Power, ShieldCheck, X } from "lucide-react";
import type { SupportDraft, SupportProfile, SupportPermission } from "../../../packages/common/src/quick-support";
import type { LocalIdentity } from "./core/identity";
import { checkLicense, createSupportProfile, licenseFeedback } from "./core/licensing";
import nodusLogo from "./assets/nodus-logo.png";

export { supportSettings } from "./core/storage";

export function QuickSupportView({ profile, nodusId, deviceName, onRename, ready, sessions, error, onEnd, onQuit, children }: {
  profile: SupportProfile; nodusId: string; deviceName: string; onRename: (name: string) => void;
  ready: boolean; sessions: { id: string; name: string; status: string; error?: string; connected?: boolean }[];
  error: string; onEnd: (id: string) => void; onQuit: () => void; children?: ReactNode;
}) {
  const [editing, setEditing] = useState(false), [name, setName] = useState(deviceName);
  return <main className="quick-support-shell" data-theme="dark">
    <header className="quick-support-brand"><img src={profile.logo || nodusLogo} alt="" /><div><strong translate="no">{profile.company}</strong><span translate="no">{profile.name}</span></div></header>
    <div className="quick-support-name"><span>Nome deste computador</span>{editing ?
      <form onSubmit={event => { event.preventDefault(); if (name.trim()) { onRename(name.trim()); setEditing(false); } }}>
        <input aria-label="Nome deste computador" autoFocus required maxLength={80} value={name} onChange={event => setName(event.target.value)} />
        <button className="icon-button" title="Salvar nome" aria-label="Salvar nome" disabled={!name.trim()} type="submit"><Check size={18} /></button>
        <button className="icon-button" title="Cancelar" aria-label="Cancelar" type="button" onClick={() => setEditing(false)}><X size={18} /></button>
      </form> : <div><strong translate="no">{deviceName}</strong><button className="icon-button" title="Alterar nome" aria-label="Alterar nome" type="button" onClick={() => { setName(deviceName); setEditing(true); }}><Pencil size={16} /></button></div>}
    </div>
    <section className="quick-support-content"><ShieldCheck aria-hidden="true" size={28} /><h1>Suporte remoto</h1>
      {profile.message && <p translate="no">{profile.message}</p>}
      <div className="quick-support-id"><span>Seu Nodus ID</span><strong>{nodusId}</strong><button className="icon-button" title="Copiar Nodus ID" aria-label="Copiar Nodus ID" onClick={() => window.nodusDesktop?.writeClipboard(nodusId)} type="button"><Copy size={18} /></button></div>
      <p className="quick-support-status" role="status">{sessions.length ? sessions.some(session => session.connected) ? "Suporte em andamento" : "Estabelecendo conexao com o tecnico..." : ready ? "Pronto para receber suporte. Aguardando tecnico..." : "Conectando ao servico..."}</p>
      {sessions.map(session => <div className="quick-support-session" key={session.id}><div><strong>{session.name}</strong><small>{session.status}</small>{session.error && <p role="alert">{session.error}</p>}</div><button className="danger-button" type="button" onClick={() => onEnd(session.id)}>Encerrar suporte</button></div>)}
      {error && <p role="alert">{error}</p>}
      <button className="secondary-button themed-action" type="button" onClick={onQuit}><Power size={16} /> Encerrar</button>
    </section><footer><img src={nodusLogo} alt="" /><span>Nodus Connect</span></footer>{children}
  </main>;
}

const OPTIONS: [SupportPermission[], string][] = [
  [["mouse:control", "keyboard:control"], "Permitir teclado e mouse"], [["clipboard:sync"], "Permitir area de transferencia"],
  [["files:transfer"], "Permitir arquivos"], [["audio:remote"], "Permitir audio"],
];
const STORE = "nodus.support-profile.v1";
function savedProfile(): { draft?: Omit<SupportDraft, "password">; token?: string; version?: string } {
  try { return JSON.parse(localStorage.getItem(STORE) || "{}"); } catch { return {}; }
}
export function SupportGenerator({ identity }: { identity: LocalIdentity }) {
  const [draft, setDraft] = useState<SupportDraft>(() => ({ name: "", company: "", message: "", logo: "", permissions: ["screen:view", "mouse:control", "keyboard:control"], confirmation: true, ...savedProfile().draft, password: "" }));
  const [confirm, setConfirm] = useState(""), [busy, setBusy] = useState(false), [status, setStatus] = useState("");
  const patch = (value: Partial<SupportDraft>) => setDraft(old => ({ ...old, ...value }));
  async function generate(event: React.FormEvent) {
    event.preventDefault(); if (busy) return;
    setBusy(true); setStatus("");
    try {
      const { password, ...safe } = draft, saved = savedProfile();
      const version = (await window.nodusDesktop?.getAppInfo())?.version;
      const reusable = !password && version && saved.version === version && saved.token && JSON.stringify(safe) === JSON.stringify(saved.draft);
      if (!reusable && password.length < 3) throw new Error("Defina uma senha de pelo menos 3 caracteres.");
      if (!reusable && password !== confirm) throw new Error("As senhas nao coincidem.");
      const info = await checkLicense(identity);
      if (!info.allowed || info.plan !== "business") throw new Error("Uma licenca empresarial ativa e necessaria para gerar suporte portatil.");
      const result = reusable ? { token: saved.token!, template: null } : await createSupportProfile(identity, draft);
      const output = await window.nodusDesktop?.generateSupportPackage(result);
      if (!output) throw new Error("Geracao disponivel somente no aplicativo Windows.");
      if (!output.canceled) {
        localStorage.setItem(STORE, JSON.stringify({ draft: safe, token: result.token, version }));
        patch({ password: "" }); setConfirm("");
      }
      setStatus(output.canceled ? "Operacao cancelada." : `Arquivo salvo: ${output.path}`);
    } catch (error) { setStatus(error instanceof Error && !/^[A-Z_]+$/.test(error.message) ? error.message : licenseFeedback(error)); }
    finally { setBusy(false); }
  }
  return <form className="settings-column support-generator" onSubmit={generate} aria-busy={busy}>
    <h3>Suporte portatil</h3>
    <label className="settings-field">Nome do suporte<input required maxLength={80} value={draft.name} onChange={e => patch({ name: e.target.value })} /></label>
    <label className="settings-field">Empresa<input required maxLength={120} value={draft.company} onChange={e => patch({ company: e.target.value })} /></label>
    <div className="support-password-fields"><label className="settings-field">Senha padrao<input type="password" autoComplete="new-password" minLength={3} maxLength={128} value={draft.password} onChange={e => patch({ password: e.target.value })} /></label><label className="settings-field">Confirmar senha<input type="password" autoComplete="new-password" minLength={3} maxLength={128} value={confirm} onChange={e => setConfirm(e.target.value)} /></label></div>
    <label className="settings-field">Mensagem<input maxLength={240} value={draft.message} onChange={e => patch({ message: e.target.value })} /></label>
    <label className="settings-field">Logotipo<input type="file" accept="image/png,image/jpeg" onChange={async e => {
      const file = e.currentTarget.files?.[0]; if (!file || file.size > 5 * 1024 * 1024) return;
      try { const bitmap = await createImageBitmap(file), canvas = document.createElement("canvas"); canvas.width = canvas.height = 64;
        canvas.getContext("2d")?.drawImage(bitmap, 0, 0, 64, 64); bitmap.close(); const logo = canvas.toDataURL("image/png");
        if (logo.length > 6000) throw new Error("Logotipo muito detalhado. Use uma imagem menor."); patch({ logo });
      } catch (error) { setStatus(error instanceof Error ? error.message : "Logotipo invalido."); }
    }} /></label>
    {draft.logo && <div className="support-logo-preview"><img src={draft.logo} alt="Logotipo" /><button className="secondary-button themed-action" type="button" onClick={() => patch({ logo: "" })}>Remover</button></div>}
    {OPTIONS.map(([permissions, label]) => <label className="support-option" key={label}><input type="checkbox" checked={permissions.every(p => draft.permissions.includes(p))} onChange={e => patch({ permissions: e.target.checked ? [...new Set([...draft.permissions, ...permissions])] : draft.permissions.filter(p => !permissions.includes(p)) })} />{label}</label>)}
    <label className="support-option"><input type="checkbox" checked={draft.confirmation} onChange={e => patch({ confirmation: e.target.checked })} />Solicitar confirmacao do cliente</label>
    <button className="primary-button themed-action" disabled={busy} aria-busy={busy} type="submit">{busy ? <LoaderCircle aria-hidden="true" className="is-checking" size={16} /> : <Download aria-hidden="true" size={16} />}{busy ? "Gerando QuickSupport..." : "Gerar QuickSupport"}</button>
    {status && <p role="status" aria-live="polite">{status}</p>}
  </form>;
}
