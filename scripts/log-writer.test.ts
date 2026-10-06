import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";

const { createLogWriter } = require("../apps/desktop/electron/log-writer.cjs");
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
