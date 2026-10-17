export type UpdateDevice = { id: string; nodusId: string; deviceName: string; online: boolean; lastSeenAt: number; appVersion?: string | null; updateState?: string | null; activeSessions?: number | null };
const states: Record<string, string> = { idle: "Aguardando", checking: "Verificando", downloading: "Baixando", installing: "Instalando", current: "Verificado", deferred: "Adiada", failed: "Falhou" };
export function pilotCapable(version?: string | null) {
  if (!version || !/^\d+\.\d+\.\d+$/.test(version)) return false;
  const [major, minor, patch] = version.split(".").map(Number);
  return major > 1 || major === 1 && (minor > 1 || minor === 1 && patch >= 28);
}

export function UpdateInventory({ devices, version, pilot, selected, disabled, onSelect }: {
  devices: UpdateDevice[]; version: string; pilot: boolean; selected: string[]; disabled: boolean; onSelect(ids: string[]): void;
}) {
  return <div className="table-scroll"><table><thead><tr>{pilot && <th>Selecionar</th>}<th>Dispositivo</th><th>Versao instalada</th><th>Atualizacao</th><th>Sessoes</th><th>Ultima presenca</th></tr></thead>
    <tbody>{devices.map(device => <tr key={device.id}>
      {pilot && <td><input type="checkbox" title={pilotCapable(device.appVersion) ? "Selecionar dispositivo" : "Requer cliente 1.1.28 ou superior"} aria-label={`Incluir ${device.deviceName} no piloto`} checked={selected.includes(device.nodusId)} disabled={disabled || !selected.includes(device.nodusId) && (selected.length >= 100 || !pilotCapable(device.appVersion))} onChange={event => onSelect(event.target.checked ? [...selected, device.nodusId] : selected.filter(id => id !== device.nodusId))} /></td>}
      <td><strong>{device.deviceName}</strong><small>{device.nodusId} · {device.online ? "Online" : "Offline"}</small></td>
      <td>{device.appVersion ?? "Nao informada"}</td>
      <td>{device.appVersion && device.appVersion === version ? "Atualizado" : device.updateState === "failed" ? "Falhou" : !device.online ? "Aguardando abertura" : states[device.updateState ?? ""] ?? "Nao informado"}</td>
      <td>{device.activeSessions ?? "-"}</td><td className="date-cell">{new Date(device.lastSeenAt).toLocaleString("pt-BR")}</td>
    </tr>)}</tbody></table>{!devices.length && <p className="empty-state">Nenhum dispositivo nesta pagina.</p>}</div>;
}
