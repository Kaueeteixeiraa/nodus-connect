export function normalizeNodusId(input: string): string | null {
  const digits = input.replace(/\D/g, "");
  return digits.length === 9 ? digits : null;
}

export function formatNodusId(input: string): string {
  const digits = input.replace(/\D/g, "").slice(0, 9);
  return digits.replace(/(\d{3})(?=\d)/g, "$1 ").trim();
}

export function isValidNodusId(input: string): boolean {
  return normalizeNodusId(input) !== null;
}

export function generateNodusId(randomBytes: Uint8Array): string {
  if (randomBytes.length < 4) throw new Error("generateNodusId requires at least 4 random bytes");

  let value = 0n;
  for (const byte of randomBytes.slice(0, 4)) {
    value = (value << 8n) + BigInt(byte);
  }

  const id = 100_000_000n + (value % 900_000_000n);
  return formatNodusId(id.toString());
}
