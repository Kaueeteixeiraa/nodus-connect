import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { initializeApp } from "firebase/app";
import { getAuth, GoogleAuthProvider, inMemoryPersistence, onAuthStateChanged, reauthenticateWithPopup, setPersistence, signInWithPopup, signOut, type User } from "firebase/auth";
import { ArrowRight, Building2, ChevronDown, DollarSign, FileCheck2, KeyRound, Laptop, LayoutDashboard, LogOut, Plus, RefreshCw, ShieldCheck, Users } from "lucide-react";
import { LICENSE_MESSAGES, type License, type LicenseAccessRequest, type LicenseDevice } from "../../../packages/licensing/src/index";
import logo from "../../desktop/src/assets/nodus-logo-icon.png";
import "./styles.css";

const base = String(import.meta.env.VITE_NODUS_LICENSE_API ?? "").replace(/\/$/, "");
const configured = Boolean(base && import.meta.env.VITE_FIREBASE_API_KEY && import.meta.env.VITE_FIREBASE_PROJECT_ID);
const auth = configured ? getAuth(initializeApp({ apiKey: import.meta.env.VITE_FIREBASE_API_KEY, authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN, projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID }, "nodus-admin")) : null;
const persistence = auth ? setPersistence(auth, inMemoryPersistence) : Promise.resolve();
const provider = new GoogleAuthProvider(); provider.setCustomParameters({ prompt: "select_account" });
type Organization = { id: string; name: string; email: string; licenseId: string; license: Omit<License, "keyHash"> };
type Details = { devices: { id: string; deviceName: string; nodusId: string; status: string }[]; payments: { paymentId: string; amountCents: number; paidAt: number; status: string }[]; audits: { action: string; adminUserId: string; timestamp: number }[] };
type Dashboard = { active: number; suspended: number; trials: number; devices: number; online: number; pendingRequests: number; organizations: number; mrrCents: number };
type PublicDevice = Omit<LicenseDevice, "claimHash" | "tokenHash"> & { online: boolean };
const ADMIN_VIEWS = [{ id: "dashboard", label: "Visão geral", icon: LayoutDashboard }, { id: "access", label: "Solicitações", icon: KeyRound }, { id: "devices", label: "Dispositivos", icon: Laptop }, { id: "organizations", label: "Empresas", icon: Building2 }] as const;
type AdminView = typeof ADMIN_VIEWS[number]["id"];
const money = (value: number) => new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(value / 100);
const date = (value: number) => new Date(value).toLocaleString("pt-BR");
const shortDate = (value: number) => value > 0 ? new Date(value).toLocaleDateString("pt-BR") : "Sem validade";
const statusLabels: Record<string, string> = { ACTIVE: "Ativa", BLOCKED: "Bloqueado", REVOKED: "Revogado", TRIAL: "Em teste", PENDING: "Pendente", APPROVED: "Aprovada", DENIED: "Rejeitada", SUSPENDED: "Suspensa", CANCELED: "Cancelada", EXPIRED: "Expirada", GRACE_PERIOD: "Em carência", PAST_DUE: "Em atraso" };
function Status({ value }: { value: string }) { return <span className={`status status-${value.toLowerCase()}`}><i aria-hidden="true" />{statusLabels[value] ?? value}</span>; }
async function api<T>(path: string, body?: object): Promise<T> {
  const user = auth?.currentUser; if (!user) throw new Error("Entre com uma conta autorizada.");
  const url = new URL(base); if (url.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(url.hostname)) throw new Error("API de licença inválida.");
  try {
    const response = await fetch(`${base}${path}`, { method: body ? "POST" : "GET", headers: { authorization: `Bearer ${await user.getIdToken()}`, ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), cache: "no-store", signal: AbortSignal.timeout(12_000) });
    const result = await response.json().catch(() => ({ code: "SERVER_UNAVAILABLE" }));
    if (!response.ok) throw new Error(LICENSE_MESSAGES[result.code as keyof typeof LICENSE_MESSAGES] ?? "Serviço indisponível.");
    return result as T;
  } catch (error) {
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError" || /signal timed out/i.test(error.message))) throw new Error("O serviço de administração demorou para responder. Tente novamente.");
    throw error;
  }
}
async function recentLogin() {
  const user = auth?.currentUser; if (!user) throw new Error("Sessão encerrada.");
  const result = await user.getIdTokenResult();
  if (Date.now() - new Date(result.authTime).getTime() > 240_000) { await reauthenticateWithPopup(user, provider); await user.getIdToken(true); }
}
function Admin() {
  const [user, setUser] = useState<User | null>(null), [verified, setVerified] = useState(false), [busy, setBusy] = useState(false), [feedback, setFeedback] = useState("");
  const [view, setView] = useState<AdminView>(new URLSearchParams(location.search).has("request") ? "access" : "dashboard"), [tab, setTab] = useState<"license" | "devices" | "payments" | "audit">("license");
  const [organizations, setOrganizations] = useState<Organization[]>([]), [dashboard, setDashboard] = useState<Dashboard | null>(null), [selected, setSelected] = useState<string>(""), [details, setDetails] = useState<Details | null>(null);
  const [accessRequests, setAccessRequests] = useState<LicenseAccessRequest[]>([]), [devices, setDevices] = useState<PublicDevice[]>([]);
  const [create, setCreate] = useState(false), [name, setName] = useState(""), [email, setEmail] = useState(""), [secret, setSecret] = useState("");
  const paymentAttempts = useRef(new Map<string, string>());
  const grantAttempts = useRef(new Map<string, string>());
  const organization = organizations.find(item => item.licenseId === selected);
  const pendingRequests = accessRequests.filter(item => item.status === "PENDING");
  async function reload(only: typeof view = view, summaryOnly = false) {
    const uid = auth?.currentUser?.uid;
    const [summary, rows, requests, deviceRows] = await Promise.all([
      !only || only === "dashboard" ? api<Dashboard>("/admin/dashboard") : null,
      !only || (only === "dashboard" && !summaryOnly) || only === "organizations" ? api<Organization[]>("/admin/organizations") : null,
      !only || (only === "dashboard" && !summaryOnly) || only === "access" ? api<LicenseAccessRequest[]>("/admin/access-requests") : null,
      !only || (only === "dashboard" && !summaryOnly) || only === "devices" ? api<PublicDevice[]>("/admin/devices") : null,
    ]);
    if (!uid || auth?.currentUser?.uid !== uid) return;
    if (summary) setDashboard(summary); if (rows) setOrganizations(rows); if (requests) setAccessRequests(requests); if (deviceRows) setDevices(deviceRows); setFeedback(""); setVerified(true);
  }
  useEffect(() => {
    if (!auth) return;
    let revision = 0;
    const stop = onAuthStateChanged(auth, next => {
      const current = ++revision;
      setUser(next); setVerified(false); setSecret(""); setDetails(null); setOrganizations([]); setDashboard(null); setSelected("");
      if (next) reload().catch(error => { if (current === revision) setFeedback(error.message); });
    });
    return () => { revision++; stop(); };
  }, []);
  useEffect(() => { if (!verified || view !== "dashboard") return; const timer = window.setInterval(() => { if (document.visibilityState === "visible") reload("dashboard", true).catch(error => setFeedback(error.message)); }, 60_000); return () => window.clearInterval(timer); }, [verified, view]);
  async function run(action: () => Promise<void>, critical = false) {
    if (busy) return; setBusy(true); setFeedback(""); setSecret("");
    try { if (critical) await recentLogin(); await action(); } catch (error) { setFeedback(error instanceof Error ? error.message : "Operação não concluída."); } finally { setBusy(false); }
  }
  async function mutate(path: string, body: object) {
    await api(path, body);
    try {
      await reload(view);
      if (view === "organizations" && selected) setDetails(await api<Details>("/admin/details", { licenseId: selected }));
      setFeedback("Alteração registrada e sincronizada.");
    } catch { setFeedback("Alteração registrada. Use Atualizar para confirmar os dados."); }
  }
  async function grant(licenseId: string) {
    const operationId = grantAttempts.current.get(licenseId) ?? crypto.randomUUID();
    grantAttempts.current.set(licenseId, operationId);
    await mutate("/admin/free-accesses", { licenseId, operationId });
    grantAttempts.current.delete(licenseId);
  }
  function navigate(next: AdminView) { setView(next); reload(next).catch(error => setFeedback(error.message)); }
  async function openOrganization(item: Organization) {
    setView("organizations"); setSelected(item.licenseId); setTab("license");
    setDetails(null); setDetails(await api<Details>("/admin/details", { licenseId: item.licenseId }));
  }
  function requestsTable(compact = false) {
    const rows = compact ? pendingRequests.slice(0, 3) : accessRequests;
    return <div className="table-scroll"><table><thead><tr><th>Solicitação</th><th>Dispositivo</th><th>Data</th>{!compact && <th>Status</th>}<th className="actions-heading">Ações</th></tr></thead><tbody>{rows.map(request => <tr key={request.id}><td><div className="cell-label"><span className="row-icon"><FileCheck2 size={19} /></span><span><strong>+{request.amount} acessos</strong><small>Acesso ao Nodus Connect</small></span></div></td><td>{devices.find(item => item.id === request.deviceId)?.deviceName ?? request.deviceId}</td><td className="date-cell">{date(request.createdAt)}</td>{!compact && <td><Status value={request.status} /></td>}<td><div className="row-actions">{request.status === "PENDING" ? <><button className="primary" disabled={busy} onClick={() => run(() => mutate("/admin/access-request", { requestId: request.id, approve: true }), true)}>Aprovar</button><button disabled={busy} onClick={() => run(() => mutate("/admin/access-request", { requestId: request.id, approve: false }), true)}>Rejeitar</button></> : <span className="muted">Concluída</span>}</div></td></tr>)}</tbody></table>{!rows.length && <p className="empty-state">{compact ? "Nenhuma solicitação pendente." : "Nenhuma solicitação registrada."}</p>}</div>;
  }
  function devicesTable(compact = false) {
    const rows = compact ? devices.slice(0, 3) : devices;
    return <div className="table-scroll"><table><thead><tr><th>Dispositivo</th><th>Nodus ID</th><th>Conexão</th>{!compact && <><th>Permissão</th><th>Último uso</th><th className="actions-heading">Ações</th></>}</tr></thead><tbody>{rows.map(device => <tr key={device.id}><td><div className="cell-label"><span className="row-icon"><Laptop size={19} /></span><strong>{device.deviceName}</strong></div></td><td className="nodus-id">{device.nodusId}</td><td><Status value={device.online ? "Online" : "Offline"} /></td>{!compact && <><td><Status value={device.status} /></td><td className="date-cell">{date(device.lastSeenAt)}</td><td><div className="row-actions"><button className={device.status === "ACTIVE" ? "danger" : ""} disabled={busy} onClick={() => run(() => mutate("/admin/device", { deviceId: device.id, status: device.status === "ACTIVE" ? "BLOCKED" : "ACTIVE" }), true)}>{device.status === "ACTIVE" ? "Bloquear acessos" : "Liberar acessos"}</button>{device.licenseId.startsWith("free-") && <button disabled={busy} onClick={() => { if (window.confirm("Liberar mais 200 acessos para este dispositivo?")) run(() => grant(device.licenseId), true); }}>+200 acessos</button>}</div></td></>}</tr>)}</tbody></table>{!rows.length && <p className="empty-state">Nenhum dispositivo registrado.</p>}</div>;
  }
  function organizationsTable(compact = false) {
    const rows = compact ? organizations.slice(0, 5) : organizations;
    return <div className="table-scroll"><table><thead><tr><th>Empresa</th><th>Status</th><th>Dispositivos</th>{!compact && <th>Sessões</th>}<th>Validade</th><th className="actions-heading">Detalhes</th></tr></thead><tbody>{rows.map(item => <tr key={item.id}><td><button className="text-action" disabled={busy} onClick={() => run(() => openOrganization(item))}>{item.name}</button>{!compact && <small>{item.email}</small>}</td><td><Status value={item.license.status} /></td><td>{item.license.deviceIds.length} / {item.license.maxDevices}</td>{!compact && <td>{Object.values(item.license.slots).filter(slot => slot.established || slot.expiresAt > Date.now()).length} / {item.license.maxConcurrentSessions}</td>}<td>{shortDate(item.license.expiresAt)}</td><td><button className="icon-button" title={`Abrir ${item.name}`} aria-label={`Abrir ${item.name}`} disabled={busy} onClick={() => run(() => openOrganization(item))}><ArrowRight size={17} /></button></td></tr>)}</tbody></table>{!rows.length && <p className="empty-state">Nenhuma empresa cadastrada.</p>}</div>;
  }
  return <div className="admin-shell">
    <header className="admin-header"><div className="admin-brand"><img src={logo} alt="" /><strong>Nodus Admin</strong></div>{user && <details className="admin-account"><summary><span className="avatar">{(user.displayName ?? user.email ?? "A").slice(0, 1).toUpperCase()}</span><span><strong>{user.displayName ?? user.email}</strong><small>{verified ? "Administrador" : "Acesso não verificado"}</small></span><ChevronDown size={18} /></summary><div className="account-menu"><small>{user.email}</small><button className="danger" onClick={() => run(async () => { await signOut(auth!); })} disabled={busy}><LogOut size={17} />Sair da conta</button></div></details>}</header>
    {!verified ? <main className="admin-login"><ShieldCheck size={32} /><h1>Nodus Admin</h1>{!configured ? <p>Administração indisponível.</p> : <button disabled={busy} onClick={() => run(async () => { await persistence; if (auth!.currentUser) await reload(); else await signInWithPopup(auth!, provider); })}><ShieldCheck size={18} />{user ? "Verificar acesso" : "Entrar com Google"}</button>}{feedback && <p role="alert">{feedback}</p>}</main> : <>
      <nav className="admin-nav" aria-label="Administração">{ADMIN_VIEWS.map(({ id, label, icon: Icon }) => <button key={id} className={view === id ? "active" : ""} aria-current={view === id ? "page" : undefined} onClick={() => navigate(id)}><Icon size={23} /><span>{label}</span>{id === "access" && pendingRequests.length > 0 && <span className="nav-badge">{pendingRequests.length}</span>}</button>)}</nav>
      <main className="admin-main"><div className="page-title"><div><h1>{{ dashboard: "Visão geral", access: "Solicitações", devices: "Dispositivos", organizations: "Empresas" }[view]}</h1><p>{{ dashboard: "Resumo do ambiente Nodus Connect", access: "Pedidos de acessos adicionais e histórico de decisões", devices: "Disponibilidade e permissões dos dispositivos registrados", organizations: "Licenças, dispositivos e assinaturas empresariais" }[view]}</p></div><button className="icon-button" title="Atualizar" aria-label="Atualizar" disabled={busy} onClick={() => run(reload)}><RefreshCw size={18} className={busy ? "spinning" : ""} /></button></div>
        {feedback && <p className="admin-feedback" role="status">{feedback}</p>}
        {view === "dashboard" && dashboard && <>
          <dl className="summary-grid">{[{ label: "Empresas", value: dashboard.organizations, icon: Building2 }, { label: "Licenças ativas", value: dashboard.active, icon: Users }, { label: "Dispositivos", value: dashboard.devices, icon: Laptop }, { label: "Receita mensal", value: money(dashboard.mrrCents), icon: DollarSign }].map(({ label, value, icon: Icon }) => <div key={label}><dt>{label}</dt><dd><span className={`summary-icon${label === "Receita mensal" ? " revenue" : ""}`}><Icon size={30} /></span>{value}</dd></div>)}</dl>
          <div className="dashboard-panels"><section className="data-section"><div className="section-heading"><h2>Solicitações pendentes</h2><button className="text-action" onClick={() => navigate("access")}>Ver todas <ArrowRight size={16} /></button></div>{requestsTable(true)}</section><section className="data-section"><div className="section-heading"><h2>Dispositivos recentes</h2><button className="text-action" onClick={() => navigate("devices")}>Ver todos <ArrowRight size={16} /></button></div>{devicesTable(true)}</section></div>
          <section className="data-section"><div className="section-heading"><h2>Empresas</h2><button className="text-action" onClick={() => navigate("organizations")}>Ver todas <ArrowRight size={16} /></button></div>{organizationsTable(true)}</section>
          <dl className="system-summary">{Object.entries({ "Dispositivos online": dashboard.online, "Pedidos pendentes": dashboard.pendingRequests, "Licenças em teste": dashboard.trials, "Licenças suspensas": dashboard.suspended }).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
        </>}
        {view === "access" && <section className="data-section"><div className="section-heading"><h2>Solicitações de acessos</h2><span className="muted">{accessRequests.length} registros</span></div>{requestsTable()}</section>}
        {view === "devices" && <section className="data-section"><div className="section-heading"><h2>Dispositivos registrados</h2><span className="muted">{devices.length} dispositivos</span></div>{devicesTable()}</section>}
        {view === "organizations" && <>
          <div className="list-actions"><button disabled={busy} onClick={() => setCreate(value => !value)}><Plus size={18} />Nova empresa</button></div>
          {create && <form className="company-form" onSubmit={event => { event.preventDefault(); run(async () => { const result = await api<{ key: string; licenseId: string }>("/admin/organizations", { name, email }); await reload(); setSelected(result.licenseId); setSecret(result.key); setName(""); setEmail(""); setCreate(false); }, true); }}><label>Empresa<input required maxLength={120} value={name} onChange={event => setName(event.target.value)} /></label><label>E-mail<input type="email" required maxLength={254} value={email} onChange={event => setEmail(event.target.value)} /></label><button disabled={busy} type="submit"><Plus size={18} />Criar licença</button></form>}
          {secret && <div className="key-result" role="status"><strong>Chave emitida</strong><code>{secret}</code><button onClick={() => setSecret("")}>Fechar</button></div>}
          <section className="data-section"><div className="section-heading"><h2>Empresas cadastradas</h2><span className="muted">{organizations.length} empresas</span></div>{organizationsTable()}</section>
          {organization && <section className="company-details"><h2>{organization.name}</h2><div className="detail-tabs" role="tablist" aria-label="Empresa">{(["license", "devices", "payments", "audit"] as const).map((id, index) => <button key={id} role="tab" aria-selected={tab === id} onClick={() => setTab(id)}>{["Licença", "Dispositivos", "Pagamentos", "Auditoria"][index]}</button>)}</div>
            {tab === "license" && <form key={`${selected}-${organization.license.updatedAt}`} className="license-form" onSubmit={event => { event.preventDefault(); const fields = new FormData(event.currentTarget); run(() => mutate("/admin/license", { licenseId: selected, patch: { status: fields.get("status"), maxDevices: Number(fields.get("devices")), maxConcurrentSessions: Number(fields.get("sessions")) } }), true); }}><label>Status<select name="status" defaultValue={organization.license.status}>{["ACTIVE", "GRACE_PERIOD", "SUSPENDED", "CANCELED", "EXPIRED"].map(status => <option key={status}>{status}</option>)}</select></label><label>Limite de dispositivos<input name="devices" type="number" min={1} max={1000} defaultValue={organization.license.maxDevices} required /></label><label>Limite de sessões<input name="sessions" type="number" min={1} max={1000} defaultValue={organization.license.maxConcurrentSessions} required /></label><button type="submit" disabled={busy}>Salvar</button><div className="license-actions"><button type="button" disabled={busy} onClick={() => run(async () => { const result = await api<{ key: string }>("/admin/key", { licenseId: selected }); await reload(); setSecret(result.key); }, true)}>Rotacionar chave</button><button className="danger" type="button" disabled={busy} onClick={() => { if (window.confirm("Revogar a chave de novas ativações?")) run(() => mutate("/admin/key", { licenseId: selected, revoke: true }), true); }}>Revogar chave</button></div></form>}
            {tab === "devices" && <div className="table-scroll"><table><thead><tr><th>Dispositivo</th><th>Nodus ID</th><th>Status</th><th>Ação</th></tr></thead><tbody>{details?.devices.map(device => <tr key={device.id}><td>{device.deviceName}</td><td>{device.nodusId}</td><td>{device.status}</td><td><button disabled={busy} className={device.status === "ACTIVE" ? "danger" : ""} onClick={() => { if (window.confirm(`${device.status === "ACTIVE" ? "Revogar" : "Reativar"} este dispositivo?`)) run(() => mutate("/admin/device", { deviceId: device.id, status: device.status === "ACTIVE" ? "REVOKED" : "ACTIVE" }), true); }}>{device.status === "ACTIVE" ? "Revogar" : "Reativar"}</button></td></tr>)}</tbody></table></div>}
            {tab === "payments" && <><button disabled={busy} onClick={() => { if (window.confirm("Confirmar recebimento de R$ 200,00 e renovar por 30 dias?")) run(async () => { const paymentId = paymentAttempts.current.get(selected) ?? crypto.randomUUID(); paymentAttempts.current.set(selected, paymentId); await mutate("/admin/payment", { licenseId: selected, paymentId, amountCents: 20_000 }); paymentAttempts.current.delete(selected); }, true); }}>Registrar pagamento de R$ 200,00</button><div className="table-scroll"><table><thead><tr><th>Pagamento</th><th>Valor</th><th>Data</th><th>Status</th></tr></thead><tbody>{details?.payments.map(payment => <tr key={payment.paymentId}><td>{payment.paymentId}</td><td>{money(payment.amountCents)}</td><td>{date(payment.paidAt)}</td><td>{payment.status}</td></tr>)}</tbody></table></div></>}
            {tab === "audit" && <div className="table-scroll"><table><thead><tr><th>Ação</th><th>Responsável</th><th>Data</th></tr></thead><tbody>{details?.audits.map((entry, index) => <tr key={`${entry.timestamp}-${index}`}><td>{entry.action}</td><td>{entry.adminUserId}</td><td>{date(entry.timestamp)}</td></tr>)}</tbody></table></div>}
          </section>}
        </>}
      </main>
    </>}
  </div>;
}
createRoot(document.getElementById("root")!).render(<Admin />);
