import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { initializeApp } from "firebase/app";
import { getAuth, GoogleAuthProvider, inMemoryPersistence, onAuthStateChanged, reauthenticateWithPopup, setPersistence, signInWithPopup, signOut, type User } from "firebase/auth";
import { ArrowLeft, ArrowRight, Ban, Building2, Check, ChevronDown, ChevronLeft, ChevronRight, Copy, DollarSign, FileCheck2, KeyRound, Laptop, LayoutDashboard, LoaderCircle, LogOut, Plus, RefreshCw, Save, Search, ShieldCheck, Users, X } from "lucide-react";
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
const PAGE_SIZE = 10;
const DETAIL_TABS = [{ id: "license", label: "Licença" }, { id: "devices", label: "Dispositivos" }, { id: "payments", label: "Pagamentos" }, { id: "audit", label: "Auditoria" }] as const;
function matches(query: string, ...values: (string | undefined)[]) {
  const normalize = (value: string) => value.normalize("NFD").replace(/[\u0300-\u036f\s]/g, "").toLowerCase();
  return values.some(value => normalize(value ?? "").includes(normalize(query)));
}
function ListTools({ query, filter, options, onQuery, onFilter }: { query: string; filter: string; options: [string, string][]; onQuery: (value: string) => void; onFilter: (value: string) => void }) {
  return <div className="list-tools"><label className="search-field"><Search size={16} aria-hidden="true" /><input type="search" aria-label="Buscar registros" placeholder="Buscar por nome, ID ou e-mail" value={query} onChange={event => onQuery(event.target.value)} /></label><select aria-label="Filtrar registros" value={filter} onChange={event => onFilter(event.target.value)}><option value="all">Todos os status</option>{options.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>{(query || filter !== "all") && <button className="icon-button" aria-label="Limpar filtros" title="Limpar filtros" onClick={() => { onQuery(""); onFilter("all"); }}><X size={16} /></button>}</div>;
}
function Pagination({ total, page, onPage }: { total: number; page: number; onPage: (value: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE)), current = Math.min(page, pages);
  return <div className="pagination"><span>{total ? `${(current - 1) * PAGE_SIZE + 1}–${Math.min(current * PAGE_SIZE, total)} de ${total}` : "0 registros"}</span><div><button className="icon-button" title="Página anterior" aria-label="Página anterior" disabled={current === 1} onClick={() => onPage(current - 1)}><ChevronLeft size={16} /></button><span>Página {current} de {pages}</span><button className="icon-button" title="Próxima página" aria-label="Próxima página" disabled={current === pages} onClick={() => onPage(current + 1)}><ChevronRight size={16} /></button></div></div>;
}
function ConfirmDialog({ title, message, onConfirm, onCancel }: { title: string; message: string; onConfirm: () => void; onCancel: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { ref.current?.showModal(); }, []);
  return <dialog ref={ref} className="confirm-dialog" aria-labelledby="confirm-title" aria-describedby="confirm-message" onCancel={onCancel}><h2 id="confirm-title">{title}</h2><p id="confirm-message">{message}</p><div className="dialog-actions"><button autoFocus onClick={onCancel}>Cancelar</button><button className="primary" onClick={onConfirm}><Check size={16} />Confirmar</button></div></dialog>;
}
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
  const [query, setQuery] = useState(""), [filter, setFilter] = useState("all"), [page, setPage] = useState(1), [updatedAt, setUpdatedAt] = useState(0);
  const [confirmation, setConfirmation] = useState<{ title: string; message: string; action: () => Promise<void> } | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const paymentAttempts = useRef(new Map<string, string>());
  const grantAttempts = useRef(new Map<string, string>());
  const organization = organizations.find(item => item.licenseId === selected);
  const pendingRequests = accessRequests.filter(item => item.status === "PENDING");
  const deviceById = new Map(devices.map(item => [item.id, item]));
  const filteredRequests = accessRequests.filter(item => (filter === "all" || item.status === filter) && matches(query, item.deviceId, item.licenseId, deviceById.get(item.deviceId)?.deviceName, deviceById.get(item.deviceId)?.nodusId));
  const filteredDevices = devices.filter(item => (filter === "all" || (filter === "online" ? item.online : filter === "offline" ? !item.online : item.status === filter)) && matches(query, item.deviceName, item.nodusId, item.id, item.licenseId));
  const filteredOrganizations = organizations.filter(item => (filter === "all" || item.license.status === filter) && matches(query, item.name, item.email, item.id, item.licenseId));
  function pageRows<T>(rows: T[]): T[] { const current = Math.min(page, Math.max(1, Math.ceil(rows.length / PAGE_SIZE))); return rows.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE); }
  function updateQuery(value: string) { setQuery(value); setPage(1); }
  function updateFilter(value: string) { setFilter(value); setPage(1); }
  function confirmAction(title: string, message: string, action: () => Promise<void>) { setConfirmation({ title, message, action }); }
  async function copy(value: string) { await navigator.clipboard.writeText(value); setFeedback("Copiado para a área de transferência."); }
  async function reload(only: typeof view = view, summaryOnly = false) {
    const uid = auth?.currentUser?.uid;
    const [summary, rows, requests, deviceRows] = await Promise.all([
      !only || only === "dashboard" ? api<Dashboard>("/admin/dashboard") : null,
      !only || (only === "dashboard" && !summaryOnly) || only === "organizations" ? api<Organization[]>("/admin/organizations") : null,
      !only || (only === "dashboard" && !summaryOnly) || only === "access" ? api<LicenseAccessRequest[]>("/admin/access-requests") : null,
      !only || (only === "dashboard" && !summaryOnly) || only === "devices" ? api<PublicDevice[]>("/admin/devices") : null,
    ]);
    if (!uid || auth?.currentUser?.uid !== uid) return;
    if (summary) setDashboard(summary); if (rows) setOrganizations(rows); if (requests) setAccessRequests(requests); if (deviceRows) setDevices(deviceRows); setFeedback(""); setVerified(true); setUpdatedAt(Date.now());
  }
  useEffect(() => {
    if (!auth) return;
    let revision = 0;
    const stop = onAuthStateChanged(auth, next => {
      const current = ++revision;
      setUser(next); setVerified(false); setSecret(""); setDetails(null); setOrganizations([]); setDashboard(null); setSelected(""); setDevices([]); setAccessRequests([]); setConfirmation(null); setUpdatedAt(0);
      if (next) reload().catch(error => { if (current === revision) setFeedback(error.message); });
    });
    return () => { revision++; stop(); };
  }, []);
  useEffect(() => { if (!verified || busy || view !== "dashboard") return; const timer = window.setInterval(() => { if (document.visibilityState === "visible") reload("dashboard", true).catch(error => setFeedback(error.message)); }, 60_000); return () => window.clearInterval(timer); }, [verified, busy, view]);
  useEffect(() => { if (selected) document.getElementById("company-heading")?.focus(); }, [selected]);
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
  function navigate(next: AdminView) { if (busy || next === view && !selected) return; setView(next); setSelected(""); setDetails(null); setCreate(false); updateQuery(""); updateFilter("all"); run(() => reload(next)); }
  async function refresh() { setRefreshing(true); try { await reload(view); if (view === "organizations" && selected) setDetails(await api<Details>("/admin/details", { licenseId: selected })); } finally { setRefreshing(false); } }
  async function openOrganization(item: Organization) {
    if (view !== "organizations") { updateQuery(""); updateFilter("all"); }
    setPage(1);
    setView("organizations"); setSelected(item.licenseId); setTab("license"); setCreate(false);
    setDetails(null); setDetails(await api<Details>("/admin/details", { licenseId: item.licenseId }));
  }
  async function createCompany() {
    const result = await api<{ key: string; licenseId: string }>("/admin/organizations", { name, email });
    setSecret(result.key); setSelected(result.licenseId); setTab("license"); setDetails(null);
    setName(""); setEmail(""); setCreate(false); updateQuery(""); updateFilter("all");
    try { await reload(); setDetails(await api<Details>("/admin/details", { licenseId: result.licenseId })); }
    catch { setFeedback("Empresa criada. Guarde a chave emitida e atualize para consultar os detalhes."); }
  }
  function requestsTable(compact = false) {
    const rows = compact ? pendingRequests.slice(0, 3) : pageRows(filteredRequests);
    return <><div className="table-scroll"><table><thead><tr><th>Solicitação</th><th>Dispositivo</th><th>Data</th>{!compact && <th>Status</th>}<th className="actions-heading">Ações</th></tr></thead><tbody>{rows.map(request => <tr key={request.id}><td><div className="cell-label"><span className="row-icon"><FileCheck2 size={17} /></span><span><strong>+{request.amount} acessos</strong>{!compact && <small>{request.licenseId}</small>}</span></div></td><td>{deviceById.get(request.deviceId)?.deviceName ?? request.deviceId}</td><td className="date-cell">{date(request.createdAt)}</td>{!compact && <td><Status value={request.status} /></td>}<td><div className="row-actions">{request.status === "PENDING" ? <><button className="primary" disabled={busy} onClick={() => confirmAction("Aprovar solicitação", `Liberar ${request.amount} acessos para ${deviceById.get(request.deviceId)?.deviceName ?? request.deviceId}?`, () => mutate("/admin/access-request", { requestId: request.id, approve: true }))}><Check size={15} />Aprovar</button><button disabled={busy} onClick={() => confirmAction("Rejeitar solicitação", "Este pedido será marcado como rejeitado.", () => mutate("/admin/access-request", { requestId: request.id, approve: false }))}><X size={15} />Rejeitar</button></> : <span className="muted">Concluída</span>}</div></td></tr>)}</tbody></table>{!rows.length && <p className="empty-state">{compact ? "Nenhuma solicitação pendente." : query || filter !== "all" ? "Nenhuma solicitação corresponde aos filtros." : "Nenhuma solicitação registrada."}</p>}</div>{!compact && <Pagination total={filteredRequests.length} page={page} onPage={setPage} />}</>;
  }
  function devicesTable(compact = false) {
    const rows = compact ? devices.slice(0, 3) : pageRows(filteredDevices);
    return <><div className="table-scroll"><table><thead><tr><th>Dispositivo</th><th>Nodus ID</th><th>Conexão</th>{!compact && <><th>Permissão</th><th>Último uso</th><th className="actions-heading">Ações</th></>}</tr></thead><tbody>{rows.map(device => <tr key={device.id}><td><div className="cell-label"><span className="row-icon"><Laptop size={17} /></span><span><strong>{device.deviceName}</strong>{!compact && <small>{device.licenseId.startsWith("free-") ? "Licença gratuita" : "Nodus Business"}</small>}</span></div></td><td className="nodus-id"><span>{device.nodusId.replace(/(\d{3})(?=\d)/g, "$1 ")}</span>{!compact && <button className="icon-button" title="Copiar Nodus ID" aria-label={`Copiar ID de ${device.deviceName}`} disabled={busy} onClick={() => run(() => copy(device.nodusId))}><Copy size={14} /></button>}</td><td><Status value={device.online ? "Online" : "Offline"} /></td>{!compact && <><td><Status value={device.status} /></td><td className="date-cell">{date(device.lastSeenAt)}</td><td><div className="row-actions"><button className={device.status === "ACTIVE" ? "danger" : ""} disabled={busy} onClick={() => confirmAction(device.status === "ACTIVE" ? "Bloquear acessos" : "Liberar acessos", `${device.status === "ACTIVE" ? "Bloquear" : "Liberar"} os acessos de ${device.deviceName}?`, () => mutate("/admin/device", { deviceId: device.id, status: device.status === "ACTIVE" ? "BLOCKED" : "ACTIVE" }))}>{device.status === "ACTIVE" ? <Ban size={15} /> : <Check size={15} />}{device.status === "ACTIVE" ? "Bloquear" : "Liberar"}</button>{device.licenseId.startsWith("free-") && <button disabled={busy} onClick={() => confirmAction("Liberar mais acessos", `Adicionar 200 acessos à licença de ${device.deviceName}?`, () => grant(device.licenseId))}><Plus size={15} />200 acessos</button>}</div></td></>}</tr>)}</tbody></table>{!rows.length && <p className="empty-state">{query || filter !== "all" ? "Nenhum dispositivo corresponde aos filtros." : "Nenhum dispositivo registrado."}</p>}</div>{!compact && <Pagination total={filteredDevices.length} page={page} onPage={setPage} />}</>;
  }
  function organizationsTable(compact = false) {
    const rows = compact ? organizations.slice(0, 3) : pageRows(filteredOrganizations);
    return <><div className="table-scroll"><table><thead><tr><th>Empresa</th><th>Status</th><th>Dispositivos</th>{!compact && <th>Sessões</th>}<th>Validade</th><th className="actions-heading">Detalhes</th></tr></thead><tbody>{rows.map(item => <tr key={item.id}><td><button className="text-action" disabled={busy} onClick={() => run(() => openOrganization(item))}>{item.name}</button>{!compact && <small>{item.email}</small>}</td><td><Status value={item.license.status} /></td><td>{item.license.deviceIds.length} / {item.license.maxDevices}</td>{!compact && <td>{Object.values(item.license.slots).filter(slot => slot.established || slot.expiresAt > Date.now()).length} / {item.license.maxConcurrentSessions}</td>}<td>{shortDate(item.license.expiresAt)}</td><td className="actions-heading"><button className="icon-button" title={`Abrir ${item.name}`} aria-label={`Abrir ${item.name}`} disabled={busy} onClick={() => run(() => openOrganization(item))}><ArrowRight size={17} /></button></td></tr>)}</tbody></table>{!rows.length && <p className="empty-state">{query || filter !== "all" ? "Nenhuma empresa corresponde aos filtros." : "Nenhuma empresa cadastrada."}</p>}</div>{!compact && <Pagination total={filteredOrganizations.length} page={page} onPage={setPage} />}</>;
  }
  return <div className="admin-shell">
    <header className="admin-header"><div className="admin-brand"><img src={logo} alt="" /><strong>Nodus Admin</strong></div>{user && <details className="admin-account"><summary><span className="avatar">{(user.displayName ?? user.email ?? "A").slice(0, 1).toUpperCase()}</span><span><strong>{user.displayName ?? user.email}</strong><small>{verified ? "Administrador" : "Acesso não verificado"}</small></span><ChevronDown size={18} /></summary><div className="account-menu"><small>{user.email}</small><button className="danger" onClick={() => run(async () => { await signOut(auth!); })} disabled={busy}><LogOut size={17} />Sair da conta</button></div></details>}</header>
    {!verified ? <main className="admin-login"><ShieldCheck size={32} /><h1>Nodus Admin</h1>{!configured ? <p>Administração indisponível.</p> : <button disabled={busy} onClick={() => run(async () => { await persistence; if (auth!.currentUser) await reload(); else await signInWithPopup(auth!, provider); })}><ShieldCheck size={18} />{user ? "Verificar acesso" : "Entrar com Google"}</button>}{feedback && <p role="alert">{feedback}</p>}</main> : <>
      <nav className="admin-nav" aria-label="Administração">{ADMIN_VIEWS.map(({ id, label, icon: Icon }) => <button key={id} disabled={busy} className={view === id ? "active" : ""} aria-current={view === id ? "page" : undefined} onClick={() => navigate(id)}><Icon size={18} /><span>{label}</span>{id === "access" && pendingRequests.length > 0 && <span className="nav-badge">{pendingRequests.length}</span>}</button>)}<div className="nav-footer"><ShieldCheck size={14} />Administração Nodus</div></nav>
      <main className="admin-main" aria-busy={busy}><div className="page-title"><div>{view === "organizations" && organization && <button className="text-action back-action" disabled={busy} onClick={() => { setSelected(""); setDetails(null); setSecret(""); setPage(1); }}><ArrowLeft size={16} />Empresas</button>}<h1 id="company-heading" tabIndex={-1}>{view === "organizations" && organization ? organization.name : { dashboard: "Visão geral", access: "Solicitações", devices: "Dispositivos", organizations: "Empresas" }[view]}</h1><p>{view === "organizations" && organization ? organization.email : { dashboard: "Resumo do ambiente Nodus Connect", access: "Pedidos de acessos adicionais e histórico de decisões", devices: "Disponibilidade e permissões dos dispositivos registrados", organizations: "Licenças, dispositivos e assinaturas empresariais" }[view]}</p></div><div className="refresh-tools">{updatedAt > 0 && <small>Última consulta {new Date(updatedAt).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}</small>}<button className="icon-button" title="Atualizar" aria-label="Atualizar" disabled={busy} onClick={() => run(refresh)}><RefreshCw size={17} className={refreshing ? "spinning" : ""} /></button></div></div>
        {feedback && <p className="admin-feedback" role="status">{feedback}</p>}
        {view === "dashboard" && dashboard && <>
          <dl className="summary-grid">{[{ label: "Empresas", value: dashboard.organizations, icon: Building2 }, { label: "Licenças ativas", value: dashboard.active, icon: Users }, { label: "Dispositivos", value: dashboard.devices, icon: Laptop }, { label: "Receita mensal", value: money(dashboard.mrrCents), icon: DollarSign }].map(({ label, value, icon: Icon }) => <div key={label}><dt>{label}</dt><dd><span className={`summary-icon${label === "Receita mensal" ? " revenue" : ""}`}><Icon size={30} /></span>{value}</dd></div>)}</dl>
          <div className="dashboard-panels"><section className="data-section"><div className="section-heading"><h2>Solicitações pendentes</h2><button className="text-action" onClick={() => navigate("access")}>Ver todas <ArrowRight size={16} /></button></div>{requestsTable(true)}</section><section className="data-section"><div className="section-heading"><h2>Dispositivos recentes</h2><button className="text-action" onClick={() => navigate("devices")}>Ver todos <ArrowRight size={16} /></button></div>{devicesTable(true)}</section></div>
          <section className="data-section"><div className="section-heading"><h2>Empresas</h2><button className="text-action" onClick={() => navigate("organizations")}>Ver todas <ArrowRight size={16} /></button></div>{organizationsTable(true)}</section>
          <dl className="system-summary">{Object.entries({ "Dispositivos online": dashboard.online, "Pedidos pendentes": dashboard.pendingRequests, "Licenças em teste": dashboard.trials, "Licenças suspensas": dashboard.suspended }).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
        </>}
        {view === "access" && <section className="data-section"><div className="section-heading"><h2>Solicitações de acessos</h2><span className="muted">{filteredRequests.length} de {accessRequests.length} registros</span></div><ListTools query={query} filter={filter} options={[["PENDING", "Pendentes"], ["APPROVED", "Aprovadas"], ["DENIED", "Rejeitadas"]]} onQuery={updateQuery} onFilter={updateFilter} />{requestsTable()}</section>}
        {view === "devices" && <section className="data-section"><div className="section-heading"><h2>Dispositivos registrados</h2><span className="muted">{filteredDevices.length} de {devices.length} dispositivos</span></div><ListTools query={query} filter={filter} options={[["online", "Online"], ["offline", "Offline"], ["ACTIVE", "Liberados"], ["BLOCKED", "Bloqueados"], ["REVOKED", "Revogados"]]} onQuery={updateQuery} onFilter={updateFilter} />{devicesTable()}</section>}
        {view === "organizations" && <>
          {!organization && <div className="list-actions"><button disabled={busy} onClick={() => setCreate(value => !value)}>{create ? <X size={16} /> : <Plus size={16} />}{create ? "Cancelar cadastro" : "Nova empresa"}</button></div>}
          {create && <form className="company-form" onSubmit={event => { event.preventDefault(); run(createCompany, true); }}><label>Empresa<input required maxLength={120} value={name} onChange={event => setName(event.target.value)} /></label><label>E-mail<input type="email" required maxLength={254} value={email} onChange={event => setEmail(event.target.value)} /></label><button disabled={busy} type="submit"><Plus size={16} />Criar licença</button></form>}
          {secret && <div className="key-result" role="status"><strong>Chave emitida</strong><code>{secret}</code><button className="icon-button" disabled={busy} aria-label="Copiar chave" title="Copiar chave" onClick={() => { copy(secret).catch(error => setFeedback(error.message)); }}><Copy size={16} /></button><button className="icon-button" aria-label="Fechar chave" title="Fechar chave" onClick={() => setSecret("")}><X size={16} /></button></div>}
          {!organization && <section className="data-section"><div className="section-heading"><h2>Empresas cadastradas</h2><span className="muted">{filteredOrganizations.length} de {organizations.length} empresas</span></div><ListTools query={query} filter={filter} options={["ACTIVE", "GRACE_PERIOD", "SUSPENDED", "CANCELED", "EXPIRED"].map(status => [status, statusLabels[status]])} onQuery={updateQuery} onFilter={updateFilter} />{organizationsTable()}</section>}
          {organization && <section className="company-details"><dl className="company-summary"><div><dt>Status</dt><dd><Status value={organization.license.status} /></dd></div><div><dt>Dispositivos</dt><dd>{organization.license.deviceIds.length} / {organization.license.maxDevices}</dd></div><div><dt>Sessões simultâneas</dt><dd>{Object.values(organization.license.slots).filter(slot => slot.established || slot.expiresAt > Date.now()).length} / {organization.license.maxConcurrentSessions}</dd></div><div><dt>Validade</dt><dd>{shortDate(organization.license.expiresAt)}</dd></div><div><dt>Chave</dt><dd>{organization.license.keyRevoked ? "Revogada" : `•••• ${organization.license.keyLast4}`}</dd></div></dl><div className="detail-tabs" role="tablist" aria-label="Empresa">{DETAIL_TABS.map(({ id, label }) => <button key={id} id={`tab-${id}`} role="tab" aria-selected={tab === id} aria-controls="company-panel" tabIndex={tab === id ? 0 : -1} onClick={() => { setTab(id); setPage(1); }} onKeyDown={event => { const index = DETAIL_TABS.findIndex(item => item.id === id); const next = event.key === "ArrowRight" ? (index + 1) % 4 : event.key === "ArrowLeft" ? (index + 3) % 4 : event.key === "Home" ? 0 : event.key === "End" ? 3 : -1; if (next >= 0) { event.preventDefault(); setTab(DETAIL_TABS[next].id); setPage(1); document.getElementById(`tab-${DETAIL_TABS[next].id}`)?.focus(); } }}>{label}</button>)}</div><div id="company-panel" role="tabpanel" aria-labelledby={`tab-${tab}`}>
            {tab !== "license" && !details && <p className="empty-state" role="status">{busy ? <><LoaderCircle size={18} className="spinning" /> Carregando detalhes...</> : "Detalhes indisponíveis. Atualize para tentar novamente."}</p>}
            {tab === "license" && <form key={`${selected}-${organization.license.updatedAt}`} className="license-form" onSubmit={event => { event.preventDefault(); const fields = new FormData(event.currentTarget); run(() => mutate("/admin/license", { licenseId: selected, patch: { status: fields.get("status"), maxDevices: Number(fields.get("devices")), maxConcurrentSessions: Number(fields.get("sessions")) } }), true); }}><label>Status<select name="status" defaultValue={organization.license.status}>{["ACTIVE", "PAST_DUE", "GRACE_PERIOD", "SUSPENDED", "CANCELED", "EXPIRED"].map(status => <option key={status} value={status}>{statusLabels[status]}</option>)}</select></label><label>Limite de dispositivos<input name="devices" type="number" min={1} max={1000} defaultValue={organization.license.maxDevices} required /></label><label>Limite de sessões<input name="sessions" type="number" min={1} max={1000} defaultValue={organization.license.maxConcurrentSessions} required /></label><button type="submit" disabled={busy}><Save size={16} />Salvar alterações</button><div className="license-actions"><button type="button" disabled={busy} onClick={() => confirmAction("Rotacionar chave", "A chave atual será substituída para novas ativações.", async () => { const result = await api<{ key: string }>("/admin/key", { licenseId: selected }); setSecret(result.key); try { await reload(); } catch { setFeedback("Chave emitida. Atualize para consultar a licença."); } })}><RefreshCw size={16} />Rotacionar chave</button><button className="danger" type="button" disabled={busy} onClick={() => confirmAction("Revogar chave", "Impedir novas ativações usando esta chave?", () => mutate("/admin/key", { licenseId: selected, revoke: true }))}><Ban size={16} />Revogar chave</button></div></form>}
            {tab === "devices" && details && <><div className="table-scroll"><table><thead><tr><th>Dispositivo</th><th>Nodus ID</th><th>Status</th><th>Ação</th></tr></thead><tbody>{pageRows(details.devices).map(device => <tr key={device.id}><td>{device.deviceName}</td><td>{device.nodusId}</td><td><Status value={device.status} /></td><td><button disabled={busy} className={device.status === "ACTIVE" ? "danger" : ""} onClick={() => confirmAction(device.status === "ACTIVE" ? "Revogar dispositivo" : "Reativar dispositivo", `${device.status === "ACTIVE" ? "Revogar" : "Reativar"} ${device.deviceName}?`, () => mutate("/admin/device", { deviceId: device.id, status: device.status === "ACTIVE" ? "REVOKED" : "ACTIVE" }))}>{device.status === "ACTIVE" ? <Ban size={15} /> : <Check size={15} />}{device.status === "ACTIVE" ? "Revogar" : "Reativar"}</button></td></tr>)}</tbody></table>{!details.devices.length && <p className="empty-state">Nenhum dispositivo vinculado.</p>}</div><Pagination total={details.devices.length} page={page} onPage={setPage} /></>}
            {tab === "payments" && <><button className="primary payment-action" disabled={busy} onClick={() => confirmAction("Registrar pagamento", "Confirmar recebimento de R$ 200,00 e renovar por 30 dias?", async () => { const paymentId = paymentAttempts.current.get(selected) ?? crypto.randomUUID(); paymentAttempts.current.set(selected, paymentId); await mutate("/admin/payment", { licenseId: selected, paymentId, amountCents: 20_000 }); paymentAttempts.current.delete(selected); })}><DollarSign size={16} />Registrar R$ 200,00</button>{details && <><div className="table-scroll"><table><thead><tr><th>Pagamento</th><th>Valor</th><th>Data</th><th>Status</th></tr></thead><tbody>{pageRows(details.payments).map(payment => <tr key={payment.paymentId}><td>{payment.paymentId}</td><td>{money(payment.amountCents)}</td><td>{date(payment.paidAt)}</td><td>{payment.status}</td></tr>)}</tbody></table>{!details.payments.length && <p className="empty-state">Nenhum pagamento registrado.</p>}</div><Pagination total={details.payments.length} page={page} onPage={setPage} /></>}</>}
            {tab === "audit" && details && <><div className="table-scroll"><table><thead><tr><th>Ação</th><th>Responsável</th><th>Data</th></tr></thead><tbody>{pageRows(details.audits).map((entry, index) => <tr key={`${entry.timestamp}-${index}`}><td>{entry.action}</td><td>{entry.adminUserId}</td><td>{date(entry.timestamp)}</td></tr>)}</tbody></table>{!details.audits.length && <p className="empty-state">Nenhuma alteração registrada.</p>}</div><Pagination total={details.audits.length} page={page} onPage={setPage} /></>}
          </div></section>}
        </>}
      </main>
    </>}
    {confirmation && <ConfirmDialog title={confirmation.title} message={confirmation.message} onCancel={() => setConfirmation(null)} onConfirm={() => { const action = confirmation.action; setConfirmation(null); run(action, true); }} />}
  </div>;
}
createRoot(document.getElementById("root")!).render(<Admin />);
