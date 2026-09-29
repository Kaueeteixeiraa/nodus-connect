import { EventEmitter, once } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { runInNewContext } from "node:vm";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";
import ts from "typescript";
import { afterEach, expect, test, vi } from "vitest";
import { shouldHideHostCursor } from "../apps/desktop/src/core/remote-cursor";

const { RemoteCursorVisibility } = createRequire(import.meta.url)("../apps/desktop/electron/remote-cursor-visibility.cjs");
const controllers: any[] = [];
afterEach(() => { controllers.splice(0).forEach((cursor) => cursor.dispose()); vi.useRealTimers(); });

function fixture() {
  vi.useFakeTimers();
  const child = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(), stderr: new EventEmitter(),
    stdin: Object.assign(new EventEmitter(), { write: vi.fn(), end: vi.fn() }),
  });
  const launch = vi.fn(() => child), log = vi.fn();
  const cursor = new RemoteCursorVisibility({ spawn: launch, executable: "native.exe", log });
  controllers.push(cursor);
  return { cursor, child, launch, log };
}

test("active host starts a visibility worker without input or streaming commands", () => {
  const { cursor, child, launch } = fixture();
  cursor.setActive(true);
  expect(launch).toHaveBeenCalledWith("native.exe", ["--cursor-visibility-helper", String(process.pid)], expect.objectContaining({ windowsHide: true }));
  expect(child.stdin.write).toHaveBeenCalledWith("H");
});

test("helper launch failure cannot reject session startup or loop on each heartbeat", () => {
  const { cursor, launch, log } = fixture();
  launch.mockImplementation(() => { throw new Error("spawn denied"); });
  expect(() => cursor.setActive(true)).not.toThrow();
  cursor.setActive(true);
  expect(launch).toHaveBeenCalledOnce();
  expect(log).toHaveBeenCalledWith(expect.stringContaining("spawn denied"));
});

test("repeated hide and restore calls are idempotent", () => {
  const { cursor, child, launch } = fixture();
  cursor.setActive(true); cursor.setActive(true); cursor.setActive(true);
  expect(launch).toHaveBeenCalledOnce();
  cursor.setActive(false); cursor.setActive(false);
  expect(child.stdin.end).toHaveBeenCalledExactlyOnceWith("R");
});

test("only remote mouse activity in an active host lease requests hiding", () => {
  const { cursor, child } = fixture();
  cursor.remoteMouseActivity({ type: "mouseMove" });
  expect(child.stdin.write).not.toHaveBeenCalled();
  cursor.setActive(true);
  child.stdin.write.mockClear();
  for (const type of ["keyDown", "keyUp", "invalid"]) cursor.remoteMouseActivity({ type });
  expect(child.stdin.write).not.toHaveBeenCalled();
  for (const type of ["mouseMove", "mouseDown", "mouseUp", "wheel"]) cursor.remoteMouseActivity({ type });
  expect(child.stdin.write.mock.calls).toEqual([["M"], ["M"], ["M"], ["M"]]);
  cursor.setActive(false);
  cursor.remoteMouseActivity({ type: "mouseMove" });
  expect(child.stdin.write).toHaveBeenCalledTimes(4);
});

test("mouse visibility pipe failure does not throw into input injection", () => {
  const { cursor, child } = fixture();
  cursor.setActive(true);
  child.stdin.write.mockImplementation(() => { throw new Error("broken visibility pipe"); });
  expect(() => cursor.remoteMouseActivity({ type: "mouseMove" })).not.toThrow();
  expect(child.stdin.end).toHaveBeenCalledWith("R");
});

test("renderer heartbeat timeout restores even when Electron is still alive", async () => {
  const { cursor, child } = fixture();
  cursor.setActive(true);
  await vi.advanceTimersByTimeAsync(5000);
  expect(child.stdin.end).toHaveBeenCalledExactlyOnceWith("R");
});

test("reconnection waits for the old helper/watchdog to exit", () => {
  const { cursor, child, launch } = fixture();
  cursor.setActive(true); cursor.setActive(false); cursor.setActive(true);
  expect(launch).toHaveBeenCalledOnce();
  child.emit("close", 0);
  expect(launch).toHaveBeenCalledTimes(2);
});

