const fs = require("node:fs/promises");
const { constants } = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

function createFileStorage(directory) {
  const entries = new Map();
  const pendingBegins = new Map(), generations = new Map();
  const requireEntry = (owner, id) => {
    const entry = entries.get(id);
    if (!entry || entry.owner !== owner || entry.closed || entry.finalizing) throw new Error("INVALID_TRANSFER");
    return entry;
  };
  return {
    async begin(owner, fileName, size, recording = false) {
      if (!Number.isSafeInteger(size) || size < 0 || size > (recording ? 4 * 1024 ** 3 : 256 * 1024 ** 2)
        || [...entries.values()].filter(entry => entry.owner === owner).length + (pendingBegins.get(owner) ?? 0) >= 8) throw new Error("INVALID_FILE");
      const generation = generations.get(owner);
      pendingBegins.set(owner, (pendingBegins.get(owner) ?? 0) + 1);
      try {
      let name = path.basename(String(fileName)).replace(/[<>:"/\\|?*\x00-\x1F]/g, "_").replace(/[. ]+$/, "").slice(0, 180) || "arquivo";
      if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(name)) name = `_${name}`;
      const root = typeof directory === "function" ? directory() : directory;
      await fs.mkdir(root, { recursive: true });
      const id = randomUUID(), temporary = path.join(root, `.nodus-${id}.part`);
      const handle = await fs.open(temporary, "wx");
      if (generations.get(owner) !== generation) {
        await handle.close(); await fs.unlink(temporary); throw new Error("TRANSFER_OWNER_CLOSED");
      }
      entries.set(id, { owner, name, root, temporary, handle, size, recording, bytes: 0, closed: false, pending: Promise.resolve() });
      return { id };
      } finally { pendingBegins.set(owner, pendingBegins.get(owner) - 1); }
    },
    append(owner, id, data) {
      const entry = requireEntry(owner, id);
      const bytes = data instanceof ArrayBuffer ? Buffer.from(data) : ArrayBuffer.isView(data) ? Buffer.from(data.buffer, data.byteOffset, data.byteLength) : null;
      if (!bytes || bytes.length > 256 * 1024) throw new Error("INVALID_CHUNK");
      entry.pending = entry.pending.then(async () => {
        if (entry.closed || entry.bytes + bytes.length > entry.size) throw new Error("FILE_SIZE_MISMATCH");
        let offset = 0;
        while (offset < bytes.length) {
          const { bytesWritten } = await entry.handle.write(bytes, offset, bytes.length - offset, entry.bytes + offset);
          if (!bytesWritten) throw new Error("FILE_WRITE_FAILED");
          offset += bytesWritten;
        }
        entry.bytes += bytes.length;
      });
      return entry.pending.then(() => ({ bytes: entry.bytes }));
    },
    async finish(owner, id) {
      const entry = requireEntry(owner, id);
      entry.finalizing = true;
      await entry.pending;
      if (entry.closed) throw new Error("INVALID_TRANSFER");
      if (!entry.recording && entry.bytes !== entry.size) throw new Error("FILE_SIZE_MISMATCH");
      entry.closed = true;
      await entry.handle.sync();
      await entry.handle.close();
      const parsed = path.parse(entry.name);
      for (let index = 0; index < 10_000; index++) {
        const name = index ? `${parsed.name} (${index})${parsed.ext}` : entry.name;
        const destination = path.join(entry.root, name);
        try {
          try { await fs.link(entry.temporary, destination); }
          catch (error) {
            if (!["EPERM", "ENOTSUP", "EXDEV", "EOPNOTSUPP"].includes(error.code)) throw error;
            await fs.copyFile(entry.temporary, destination, constants.COPYFILE_EXCL);
          }
          await fs.unlink(entry.temporary);
          entries.delete(id);
          return { ok: true, name, path: destination, bytes: entry.bytes };
        } catch (error) { if (error.code !== "EEXIST") throw error; }
      }
      throw new Error("FILE_NAME_LIMIT");
    },
    async cancel(owner, id) {
      const entry = entries.get(id);
      if (!entry || entry.owner !== owner) return;
      entry.closed = true;
      await entry.pending.catch(() => undefined);
      await entry.handle.close().catch(() => undefined);
      await fs.unlink(entry.temporary).catch(error => { if (error.code !== "ENOENT") throw error; });
      entries.delete(id);
    },
    async release(owner) {
      generations.set(owner, (generations.get(owner) ?? 0) + 1);
      await Promise.all([...entries].filter(([, entry]) => entry.owner === owner).map(([id]) => this.cancel(owner, id)));
    },
  };
}

module.exports = { createFileStorage };
