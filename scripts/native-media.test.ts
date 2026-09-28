import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import path from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { expect, test, vi } from "vitest";

const source = ts.createSourceFile("main.cjs", readFileSync("apps/desktop/electron/main.cjs", "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const declaration = source.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "startNativeMedia")!;

function fixture() {
  const child = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(), stderr: new EventEmitter(),
    stdin: { write: vi.fn() }, kill: vi.fn(),
  });
  const sender = { id: 1, isDestroyed: () => false, send: vi.fn() };
  const log = vi.fn();
  const start = runInNewContext(`${declaration.getText(source)}; startNativeMedia`, {
    path, process, Buffer, setTimeout, clearTimeout,
    fs: { existsSync: () => true }, spawn: () => child,
    nativeMedia: new Map(), nativeMediaExe: "native.exe", gstreamerRoot: "runtime",
    app: { getPath: () => "profile" }, appendLog: log,
  });
  const pending = start(sender, { sessionId: "3547ca91-60da-4920-8da5-beee681164fe", iceServers: [] });
  return { child, sender, pending, log };
}

test("startup error preserves its cause without triggering a concurrent fallback", async () => {
  const { child, sender, pending, log } = fixture();
  child.stdout.emit("data", Buffer.from('E no element "mfh264enc"\n'));
  await expect(pending).rejects.toThrow('WGC: no element "mfh264enc"');
  child.emit("close", 1);
  expect(child.kill).toHaveBeenCalledOnce();
  expect(sender.send).not.toHaveBeenCalled();
  expect(log).toHaveBeenCalledWith(expect.stringContaining('no element "mfh264enc"'));
});

test("close without an error record includes stderr after streams drain", async () => {
  const { child, pending } = fixture();
  child.stderr.emit("data", Buffer.from("plugin unavailable"));
  child.emit("exit", 1);
  child.emit("close", 1);
  await expect(pending).rejects.toThrow("WGC encerrou (1). plugin unavailable");
});

test("errors after readiness still notify the running session, without exposing TURN credentials", async () => {
  const { child, sender, pending, log } = fixture();
  child.stdout.emit("data", Buffer.from("R wgc no-cursor h264-hardware\n"));
  await expect(pending).resolves.toMatchObject({ backend: "wgc", cursorCapture: false });
  child.stdout.emit("data", Buffer.from("E rejected turn://secret:password@relay.test\n"));
  expect(sender.send).toHaveBeenCalledWith("nodus:native-media-signal", expect.objectContaining({ type: "error", message: "rejected turn://[redacted]@relay.test" }));
  expect(JSON.stringify(log.mock.calls)).not.toContain("password");
});