test("stdin/process error requests immediate restoration and avoids restart loops", () => {
  const { cursor, child, launch, log } = fixture();
  cursor.setActive(true);
  child.stdin.emit("error", new Error("broken pipe"));
  expect(child.stdin.end).toHaveBeenCalledWith("R");
  child.emit("close", 1);
  cursor.setActive(true);
  expect(launch).toHaveBeenCalledOnce();
  expect(log).toHaveBeenCalledWith(expect.stringContaining("broken pipe"));
});

test("unexpected helper exit never claims that cursor restoration was confirmed", () => {
  const { cursor, child, log } = fixture();
  cursor.setActive(true);
  child.emit("close", 1);
  expect(log).toHaveBeenCalledWith(expect.stringContaining("watchdog restoration required"));
  expect(log).not.toHaveBeenCalledWith("[CURSOR] Local host cursor restored");
});

test("shutdown restores and prevents any future hiding", () => {
  const { cursor, child, launch } = fixture();
  cursor.setActive(true); cursor.dispose(); cursor.setActive(true);
  expect(child.stdin.end).toHaveBeenCalledWith("R");
  expect(launch).toHaveBeenCalledOnce();
});

test("native acknowledgement logs are preserved across fragmented stdout", () => {
  const { cursor, child, log } = fixture();
  cursor.setActive(true);
  child.stdout.emit("data", Buffer.from("[CURSOR] Local host cur"));
  child.stdout.emit("data", Buffer.from("sor hidden\n[CURSOR] Local host cursor restored\n"));
  expect(log).toHaveBeenCalledWith("[CURSOR] Local host cursor hidden");
  expect(log).toHaveBeenCalledWith("[CURSOR] Local host cursor restored");
});

function functionSource(file: string, name: string) {
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, file.endsWith("tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.JS);
  let text = "";
  function visit(node: ts.Node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) text = node.getText(source);
    ts.forEachChild(node, visit);
  }
  visit(source);
  expect(text).not.toBe("");
  return text;
}
const hash = (text: string) => createHash("sha256").update(text.replace(/\r\n/g, "\n")).digest("hex");
const functionHash = (file: string, name: string) => hash(functionSource(file, name));

test("ending one host session keeps hiding only while another controlled host is connected", () => {
  const setActive = vi.fn(async () => {});
  const peers = new Map([ ["a", { connectionState: "connected" }], ["b", { connectionState: "connected" }], ["viewer", { connectionState: "connected" }] ]);
  const sessions = ["a", "b", "viewer"].map((id) => ({ session: { sessionId: id, role: id === "viewer" ? "viewer" : "host", permissions: ["mouse:control"] }, error: "" }));
  const source = ts.transpile(functionSource("apps/desktop/src/App.tsx", "syncHostCursorVisibility"), { target: ts.ScriptTarget.ES2022 });
  const sync = runInNewContext(`${source}; syncHostCursorVisibility`, {
    shouldHideHostCursor, sessionsRef: { current: sessions }, peersRef: { current: peers },
    settings: { allowRemoteControl: true }, window: { nodusDesktop: { setHostCursorActive: setActive } },
  });
  sync("a");
  expect(setActive).toHaveBeenLastCalledWith(true);
  peers.get("b")!.connectionState = "failed";
  sync("a");
  expect(setActive).toHaveBeenLastCalledWith(false);
});

test("Chromium acquisition requests native resolution and never less than 30 FPS", () => {
  const source = functionSource("apps/desktop/src/App.tsx", "captureConstraints");
  expect(source).toContain("boundedFrameRate");
  expect(source).toContain("cursor: { ideal: \"never\" }");
  expect(source).toContain("resolutionForSource");
});

