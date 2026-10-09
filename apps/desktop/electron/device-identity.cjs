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
      const recovered = completeIdentity(backup.value);
      persist(recovered);
      return publicIdentity(recovered);
    }

    const recovered = options.recovery?.load();
    if (recovered) {
      if (!validBaseIdentity(recovered) || !validDeviceId(recovered.deviceId) || !validSecret(recovered.deviceSecret)) throw new Error("INVALID_IDENTITY_RECOVERY");
      const identity = completeIdentity(recovered);
      persist(identity);
      return publicIdentity(identity);
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
    else options.recovery?.save(complete);
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
    options.recovery?.save(identity);
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

function createWindowsIdentityRecovery(safeStorage, scope, executable, execute = require("node:child_process").spawnSync) {
  if (!/^(Desktop|QuickSupport-[A-Za-z0-9_-]{1,128})$/.test(scope)) throw new Error("INVALID_IDENTITY_SCOPE");
  let saved;
  function run(operation, input) {
    const result = execute(executable, [`--identity-recovery-${operation}`, scope], { windowsHide: true, timeout: 3000, maxBuffer: 16384, encoding: "utf8", input });
    if (result.error || result.status !== 0) throw new Error("IDENTITY_RECOVERY_UNAVAILABLE");
    return result.stdout.replace(/^\uFEFF/, "").trim();
  }
  function requireEncryption() {
    if (!safeStorage.isEncryptionAvailable()) throw new Error("IDENTITY_ENCRYPTION_UNAVAILABLE");
  }
  return {
    load() {
      const output = run("read");
      const encrypted = JSON.parse(output);
      if (encrypted === null) return null;
      if (typeof encrypted !== "string" || encrypted.length > 8192 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encrypted)) throw new Error("INVALID_IDENTITY_RECOVERY");
      requireEncryption();
      saved = safeStorage.decryptString(Buffer.from(encrypted, "base64"));
      return JSON.parse(saved);
    },
    save(identity) {
      const value = JSON.stringify(identity);
      if (value === saved) return;
      requireEncryption();
      const encrypted = safeStorage.encryptString(value).toString("base64");
      if (encrypted.length > 8192) throw new Error("INVALID_IDENTITY_RECOVERY");
      // Only the encrypted payload goes through stdin, never command arguments.
      run("write", encrypted);
      saved = value;
    },
  };
}

function publicIdentity(identity) {
  const { deviceSecret, ...safe } = identity;
  return {
    ...safe,
    deviceClaim: crypto.createHash("sha256").update(`nodus-device-claim:${deviceSecret}`).digest("hex"),
  };
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

function normalizeHardware(value) {
  const normalized = String(value || "").normalize("NFKC").trim().toUpperCase().replace(/[\s-]+/g, "");
  if (normalized.length < 5 || normalized.length > 128 || !/^[A-Z0-9_.]+$/.test(normalized)
    || /^(0+|F+|1+|UNKNOWN|NONE|NULL|DEFAULTSTRING|SYSTEMSERIALNUMBER|BASEBOARDSERIALNUMBER|CHASSISSERIALNUMBER|TOBEFILLEDBYOEM|NOTSPECIFIED|NOTAPPLICABLE|NOTAVAILABLE|INVALID|SERIALNUMBER|123456789|0123456789)$/.test(normalized.replace(/[._]/g, ""))) return "";
  return normalized;
}

function hardwareIdentity(signals) {
  const anchors = {}, system = normalizeHardware(signals?.system), board = normalizeHardware(signals?.board), bios = normalizeHardware(signals?.bios);
  const values = { system: /^[A-F0-9]{32}$/.test(system) ? system : "", board: board ? `${normalizeHardware(signals?.boardMaker)}:${board}` : "", bios: bios && bios !== board ? bios : "" };
  for (const [kind, value] of Object.entries(values)) if (value) anchors[kind] = crypto.createHash("sha256").update(`nodus-license-hardware-v1:${kind}:${value}`).digest("hex");
  return { version: 1, anchors, virtual: /VMWARE|VIRTUAL|KVM|QEMU|XEN|PARALLELS|BOCHS/i.test(String(signals?.manufacturer || "")) };
}

function collectHardwareIdentity(run = require("node:child_process").execFile) {
  if (process.platform !== "win32") return Promise.resolve(hardwareIdentity({}));
  const script = "$ErrorActionPreference='Stop'; $p=Get-CimInstance Win32_ComputerSystemProduct; $b=Get-CimInstance Win32_BaseBoard; $s=Get-CimInstance Win32_BIOS; $c=Get-CimInstance Win32_ComputerSystem; @{system=$p.UUID;board=$b.SerialNumber;boardMaker=$b.Manufacturer;bios=$s.SerialNumber;manufacturer=($c.Manufacturer+' '+$c.Model)} | ConvertTo-Json -Compress";
  const executable = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  return new Promise(resolve => run(executable, ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, timeout: 6000, maxBuffer: 4096, encoding: "utf8" }, (error, output) => {
    try { resolve(hardwareIdentity(error ? {} : JSON.parse(output.replace(/^\uFEFF/, "")))); } catch { resolve(hardwareIdentity({})); }
  }));
}

module.exports = { createDeviceIdentityStore, createWindowsIdentityRecovery, normalizeHardware, hardwareIdentity, collectHardwareIdentity };
