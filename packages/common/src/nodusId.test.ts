import { describe, expect, it } from "vitest";
import { formatNodusId, generateNodusId, isValidNodusId, normalizeNodusId } from "./nodusId";

describe("nodusId", () => {
  it("formats and normalizes ids", () => {
    expect(formatNodusId("845291637")).toBe("845 291 637");
    expect(normalizeNodusId("845 291 637")).toBe("845291637");
    expect(isValidNodusId("845 291 637")).toBe(true);
    expect(isValidNodusId("123")).toBe(false);
  });

  it("generates a valid 9 digit id", () => {
    const id = generateNodusId(new Uint8Array([1, 2, 3, 4]));
    expect(id).toMatch(/^\d{3} \d{3} \d{3}$/);
    expect(isValidNodusId(id)).toBe(true);
  });
});
