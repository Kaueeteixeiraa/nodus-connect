type HeldInput = { type: "keyDown" | "keyUp"; keyCode: number; code: string; location: number; repeat: boolean }
  | { type: "mouseDown" | "mouseUp"; button: number; x: number; y: number };

export class RemoteInputState {
  private held = new Map<string, Map<string, HeldInput>>();
  record(sessionId: string, input: { type: string }) {
    const value = input as HeldInput;
    if (!["keyDown", "keyUp", "mouseDown", "mouseUp"].includes(value.type)) return;
    const keyboard = value.type === "keyDown" || value.type === "keyUp";
    const keyInput = value as Extract<HeldInput, { keyCode: number }>, mouseInput = value as Extract<HeldInput, { button: number }>;
    if (keyboard) {
      if (!Number.isInteger(keyInput.keyCode) || keyInput.keyCode <= 0 || keyInput.keyCode >= 256) return;
    } else if (!Number.isInteger(mouseInput.button) || mouseInput.button < 0 || mouseInput.button > 2 || !Number.isFinite(mouseInput.x) || !Number.isFinite(mouseInput.y)) return;
    const key = keyboard ? `key:${keyInput.keyCode}` : `mouse:${mouseInput.button}`;
    const state = this.held.get(sessionId) ?? new Map<string, HeldInput>();
    if (value.type === "keyUp" || value.type === "mouseUp") state.delete(key);
    else state.set(key, keyboard ? { type: "keyDown", keyCode: keyInput.keyCode, code: typeof keyInput.code === "string" ? keyInput.code.slice(0, 64) : "", location: keyInput.location, repeat: false }
      : { type: "mouseDown", button: mouseInput.button, x: mouseInput.x, y: mouseInput.y });
    if (state.size) this.held.set(sessionId, state); else this.held.delete(sessionId);
  }
  release(sessionId: string): HeldInput[] {
    const state = this.held.get(sessionId);
    this.held.delete(sessionId);
    if (!state) return [];
    return [...state].filter(([key]) => ![...this.held.values()].some(other => other.has(key)))
      .map(([, value]) => "keyCode" in value ? { ...value, type: "keyUp", repeat: false } : { ...value, type: "mouseUp" });
  }
}
