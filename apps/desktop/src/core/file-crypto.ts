export type FileCryptoSession = {
  publicKey: string;
  privateKey: Promise<CryptoKey>;
};

export async function createFileCryptoSession(): Promise<FileCryptoSession> {
  const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveKey"]);
  const publicKey = await crypto.subtle.exportKey("raw", pair.publicKey);
  return { publicKey: toBase64(publicKey), privateKey: Promise.resolve(pair.privateKey) };
}

export async function deriveFileCryptoKey(session: FileCryptoSession, remotePublicKey: string): Promise<CryptoKey> {
  const publicKey = await crypto.subtle.importKey("raw", fromBase64(remotePublicKey), { name: "ECDH", namedCurve: "P-256" }, false, []);
  return crypto.subtle.deriveKey({ name: "ECDH", public: publicKey }, await session.privateKey, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

export async function encryptFileChunk(key: CryptoKey, chunk: ArrayBuffer): Promise<ArrayBuffer> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, chunk);
  const result = new Uint8Array(iv.byteLength + encrypted.byteLength);
  result.set(iv);
  result.set(new Uint8Array(encrypted), iv.byteLength);
  return result.buffer;
}

export async function decryptFileChunk(key: CryptoKey, payload: ArrayBuffer): Promise<ArrayBuffer> {
  if (payload.byteLength <= 12) throw new Error("Bloco criptografado invalido.");
  const bytes = new Uint8Array(payload);
  return crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.slice(0, 12) }, key, bytes.slice(12));
}

function toBase64(value: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(value)));
}

function fromBase64(value: string): ArrayBuffer {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0)).buffer;
}
