function keyboardInput(keyCode, extended) {
  const code = keyCode >= 65 && keyCode <= 90 ? `Key${String.fromCharCode(keyCode)}`
    : keyCode >= 48 && keyCode <= 57 ? `Digit${keyCode - 48}`
    : keyCode >= 112 && keyCode <= 135 ? `F${keyCode - 111}`
    : ({ 91: "MetaLeft", 92: "MetaRight", 16: "ShiftLeft", 17: extended ? "ControlRight" : "ControlLeft", 18: extended ? "AltRight" : "AltLeft", 160: "ShiftLeft", 161: "ShiftRight", 162: "ControlLeft", 163: "ControlRight", 164: "AltLeft", 165: "AltRight", 13: extended ? "NumpadEnter" : "Enter", 8: "Backspace", 9: "Tab", 27: "Escape", 32: "Space", 33: "PageUp", 34: "PageDown", 35: "End", 36: "Home", 37: "ArrowLeft", 38: "ArrowUp", 39: "ArrowRight", 40: "ArrowDown", 44: "PrintScreen", 45: "Insert", 46: "Delete", 93: "ContextMenu", 111: "NumpadDivide" })[keyCode] || `VirtualKey${keyCode}`;
  return { keyCode, code, location: /Right$/.test(code) ? 2 : /Left$/.test(code) ? 1 : 0, repeat: false };
}

class RemoteWindowsKeys {
  constructor({ spawn, executable, log }) {
    Object.assign(this, { spawn, executable, log });
    this.timer = setInterval(() => {
      if (!this.entry) return;
      if (this.entry.window.isDestroyed() || !this.entry.window.isFocused()) this.stop();
      else this.write("H");
    }, 1000);
    this.timer.unref?.();
  }
  setActive(window) {
    if (!window || window.isDestroyed() || !window.isFocused()) return this.stop();
    if (this.entry?.window === window) return;
    this.stop();
    const handle = window.getNativeWindowHandle();
    const hwnd = handle.length === 8 ? handle.readBigUInt64LE().toString() : String(handle.readUInt32LE());
    try {
      const child = this.spawn(this.executable, ["--windows-key-helper", String(process.pid), hwnd], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
      const entry = { window, contents: window.webContents, child, held: new Map(), buffer: "" };
      this.entry = entry;
      child.stdout.on("data", (data) => {
        entry.buffer += data.toString();
        const lines = entry.buffer.split(/\r?\n/);
        entry.buffer = lines.pop();
        for (const line of lines) {
          const match = /^K ([56]) (\d{1,3}) ([01])$/.exec(line);
          if (!match || this.entry !== entry) continue;
          const keyCode = Number(match[2]);
          if (keyCode < 1 || keyCode > 254) continue;
          const input = keyboardInput(keyCode, match[3] === "1"), down = match[1] === "5";
          input.repeat = down && entry.held.has(keyCode);
          if (down) entry.held.set(keyCode, input); else entry.held.delete(keyCode);
          if (!entry.contents.isDestroyed()) entry.contents.send("nodus:remote-key-input", down ? "keyDown" : "keyUp", input);
        }
      });
      const fail = (error) => { this.log(`[KEYBOARD] Windows shortcut capture unavailable: ${error.message}`); if (this.entry === entry) this.stop(); };
      child.on("error", fail);
      child.stdin.on("error", fail);
      child.on("close", (code) => { if (this.entry === entry) { this.log(`[KEYBOARD] Native shortcut helper exited (${code})`); this.stop(); } });
      this.write("H");
    } catch (error) { this.log(`[KEYBOARD] ${error.message}`); }
  }
  write(command) {
    try { this.entry?.child.stdin.write(command); }
    catch { this.stop(); }
  }
  stop(window) {
    const entry = this.entry;
    if (!entry || (window && entry.window !== window)) return;
    this.entry = null;
    if (!entry.contents.isDestroyed()) entry.held.forEach((input) => entry.contents.send("nodus:remote-key-input", "keyUp", { ...input, repeat: false }));
    try { entry.child.stdin.end("R"); } catch { entry.child.kill(); }
  }
  dispose() { this.stop(); clearInterval(this.timer); }
}

module.exports = { RemoteWindowsKeys, keyboardInput };
