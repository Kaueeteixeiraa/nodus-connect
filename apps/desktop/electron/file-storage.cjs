const fs = require("node:fs/promises");
const { constants } = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

function createFileStorage(directory, clipboardDirectory) {
  const entries = new Map();
  const copied = new Map();
  const pendingBegins = new Map(), generations = new Map();
  let pruning, prunedAt = 0;
  const requireEntry = (owner, id) => {
    const entry = entries.get(id);
    if (!entry || entry.owner !== owner || entry.closed || entry.finalizing) throw new Error("INVALID_TRANSFER");
    return entry;
  };
  return {
    async begin(owner, fileName, size, recording = false, clipboard = false) {
      if (!Number.isSafeInteger(size) || size < 0 || size > (recording ? 4 * 1024 ** 3 : 256 * 1024 ** 2)
        || [...entries.values()].filter(entry => entry.owner === owner).length + (pendingBegins.get(owner) ?? 0) >= 8) throw new Error("INVALID_FILE");
      const generation = generations.get(owner);
      pendingBegins.set(owner, (pendingBegins.get(owner) ?? 0) + 1);
      try {
      let name = path.basename(String(fileName)).replace(/[<>:"/\\|?*\x00-\x1F]/g, "_").replace(/[. ]+$/, "").slice(0, 180) || "arquivo";
      if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(name)) name = `_${name}`;
      const root = clipboard && clipboardDirectory ? path.join(clipboardDirectory(), randomUUID()) : typeof directory === "function" ? directory() : directory;
      if (clipboard && clipboardDirectory) {
        if (!pruning || Date.now() - prunedAt > 3_600_000) { prunedAt = Date.now(); pruning = pruneClipboardFiles(clipboardDirectory()); }
        await pruning;
      }
      await fs.mkdir(root, { recursive: true });
      const id = randomUUID(), temporary = path.join(root, `.nodus-${id}.part`);
      const handle = await fs.open(temporary, "wx");
      if (generations.get(owner) !== generation) {
        await handle.close(); await fs.unlink(temporary); throw new Error("TRANSFER_OWNER_CLOSED");
      }
      entries.set(id, { owner, name, root, temporary, handle, size, recording, clipboard, bytes: 0, closed: false, pending: Promise.resolve() });
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
          if (entry.clipboard) {
            const owned = [...copied].filter(([, item]) => item.owner === owner);
            if (owned.length >= 32) copied.delete(owned[0][0]);
            copied.set(id, { owner, path: destination });
          }
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
      for (const [id, entry] of copied) if (entry.owner === owner) copied.delete(id);
      await Promise.all([...entries].filter(([, entry]) => entry.owner === owner).map(([id]) => this.cancel(owner, id)));
    },
    clipboardPaths(owner, ids) {
      if (!Array.isArray(ids) || !ids.length || ids.length > 32 || new Set(ids).size !== ids.length) throw new Error("INVALID_TRANSFER");
      return ids.map(id => { const entry = copied.get(id); if (!entry || entry.owner !== owner) throw new Error("INVALID_TRANSFER"); return entry.path; });
    },
  };
}

function createClipboardReader(read) {
  const entries = new Map(), generations = new Map();
  const release = async owner => {
    generations.set(owner, (generations.get(owner) ?? 0) + 1);
    const owned = [...entries].filter(([, entry]) => entry.owner === owner);
    for (const [id] of owned) entries.delete(id);
    await Promise.all(owned.map(([, entry]) => entry.handle?.close().catch(() => undefined)));
  };
  return {
    release,
    async snapshot(owner) {
      const releasing = release(owner), generation = generations.get(owner);
      await releasing;
      const data = await read();
      if (generations.get(owner) !== generation) throw new Error("CLIPBOARD_CHANGED");
      if (data.length < 6 || data.length % 2 || data.readUInt16LE(data.length - 2) !== 0) throw new Error("INVALID_CLIPBOARD");
      const paths = data.subarray(4).toString("utf16le").split("\0").filter(Boolean);
      if (paths.length > 32) throw new Error("CLIPBOARD_FILE_LIMIT");
      const files = [];
      try {
        for (const file of [...new Set(paths)]) {
          const stat = await fs.stat(file);
          if (!path.isAbsolute(file) || !stat.isFile()) throw new Error("CLIPBOARD_FOLDERS_UNSUPPORTED");
          if (stat.size > 256 * 1024 ** 2) throw new Error("CLIPBOARD_FILE_LIMIT");
          if (generations.get(owner) !== generation) throw new Error("CLIPBOARD_CHANGED");
          const id = randomUUID();
          entries.set(id, { owner, file, size: stat.size });
          files.push({ id, name: path.basename(file), size: stat.size, type: "application/octet-stream" });
        }
      } catch (error) { if (generations.get(owner) === generation) await release(owner); throw error; }
      return { sequence: data.readUInt32LE(0), files };
    },
    async chunk(owner, id, offset, length) {
      const entry = entries.get(id);
      if (!entry || entry.owner !== owner || !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0 || length > 256 * 1024 || offset + length > entry.size) throw new Error("INVALID_FILE");
      if (!entry.handle) {
        const handle = await fs.open(entry.file, "r");
        if (entries.get(id) !== entry || entry.handle) { await handle.close(); if (entries.get(id) !== entry) throw new Error("CLIPBOARD_CHANGED"); }
        else entry.handle = handle;
      }
      const bytes = Buffer.alloc(length), result = await entry.handle.read(bytes, 0, length, offset);
      if (result.bytesRead !== length) throw new Error("FILE_SIZE_MISMATCH");
      return bytes;
    },
  };
}

async function pruneClipboardFiles(directory) {
  const root = path.resolve(directory);
  if (root === path.parse(root).root) throw new Error("INVALID_CACHE_DIRECTORY");
  for (const entry of await fs.readdir(root, { withFileTypes: true }).catch(error => { if (error.code === "ENOENT") return []; throw error; })) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(entry.name)) continue;
    const folder = path.resolve(root, entry.name);
    if (path.dirname(folder) !== root) continue;
    const stat = await fs.lstat(folder);
    if (!stat.isSymbolicLink() && Date.now() - stat.mtimeMs > 86_400_000) await fs.rm(folder, { recursive: true, force: true }).catch(() => undefined);
  }
}

module.exports = { createFileStorage, createClipboardReader, pruneClipboardFiles };
