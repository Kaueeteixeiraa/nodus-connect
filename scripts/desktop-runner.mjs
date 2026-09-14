import { spawn } from "node:child_process";

const mode = process.argv[2] === "start" ? "start" : "dev";
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const spawnOptions = { shell: process.platform === "win32", stdio: "inherit" };
const children = [];

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

if (mode === "start") {
  await runOnce("build", [pnpm, ["build"]]);
}

const coordination = run("coordination", pnpm, ["dev:coordination"]);
await waitFor("http://127.0.0.1:8787/health");

let desktopUrl = "";
let vite;
if (mode === "dev") {
  vite = run("vite", pnpm, ["dev:desktop"]);
  await waitFor("http://127.0.0.1:5173");
  desktopUrl = "http://127.0.0.1:5173";
}

const electronEnv = {
  ...process.env,
  NODUS_DESKTOP_DEV: mode === "dev" ? "1" : "0",
  NODUS_DESKTOP_URL: desktopUrl,
};
const electron = run("electron", pnpm, ["exec", "electron", "apps/desktop/electron/main.cjs"], electronEnv);

electron.on("exit", shutdown);
coordination.on("exit", (code) => {
  if (code) shutdown(code);
});
vite?.on("exit", (code) => {
  if (code) shutdown(code);
});

function run(name, command, args, env = process.env) {
  const child = spawn(command, args, { ...spawnOptions, env });
  children.push(child);
  child.on("error", (error) => {
    console.error(`[${name}] ${error.message}`);
    shutdown(1);
  });
  return child;
}

function runOnce(name, command) {
  const [cmd, args] = command;
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, spawnOptions);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${name} failed with ${code}`))));
    child.on("error", reject);
  });
}

async function waitFor(url) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 30_000) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw new Error(`Timeout waiting for ${url}`);
}

function shutdown(code = 0) {
  for (const child of children) {
    if (!child.killed) child.kill();
  }
  process.exit(Number(code) || 0);
}
