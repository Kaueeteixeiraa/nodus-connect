export const CURSOR_HOTSPOT = { x: 0, y: 0 } as const;

export function cursorCaptureStatus(applied: string | null | undefined) {
  return applied === "never" ? "SETTINGS_EXCLUDED_VISUAL_UNVERIFIED" : applied ? "CURSOR_SUPPRESSION_FAILED" : "CURSOR_SUPPRESSION_UNVERIFIED";
}

export function requireCursorFreeCapture(applied: string | null | undefined) {
  if (applied !== "never") throw new Error(`${cursorCaptureStatus(applied)}: captura sem cursor nao confirmada. Use o backend nativo WGC.`);
}

export function canUseCursorFreeNativeCapture(status: { nativeMediaAvailable?: boolean; supported?: boolean; cursorSuppressionSupported?: boolean; d3d11Hardware?: boolean; hardwareH264?: boolean }) {
  return Boolean(status.nativeMediaAvailable && status.supported && status.cursorSuppressionSupported && status.d3d11Hardware && status.hardwareH264);
}

export function mapVideoPointer(
  surface: { width: number; height: number },
  video: { width: number; height: number },
  pointer: { x: number; y: number },
) {
  if (surface.width <= 0 || surface.height <= 0 || video.width <= 0 || video.height <= 0) return null;
  const scale = Math.min(surface.width / video.width, surface.height / video.height);
  const width = video.width * scale;
  const height = video.height * scale;
  const left = (surface.width - width) / 2;
  const top = (surface.height - height) / 2;
  if (pointer.x < left || pointer.x > left + width || pointer.y < top || pointer.y > top + height) return null;
  return {
    x: Math.max(0, Math.min(1, (pointer.x - left) / width)),
    y: Math.max(0, Math.min(1, (pointer.y - top) / height)),
    left: pointer.x, top: pointer.y,
  };
}
