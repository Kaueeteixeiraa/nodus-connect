import { describe, expect, it } from "vitest";
import { CURSOR_HOTSPOT, canUseCursorFreeNativeCapture, cursorCaptureStatus, mapVideoPointer, requireCursorFreeCapture } from "./remote-cursor";

describe("remote cursor mapping", () => {
  it("keeps the arrow tip and remote input on the same CSS pixel", () => {
    expect(CURSOR_HOTSPOT).toEqual({ x: 0, y: 0 });
    expect(mapVideoPointer({ width: 1920, height: 1080 }, { width: 1920, height: 1080 }, { x: 480, y: 270 }))
      .toEqual({ x: 0.25, y: 0.25, left: 480, top: 270 });
  });

  it.each([1, 1.25, 1.5])("uses CSS coordinates unchanged at %s display scale", (dpi) => {
    const physical = { x: 500 * dpi, y: 400 * dpi };
    expect(mapVideoPointer({ width: 1000, height: 800 }, { width: 1920, height: 1080 }, { x: physical.x / dpi, y: physical.y / dpi }))
      .toMatchObject({ x: 0.5, y: 0.5, left: 500, top: 400 });
  });

  it("rejects letterbox bars and accepts both edges of the picture", () => {
    const surface = { width: 1000, height: 800 };
    const video = { width: 1920, height: 1080 };
    expect(mapVideoPointer(surface, video, { x: 500, y: 100 })).toBeNull();
    expect(mapVideoPointer(surface, video, { x: 500, y: 400 })?.y).toBeCloseTo(0.5);
    expect(mapVideoPointer(surface, video, { x: 0, y: 400 })?.x).toBeCloseTo(0);
    expect(mapVideoPointer(surface, video, { x: 1000, y: 400 })?.x).toBeCloseTo(1);
  });

  it("does not wait for a remote acknowledgement to move locally", () => {
    const surface = { width: 1280, height: 720 };
    const video = { width: 1280, height: 720 };
    expect(mapVideoPointer(surface, video, { x: 900, y: 360 })?.left).toBe(900);
    expect(mapVideoPointer(surface, video, { x: 901, y: 360 })?.left).toBe(901);
  });

  it("does not paint a local cursor before video dimensions are available", () => {
    expect(mapVideoPointer({ width: 1000, height: 800 }, { width: 0, height: 0 }, { x: 500, y: 400 })).toBeNull();
  });

  it("keeps the physical viewer cursor in pillarbox bars", () => {
    const surface = { width: 1920, height: 1080 }, video = { width: 1024, height: 768 };
    expect(mapVideoPointer(surface, video, { x: 100, y: 540 })).toBeNull();
    expect(mapVideoPointer(surface, video, { x: 1820, y: 540 })).toBeNull();
    expect(mapVideoPointer(surface, video, { x: 960, y: 540 })).toMatchObject({ x: 0.5, y: 0.5 });
  });

  it("does not require an experimental environment flag for cursor-free native capture", () => {
    const status = { nativeMediaAvailable: true, supported: true, cursorSuppressionSupported: true, d3d11Hardware: true, hardwareH264: true };
    expect(canUseCursorFreeNativeCapture(status)).toBe(true);
    expect(canUseCursorFreeNativeCapture({ ...status, nativeMediaAvailable: false })).toBe(false);
    expect(canUseCursorFreeNativeCapture({ ...status, cursorSuppressionSupported: false })).toBe(false);
    expect(canUseCursorFreeNativeCapture({ ...status, hardwareH264: false })).toBe(false);
  });

  it.each(["always", "motion", null, undefined])("rejects fallback when captured cursor exclusion is not confirmed (%s)", (applied) => {
    expect(() => requireCursorFreeCapture(applied)).toThrow(/CURSOR_SUPPRESSION_/);
  });

  it("retains Chromium fallback only with cursor=never without claiming visual validation", () => {
    expect(() => requireCursorFreeCapture("never")).not.toThrow();
    expect(cursorCaptureStatus("never")).toBe("SETTINGS_EXCLUDED_VISUAL_UNVERIFIED");
  });
});
