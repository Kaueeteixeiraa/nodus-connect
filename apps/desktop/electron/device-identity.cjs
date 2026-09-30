const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

function createDeviceIdentityStore(directory, options = {}) {
  const io = options.fs || fs;
  const random = options.crypto || crypto;
  const now = options.now || (() => new Date().toISOString());
  const primaryPath = path.join(directory, "identity.json");
  const backupPath = path.join(directory, "identity.backup.json");

  function loadOrCreate(legacyIdentity) {
    const primary = readIdentity(primaryPath);
    if (primary.error) throw primary.error;
    if (primary.value) {
      const backup = readIdentity(backupPath);
      if (backup.error && (!validDeviceId(primary.value.deviceId) || !validSecret(primary.value.deviceSecret))) throw backup.error;
      const sameDeviceBackup = backup.value && formatNodusId(backup.value.nodusId) === formatNodusId(primary.value.nodusId) ? backup.value : null;
      return upgrade({
        ...primary.value,
        deviceId: primary.value.deviceId || sameDeviceBackup?.deviceId,
        deviceSecret: primary.value.deviceSecret || sameDeviceBackup?.deviceSecret,
      });
    }

    const backup = readIdentity(backupPath);
    if (backup.error) throw backup.error;
    if (backup.value) {
      const recovered = upgrade(backup.value, false);
      persist(recovered);
      return publicIdentity(recovered);
    }

    const migrated = validBaseIdentity(legacyIdentity) ? legacyIdentity : null;
    const identity = completeIdentity(migrated);
    persist(identity);
    return publicIdentity(identity);
  }

  function updateMutable(candidate) {
    const current = internalIdentity(loadOrCreate(candidate));
    const next = {
      ...current,
      deviceName: normalizeName(candidate?.deviceName, current.deviceName),
      deviceNameConfirmed: Boolean(candidate?.deviceNameConfirmed),
    };
    persist(next);
    return publicIdentity(next);
  }

  function upgrade(identity, persistUpgrade = true) {
    const complete = completeIdentity(identity);
    if (persistUpgrade && JSON.stringify(complete) !== JSON.stringify(identity)) persist(complete);
    return publicIdentity(complete);
  }

  function internalIdentity(fallback) {
    const primary = readIdentity(primaryPath);
    if (primary.error) throw primary.error;
    if (primary.value) return completeIdentity(primary.value);
    const backup = readIdentity(backupPath);
    if (backup.error) throw backup.error;
    return completeIdentity(backup.value || fallback);
  }

  function completeIdentity(source) {
    const deviceSecret = validSecret(source?.deviceSecret) ? source.deviceSecret : random.randomBytes(32).toString("base64url");
    return {
      version: 2,
      nodusId: validNodusId(source?.nodusId) ? formatNodusId(source.nodusId) : generateNodusId(random.randomBytes(4)),
      deviceId: validDeviceId(source?.deviceId) ? source.deviceId : random.randomUUID(),
      deviceSecret,
      deviceFingerprint: random.createHash("sha256").update(deviceSecret).digest("hex"),
      deviceName: normalizeName(source?.deviceName, "PC-Windows"),
      deviceNameConfirmed: Boolean(source?.deviceNameConfirmed),
      createdAt: validDate(source?.createdAt) ? source.createdAt : now(),
    };
  }

  function persist(identity) {
    io.mkdirSync(directory, { recursive: true });
    atomicWrite(backupPath, identity);
    atomicWrite(primaryPath, identity);
  }

  function readIdentity(file) {
    try {
      const value = JSON.parse(io.readFileSync(file, "utf8"));
      return { value: validBaseIdentity(value) ? value : null };
    } catch (error) {
      if (error?.code === "ENOENT" || error instanceof SyntaxError) return { value: null };
      return { value: null, error };
    }
  }

  function atomicWrite(file, value) {
    const temporary = `${file}.${process.pid}.${random.randomBytes(6).toString("hex")}.tmp`;
    const descriptor = io.openSync(temporary, "wx");
    try {
      io.writeFileSync(descriptor, JSON.stringify(value, null, 2), "utf8");
      io.fsyncSync(descriptor);
    } finally {
      io.closeSync(descriptor);
    }
    try {
      io.renameSync(temporary, file);
    } catch (error) {
      try { io.unlinkSync(temporary); } catch {}
      throw error;
    }
  }

  return { loadOrCreate, updateMutable, paths: { primaryPath, backupPath } };
}

function publicIdentity(identity) {
  const { deviceSecret: _secret, ...safe } = identity;
  return safe;
}

function validBaseIdentity(value) {
  return Boolean(value && typeof value === "object" && validNodusId(value.nodusId) && normalizeName(value.deviceName, "") && validDate(value.createdAt));
}

function validNodusId(value) {
  return /^\d{9}$/.test(String(value || "").replace(/\D/g, ""));
}

function formatNodusId(value) {
  return String(value).replace(/\D/g, "").replace(/(\d{3})(?=\d)/g, "$1 ").trim();
}

function generateNodusId(bytes) {
  let value = 0n;
  for (const byte of bytes.subarray(0, 4)) value = (value << 8n) + BigInt(byte);
  return formatNodusId(String(100_000_000n + (value % 900_000_000n)));
}

function validDate(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function validDeviceId(value) {
  return typeof value === "string" && value.length >= 16 && value.length <= 128;
}

function validSecret(value) {
  return typeof value === "string" && value.length >= 32 && value.length <= 256;
}

function normalizeName(value, fallback) {
  return String(value || "").trim().slice(0, 120) || fallback;
}

module.exports = { createDeviceIdentityStore };
