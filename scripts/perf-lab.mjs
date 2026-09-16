import WebSocket from "ws";

const [port, expression] = process.argv.slice(2);
if (!port || !expression) throw new Error("Uso: node scripts/perf-lab.mjs <porta-cdp> <expressao-js>");

const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const target = targets.find((entry) => entry.type === "page");
if (!target) throw new Error(`Nenhuma pagina na porta ${port}`);
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.once("open", resolve);
  socket.once("error", reject);
});
let id = 0;
const call = (method, params) => new Promise((resolve, reject) => {
  const requestId = ++id;
  const receive = (message) => {
    const response = JSON.parse(String(message));
    if (response.id !== requestId) return;
    socket.off("message", receive);
    response.error || response.result?.exceptionDetails
      ? reject(new Error(JSON.stringify(response.error || response.result.exceptionDetails)))
      : resolve(response.result);
  };
  socket.on("message", receive);
  socket.send(JSON.stringify({ id: requestId, method, params }));
});
const result = (await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })).result?.value;
socket.close();
console.log(typeof result === "string" ? result : JSON.stringify(result));
