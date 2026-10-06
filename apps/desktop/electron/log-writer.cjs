const fs = require("node:fs");
const path = require("node:path");

function createLogWriter(directory, maxBytes = 8 * 1024 * 1024) {
  const sizes = new Map();
  let pending = Promise.resolve();

  async function write(message, filename) {
    const safeName = /^[\w.-]+$/.test(filename) ? filename : "desktop.log";
    const logDir = typeof directory === "function" ? directory() : directory;
    const file = path.join(logDir, safeName);
    const line = `[${new Date().toISOString()}] ${message}\n`;
    await fs.promises.mkdir(logDir, { recursive: true });
    let size = sizes.get(file);
    if (size === undefined) size = await fs.promises.stat(file).then((entry) => entry.size).catch(() => 0);
    const bytes = Buffer.byteLength(line);
    if (size + bytes > maxBytes) {
      await fs.promises.rm(`${file}.1`, { force: true });
      await fs.promises.rename(file, `${file}.1`).catch((error) => {
        if (error?.code !== "ENOENT") throw error;
      });
      size = 0;
    }
    await fs.promises.appendFile(file, line);
    sizes.set(file, size + bytes);
  }

  return {
    append(message, filename = "desktop.log") {
      pending = pending.then(() => write(message, filename)).catch(() => undefined);
      return pending;
    },
    flush() {
      return pending;
    },
  };
}

module.exports = { createLogWriter };
