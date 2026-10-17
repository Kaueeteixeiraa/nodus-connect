import { useRef, useState } from "react";
import { Activity, LoaderCircle } from "lucide-react";

export function SupportReportButton({ onExport }: { onExport: () => Promise<{ canceled: boolean }> }) {
  const pending = useRef(false), [busy, setBusy] = useState(false), [status, setStatus] = useState("");
  async function exportReport() {
    if (pending.current) return;
    pending.current = true; setBusy(true); setStatus("");
    try { const result = await onExport(); if (!result.canceled) setStatus("Relatorio exportado."); }
    catch { setStatus("Nao foi possivel exportar o relatorio."); }
    finally { pending.current = false; setBusy(false); }
  }
  return <div className="settings-backup-actions"><button className="secondary-button themed-action" disabled={busy} aria-busy={busy} type="button" onClick={exportReport}>
    {busy ? <LoaderCircle size={16} aria-hidden="true" className="is-checking" /> : <Activity size={16} aria-hidden="true" />}Exportar relatorio de suporte
  </button>{status && <span role="status" aria-live="polite">{status}</span>}</div>;
}