test("mouse injection and packet coordinates remain exactly unchanged", () => {
  const inputSource = functionSource("apps/desktop/electron/main.cjs", "applyRemoteInput").replace(/\r\n/g, "\n");
  expect(inputSource).toContain('helper.stdin.write(helper.nodusBinaryInput ? encodeRemoteInput(message) : `${JSON.stringify(message)}\\n`);\n    hostCursorVisibility?.remoteMouseActivity(message);');
  expect(hash(inputSource.replace("    hostCursorVisibility?.remoteMouseActivity(message);\n", ""))).toBe("04aa1af9f01261fd9e9f3a2b67dbca98a25c6fae6bdfec79120a9a79808fc03a");
  expect(functionHash("apps/desktop/electron/main.cjs", "encodeRemoteInput")).toBe("264100b5230a7b7313711e3d093c4a2c2fa12d89579db71999dd543b476a7200");
  expect(hash(readFileSync("native/service/main.cpp", "utf8").replace(/\r\n/g, "\n").match(/int runInputHelper\(\) \{[\s\S]*?\n\}/)![0])).toBe("4ff03effd2d9861c9c2e4c76b2d75161edd99d1f2e8086cec477864f1e2ddc9d");
});

test("WGC lifecycle preserves the native streaming pipeline and 30-120 FPS bounds", () => {
  expect(functionSource("apps/desktop/src/App.tsx", "startHostNativeMedia")).toContain("Math.max(30, Math.min(120");
  expect(hash(readFileSync("native/wgc-media/main.cpp", "utf8"))).toBe("14d664039d7367f65f611cf474f9604d1d1732bfa2313606a6ea1ebf491befb9");
});

const native = path.resolve("native/bin/nodus-service.exe");
const nativeTest = test.skipIf(process.platform !== "win32" || !existsSync(native));

async function nativeFixture() {
  // Real watchdog/process lifecycle, but no changes to the user's actual cursor.
  const parent = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { windowsHide: true, stdio: "ignore" });
  const child = spawn(native, ["--cursor-visibility-helper", String(parent.pid), "--dry-run"], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (data) => { output += data; });
  const closed = once(child, "close");
  child.stdin.on("error", () => {});
  child.stdin.write("HHH");
  for (let i = 0; i < 60 && !output.includes("hidden (dry run)"); i++) await delay(50);
  if (!output.includes("hidden (dry run)")) {
    child.stdin.end("R"); parent.kill(); await closed;
    throw new Error(`Native watchdog did not arm: ${output}`);
  }
  return { child, parent, closed, output: () => output };
}

nativeTest("physical movement shows the cursor until new remote mouse activity, not heartbeat (dry run)", async () => {
  const fixture = await nativeFixture();
  async function waitForCount(text: string, count: number) {
    for (let i = 0; i < 40 && fixture.output().split(text).length - 1 < count; i++) await delay(25);
    expect(fixture.output().split(text).length - 1).toBe(count);
  }
  try {
    expect(fixture.output()).toContain("Physical mouse monitor ready");
    fixture.child.stdin.write("LHHH");
    await waitForCount("Local host cursor restored (dry run)", 1);
    await delay(100);
    expect(fixture.output().match(/hidden \(dry run\)/g)).toHaveLength(1);
    fixture.child.stdin.write("MMMHHH");
    await waitForCount("Local host cursor hidden (dry run)", 2);
    fixture.child.stdin.write("LLHHH");
    await waitForCount("Local host cursor restored (dry run)", 2);
    fixture.child.stdin.write("M");
    await waitForCount("Local host cursor hidden (dry run)", 3);
    fixture.child.stdin.end("R");
    await fixture.closed;
    expect(fixture.output().match(/restored \(dry run\)/g)).toHaveLength(3);
  } finally {
    fixture.child.stdin.destroy(); fixture.child.kill(); fixture.parent.kill();
  }
}, 15000);

nativeTest.each(["restore", "pipe-close", "parent-crash", "helper-crash", "watchdog-crash", "lease-timeout"])("native watchdog recovers after %s (dry run)", async (event) => {
  const fixture = await nativeFixture();
  try {
    if (event === "restore") fixture.child.stdin.end("RR");
    if (event === "pipe-close") fixture.child.stdin.end();
    if (event === "parent-crash") fixture.parent.kill();
    if (event === "helper-crash") fixture.child.kill();
    if (event === "watchdog-crash") process.kill(Number(fixture.output().match(/watchdog armed pid=(\d+)/)![1]));
    await fixture.closed;
    expect(fixture.output().match(/hidden \(dry run\)/g)).toHaveLength(1);
    expect(fixture.output()).toContain("Local host cursor restored (dry run)");
  } finally {
    fixture.child.stdin.destroy(); fixture.child.kill(); fixture.parent.kill();
  }
}, 15000);
