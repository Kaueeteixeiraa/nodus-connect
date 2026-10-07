const crypto = require("node:crypto");
const fs = require("node:fs");
const derive = require("node:util").promisify(crypto.pbkdf2);
const FOOTER = Buffer.from("NODUS-QUICKSUPPORT-V1");
const PERMISSIONS = ["screen:view", "mouse:control", "keyboard:control", "clipboard:sync", "files:transfer", "audio:remote"];
const ITERATIONS = 600_000;

function validateProfile(value) {
  const text = (s, max) => typeof s === "string" && s.length <= max;
  const id = s => typeof s === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(s);
  if (!value || value.version !== 1 || !id(value.id) || !id(value.organizationId) || !id(value.licenseId)
    || !text(value.name, 80) || !value.name.trim() || !text(value.company, 120) || !value.company.trim()
    || !text(value.message, 240) || !text(value.logo, 6000) || (value.logo && !/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(value.logo))
    || typeof value.confirmation !== "boolean" || !Number.isSafeInteger(value.createdAt) || value.createdAt <= 0
    || !Array.isArray(value.permissions) || !value.permissions.includes("screen:view") || value.permissions.length > 6
    || value.permissions.some(p => !PERMISSIONS.includes(p)) || new Set(value.permissions).size !== value.permissions.length
    || value.passwordVerifier?.iterations !== ITERATIONS || !/^[a-f0-9]{64}$/.test(value.passwordVerifier?.hash)
    || !/^[a-f0-9]{32}$/.test(value.passwordVerifier?.salt)
    || value.template && (!/^\d+\.\d+\.\d+$/.test(value.template.version) || !/^[a-f0-9]{64}$/.test(value.template.sha256))) throw new Error("INVALID_SUPPORT_PROFILE");
  return value;
}
async function passwordVerifier(password) {
  if (typeof password !== "string" || password.length < 3 || password.length > 128) throw new Error("SUPPORT_PASSWORD_TOO_SHORT");
  const salt = crypto.randomBytes(16).toString("hex");
  return { salt, hash: (await derive(password, Buffer.from(salt, "hex"), ITERATIONS, 32, "sha256")).toString("hex"), iterations: ITERATIONS };
}
async function verifyPassword(password, verifier) {
  if (typeof password !== "string" || password.length > 128 || !password || verifier.iterations !== ITERATIONS) return false;
  const actual = await derive(password, Buffer.from(verifier.salt, "hex"), ITERATIONS, 32, "sha256");
  const expected = Buffer.from(verifier.hash, "hex");
  return expected.length === actual.length && crypto.timingSafeEqual(actual, expected);
}
function signProfile(profile, key) {
  validateProfile(profile);
  if (crypto.createPublicKey(key).asymmetricKeyType !== "ed25519") throw new Error("INVALID_SUPPORT_KEY");
  const payload = Buffer.from(JSON.stringify({ purpose: "nodus-quicksupport", profile })).toString("base64url");
  return `${payload}.${crypto.sign(null, Buffer.from(payload), key).toString("base64url")}`;
}
function verifyProfile(token, key) {
  if (typeof token !== "string" || token.length > 16000 || crypto.createPublicKey(key).asymmetricKeyType !== "ed25519") throw new Error("INVALID_SUPPORT_PROFILE");
  const parts = token.split("."), [payload, signature] = parts;
  if (!payload || !signature || parts.length !== 2 || !crypto.verify(null, Buffer.from(payload), key, Buffer.from(signature, "base64url"))) throw new Error("INVALID_SUPPORT_PROFILE");
  const decoded = JSON.parse(Buffer.from(payload, "base64url").toString());
  if (decoded.purpose !== "nodus-quicksupport") throw new Error("INVALID_SUPPORT_PROFILE");
  return validateProfile(decoded.profile);
}
function readProfile(executable, key) {
  const file = fs.openSync(executable, "r");
  try {
    const size = fs.fstatSync(file).size, tail = Buffer.alloc(FOOTER.length + 4);
    if (size < tail.length || fs.readSync(file, tail, 0, tail.length, size - tail.length) !== tail.length || !tail.subarray(4).equals(FOOTER)) throw new Error("SUPPORT_PROFILE_MISSING");
    const length = tail.readUInt32LE(0);
    if (!length || length > 16000 || size < tail.length + length) throw new Error("INVALID_SUPPORT_PROFILE");
    const token = Buffer.alloc(length);
    fs.readSync(file, token, 0, length, size - tail.length - length);
    return verifyProfile(token.toString(), key);
  } finally { fs.closeSync(file); }
}
function appendProfile(source, destination, token, key) {
  const profile = verifyProfile(token, key);
  fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
  const payload = Buffer.from(token), length = Buffer.alloc(4); length.writeUInt32LE(payload.length);
  try { fs.appendFileSync(destination, Buffer.concat([payload, length, FOOTER])); }
  catch (error) { fs.rmSync(destination, { force: true }); throw error; }
  return profile;
}
module.exports = { validateProfile, passwordVerifier, verifyPassword, signProfile, verifyProfile, readProfile, appendProfile };
