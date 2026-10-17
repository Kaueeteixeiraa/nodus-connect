import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { pilotCapable, UpdateInventory } from "./UpdateInventory";

describe("update inventory", () => {
  it("never targets clients which lack pilot support", () => {
    for (const version of [undefined, null, "invalid", "1.1.27", "1.0.90"]) expect(pilotCapable(version)).toBe(false);
    for (const version of ["1.1.28", "1.1.100", "1.2.0", "2.0.0"]) expect(pilotCapable(version)).toBe(true);
  });
  it("distinguishes confirmed versions, failed updates and offline devices", () => {
    const devices = [
      { id: "a", nodusId: "123456789", deviceName: "Atual", appVersion: "1.1.28", online: true, lastSeenAt: 1000, activeSessions: 1 },
      { id: "b", nodusId: "987654321", deviceName: "Falha", appVersion: "1.1.27", online: true, lastSeenAt: 1000, updateState: "failed" },
      { id: "c", nodusId: "111222333", deviceName: "Desligado", online: false, lastSeenAt: 1000 },
    ];
    const html = renderToStaticMarkup(<UpdateInventory devices={devices} version="1.1.28" pilot selected={[]} disabled={false} onSelect={vi.fn()} />);
    for (const text of ["Atualizado", "Falhou", "Aguardando abertura", "Nao informada"]) expect(html).toContain(text);
    expect((html.match(/disabled=""/g) ?? []).length).toBe(2);
  });
});
