import { createRelayServer } from "./relay.js";

const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? "0.0.0.0";

createRelayServer().listen(PORT, HOST, () => {
  console.log(`Nodus Coordination Server listening on http://${HOST}:${PORT}`);
});
