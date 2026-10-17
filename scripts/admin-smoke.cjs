const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const playwrightPath = process.env.NODUS_PLAYWRIGHT || path.join(process.env.USERPROFILE, ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright");
const { chromium } = require(playwrightPath);
const base = process.env.NODUS_ADMIN_TEST_URL || "http://127.0.0.1:5190";

(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.NODUS_CHROMIUM ? { executablePath: process.env.NODUS_CHROMIUM } : {}) });
  const output = path.resolve("work/admin-validation"); fs.mkdirSync(output, { recursive: true });
  try {
    const page = await browser.newPage(), errors = [], mutations = [], now = Date.now();
    page.on("pageerror", error => errors.push(error.message));
    let supported = true, policy = { enabled: false, updatedAt: 0, release: null, targetNodusIds: [] };
    const devices = [
      { id: "one", nodusId: "123456789", deviceName: "Piloto", status: "ACTIVE", licenseId: "free-one", online: true, lastSeenAt: now, appVersion: "1.1.28", updateState: "idle", activeSessions: 1 },
      { id: "old", nodusId: "987654321", deviceName: "Legado", status: "ACTIVE", licenseId: "free-old", online: false, lastSeenAt: now, appVersion: "1.1.27", updateState: "failed", activeSessions: 0 },
    ];
    await page.route("**/*", route => route.request().url().startsWith(`${base}/`) || route.request().url().startsWith("data:") ? route.continue() : route.abort());
    await page.route("**/node_modules/.vite/deps/firebase_auth.js*", route => route.fulfill({ contentType: "application/javascript", body: `
      const user={uid:'fixture-admin',displayName:'Administrador',email:'admin@example.test',getIdToken:async()=> 'fixture-token',getIdTokenResult:async()=>({authTime:new Date().toISOString()})};
      const auth={currentUser:user};export const getAuth=()=>auth,inMemoryPersistence={},setPersistence=async()=>{},reauthenticateWithPopup=async()=>{},signInWithPopup=async()=>{},signOut=async()=>{};
      export class GoogleAuthProvider{setCustomParameters(){}}export function onAuthStateChanged(a,fn){queueMicrotask(()=>fn(user));return()=>{}}
    ` }));
    await page.route("https://nodus-connect-license.vercel.app/**", async route => {
      const request = route.request(), url = new URL(request.url()), body = JSON.parse(request.postData() || "{}");
      let value = {};
      if (request.method() === "POST") mutations.push({ path: url.pathname, body });
      if (url.pathname === "/admin/dashboard") value = { organizations: 0, active: 0, devices: 2, online: 1, pendingRequests: 0, trials: 2, suspended: 0, mrrCents: 0 };
      else if (["/admin/organizations", "/admin/access-requests"].includes(url.pathname)) value = [];
      else if (url.pathname === "/admin/devices") value = url.searchParams.get("paged") ? { items: devices, nextCursor: null } : devices;
      else if (url.pathname === "/admin/desktop-releases") value = ["1.1.29", "1.1.28", "1.1.27"];
      else if (url.pathname === "/admin/desktop-update") {
        if (request.method() === "POST") policy = { ...policy, ...body, updatedAt: Date.now(), release: body.enabled ? { tag_name: `v${body.version}`, assets: [] } : policy.release };
        value = { ...policy, pilotSupported: supported };
      }
      await route.fulfill({ contentType: "application/json", body: JSON.stringify(value) });
    });
    await page.goto(base); await page.locator(".summary-grid").waitFor();
    await page.locator(".admin-nav").getByRole("button", { name: "Atualizações", exact: true }).click();
    await page.getByLabel("Versão publicada").selectOption("1.1.29");
    await page.getByLabel("Destino da atualizacao", { exact: true }).selectOption("pilot");
    await page.getByText("Piloto", { exact: true }).waitFor();
    assert.ok(await page.getByRole("button", { name: "Liberar para o piloto" }).isDisabled());
    assert.ok(await page.getByRole("checkbox", { name: "Incluir Legado no piloto" }).isDisabled());
    await page.getByRole("checkbox", { name: "Incluir Piloto no piloto" }).check();
    await page.getByRole("button", { name: "Liberar para o piloto" }).click();
    await page.getByRole("button", { name: "Cancelar", exact: true }).click(); assert.equal(mutations.length, 0);
    await page.getByRole("button", { name: "Liberar para o piloto" }).click(); await page.getByRole("button", { name: "Confirmar", exact: true }).click();
    await page.getByText("Alteração registrada e sincronizada.").waitFor();
    assert.deepEqual(mutations[0].body, { enabled: true, version: "1.1.29", targetNodusIds: ["123456789"] });
    for (const [width, height] of [[1366, 768], [768, 1024], [320, 740]]) {
      await page.setViewportSize({ width, height });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `Root overflow: ${width}`);
      await page.screenshot({ path: path.join(output, `updates-${width}.png`), fullPage: true });
    }
    await page.getByRole("button", { name: "Pausar distribuição" }).click(); await page.getByRole("button", { name: "Confirmar", exact: true }).click();
    await page.getByText("Pausada", { exact: true }).waitFor();
    supported = false; policy.targetNodusIds = [];
    await page.getByRole("button", { name: "Atualizar", exact: true }).click();
    await page.waitForFunction(() => document.querySelector('option[value="pilot"]')?.disabled);
    assert.equal(errors.length, 0, JSON.stringify(errors));
    console.log(JSON.stringify({ passed: true, productionRequests: 0, viewports: [1366, 768, 320], mutations, screenshots: output }));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
