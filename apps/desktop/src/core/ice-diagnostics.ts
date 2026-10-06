type Stat = { id: string; type: string; [key: string]: unknown };
type Candidate = { type: string; protocol: string; relayProtocol: string | null; priority: number | null; server: string | null };

export function iceServerInfo(url: string) {
  const match = url.match(/^(stun|stuns|turn|turns):(.+)$/i);
  if (!match) return null;
  try {
    const parsed = new URL(`https://${match[2]}`);
    return { type: match[1].toLowerCase(), host: parsed.hostname, transport: parsed.searchParams.get("transport")?.toUpperCase() ?? (match[1].toLowerCase() === "turns" ? "TLS" : null) };
  } catch { return null; }
}

export function withConfiguredStun(primary: RTCIceServer[], configured: RTCIceServer[]): RTCIceServer[] {
  const urls = (server: RTCIceServer) => (Array.isArray(server.urls) ? server.urls : [server.urls]).filter(Boolean);
  const hasStun = primary.some((server) => urls(server).some((url) => /^stuns?:/i.test(url)));
  const servers = !primary.length ? configured : hasStun ? primary : [...configured.flatMap((server) => urls(server).filter((url) => /^stuns?:/i.test(url)).map((url) => ({ urls: url }))), ...primary];
  const rank = (url: string) => /^stuns?:/i.test(url) ? 0 : /^turn:.*transport=tcp/i.test(url) ? 2 : /^turns:/i.test(url) ? 3 : /^turn:/i.test(url) ? 1 : 4;
  return servers.flatMap((server) => urls(server).map((url) => ({ ...server, urls: url })))
    .sort((left, right) => rank(left.urls) - rank(right.urls));
}

export function holdSelectedRoute(previous: { route: "direct" | "relay"; transport: string; at: number } | undefined,
  route: "direct" | "relay" | "unknown", transport: string, now: number) {
  if (route !== "unknown") return { route, transport, at: now };
  return previous && now - previous.at <= 5000 ? previous : null;
}

export function iceSignalCandidate(candidate: string) {
  const match = candidate.match(/^candidate:\S+\s+\d+\s+(\S+)\s+(\d+)\s+\S+\s+\d+\s+typ\s+(\S+)/i);
  return { type: match?.[3]?.toLowerCase() ?? "unknown", protocol: match?.[1]?.toUpperCase() ?? "unknown", priority: match ? Number(match[2]) : null };
}

export function inspectIceStats(records: Iterable<Stat>) {
  const stats = [...records];
  const candidates = new Map<string, Candidate>();
  const counts = { local: { host: 0, srflx: 0, relay: 0, prflx: 0 }, remote: { host: 0, srflx: 0, relay: 0, prflx: 0 } };
  for (const item of stats) {
    if (item.type !== "local-candidate" && item.type !== "remote-candidate") continue;
    const type = String(item.candidateType ?? "unknown");
    const side = item.type === "local-candidate" ? "local" : "remote";
    if (type in counts[side]) counts[side][type as keyof typeof counts.local]++;
    candidates.set(item.id, { type, protocol: String(item.protocol ?? "unknown").toUpperCase(), relayProtocol: item.relayProtocol ? String(item.relayProtocol).toUpperCase() : null,
      priority: typeof item.priority === "number" ? item.priority : null, server: typeof item.url === "string" ? iceServerInfo(item.url)?.host ?? null : null });
  }
  const pairs = stats.filter((item) => item.type === "candidate-pair");
  const selectedId = stats.find((item) => item.type === "transport" && item.selectedCandidatePairId)?.selectedCandidatePairId;
  const selected = pairs.find((item) => item.id === selectedId) ?? pairs.find((item) => item.selected === true) ?? null;
  const directPairs = pairs.filter((item) => {
    const local = candidates.get(String(item.localCandidateId ?? ""));
    const remote = candidates.get(String(item.remoteCandidateId ?? ""));
    return local && remote && local.type !== "relay" && remote.type !== "relay";
  });
  const local = selected ? candidates.get(String(selected.localCandidateId ?? "")) ?? null : null;
  const remote = selected ? candidates.get(String(selected.remoteCandidateId ?? "")) ?? null : null;
  const route: "relay" | "direct" | "unknown" = local && remote ? local.type === "relay" || remote.type === "relay" ? "relay" : "direct" : "unknown";
  const directSucceeded = directPairs.some((item) => item.state === "succeeded");
  const directFailed = directPairs.length > 0 && directPairs.every((item) => item.state === "failed");
  const classification = route === "direct" || directSucceeded ? "DIRECT AVAILABLE" : route === "relay" && directFailed ? "DIRECT FAILED" : "UNKNOWN";
  return {
    counts,
    selected: selected ? { id: selected.id, state: String(selected.state ?? "unknown"), nominated: selected.nominated === true, writable: typeof selected.writable === "boolean" ? selected.writable : null,
      bytesSent: Number(selected.bytesSent ?? 0), bytesReceived: Number(selected.bytesReceived ?? 0), rttMs: typeof selected.currentRoundTripTime === "number" ? Math.round(selected.currentRoundTripTime * 1000) : null,
      availableOutgoingBitrate: typeof selected.availableOutgoingBitrate === "number" ? selected.availableOutgoingBitrate : null,
      local, remote, route } : null,
    directPairs: { attempted: directPairs.length > 0, succeeded: directSucceeded, failed: directPairs.filter((item) => item.state === "failed").length, checking: directPairs.filter((item) => item.state === "in-progress").length },
    classification,
    failureReason: directFailed ? "DIRECT_PAIR_CHECKS_FAILED" : route === "relay" && !directPairs.length ? "NO_DIRECT_PAIR_STATS" : null,
  };
}
