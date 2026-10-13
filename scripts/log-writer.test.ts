import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, utimesSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";

const { createLogWriter } = require("../apps/desktop/electron/log-writer.cjs");
const { createFileStorage } = require("../apps/desktop/electron/file-storage.cjs");
const { pruneCache } = require("../apps/desktop/electron/desktop-update.cjs");
const directories: string[] = [];

afterEach(() => directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })));

test("serializes log writes and rotates files at the configured limit", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "nodus-log-"));
  directories.push(directory);
  const writer = createLogWriter(directory, 90);
  await writer.append("first record", "performance.log");
  await writer.append("second record that forces rotation", "performance.log");
  expect(readFileSync(path.join(directory, "performance.log"), "utf8")).toContain("second record");
  expect(readFileSync(path.join(directory, "performance.log.1"), "utf8")).toContain("first record");
});

test("file storage streams ordered chunks and never overwrites an existing file", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "nodus-files-")); directories.push(directory);
  writeFileSync(path.join(directory, "sample.bin"), "existing");
  const storage = createFileStorage(directory), { id } = await storage.begin(1, "sample.bin", 4);
  const first = storage.append(1, id, new Uint8Array([1, 2]));
  const second = storage.append(1, id, new Uint8Array([3, 4]));
  const finished = storage.finish(1, id);
  await Promise.all([first, second]);
  const result = await finished;
  expect(result).toMatchObject({ ok: true, name: "sample (1).bin", bytes: 4 });
  expect([...readFileSync(result.path)]).toEqual([1, 2, 3, 4]);
  expect(readFileSync(path.join(directory, "sample.bin"), "utf8")).toBe("existing");
  expect(readdirSync(directory).some(name => name.endsWith(".part"))).toBe(false);
});

test("file storage rejects incorrect sizes and owners and removes partial files", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "nodus-files-")); directories.push(directory);
  const storage = createFileStorage(directory), { id } = await storage.begin(1, "CON.bin", 4);
  expect(() => storage.append(2, id, new Uint8Array([1]))).toThrow("INVALID_TRANSFER");
  await storage.append(1, id, new Uint8Array([1]));
  await expect(storage.finish(1, id)).rejects.toThrow("FILE_SIZE_MISMATCH");
  await storage.cancel(2, id); expect(readdirSync(directory)).toHaveLength(1);
  await storage.release(1); expect(readdirSync(directory)).toEqual([]);
});

test("recording storage accepts incremental output and bounds concurrent starts", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "nodus-files-")); directories.push(directory);
  const storage = createFileStorage(directory);
  const starts = await Promise.allSettled(Array.from({ length: 9 }, (_, index) => storage.begin(1, `${index}.webm`, 100, true)));
  expect(starts.filter(result => result.status === "fulfilled")).toHaveLength(8);
  const first = starts[0]; if (first.status !== "fulfilled") throw new Error("START_FAILED");
  await storage.append(1, first.value.id, new Uint8Array([1, 2]));
  expect(await storage.finish(1, first.value.id)).toMatchObject({ bytes: 2 });
  await storage.release(1);
  expect(readdirSync(directory)).toEqual(["0.webm"]);
});

test("cache pruning preserves current, recent and unmanaged files without following directories", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "nodus-cache-")); directories.push(directory);
  const current = `${"a".repeat(64)}.exe`, recent = `${"b".repeat(64)}.exe`, obsolete = `${"c".repeat(64)}.exe`;
  for (const [index, name] of [current, recent, obsolete, "personal.exe", "automatic-attempt.json"].entries()) {
    const file = path.join(directory, name); writeFileSync(file, name);
    utimesSync(file, new Date(Date.now() - (index + 1) * 86_400_000), new Date(Date.now() - (index + 1) * 86_400_000));
  }
  await pruneCache(directory, current);
  expect(existsSync(path.join(directory, current))).toBe(true);
  expect(existsSync(path.join(directory, recent))).toBe(true);
  expect(existsSync(path.join(directory, obsolete))).toBe(false);
  expect(existsSync(path.join(directory, "personal.exe"))).toBe(true);
  expect(existsSync(path.join(directory, "automatic-attempt.json"))).toBe(true);
  await expect(pruneCache(path.parse(directory).root, current)).rejects.toThrow("INVALID_CACHE_DIRECTORY");
});
