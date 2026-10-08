class RemoteCursorVisibility {
  constructor({ spawn, executable, log, onHostMouseActivity = () => {}, now = Date.now }) {
    this.spawn = spawn;
    this.executable = executable;
    this.log = log;
    this.onHostMouseActivity = onHostMouseActivity;
    this.now = now;
    this.active = false;
    this.blocked = false;
    this.disposed = false;
    this.helper = null;
    this.timer = setInterval(() => this.tick(), 1000);
    this.timer.unref?.();
  }

  setActive(active, hideOnRemote = true) {
    this.hideOnRemote = hideOnRemote;
    if (this.disposed) return;
    if (!active) {
      this.active = false;
      this.blocked = false;
      this.stop();
      return;
    }
    if (!this.active) this.log("[CURSOR] Remote session started");
    this.active = true;
    this.lastHeartbeat = this.now();
    this.tick();
  }

  tick() {
    if (this.active && this.now() - this.lastHeartbeat >= 5000) this.setActive(false);
    if (!this.active || this.blocked || this.disposed) return;
    if (!this.helper) this.start();
    const helper = this.helper;
    if (helper && !helper.stopping) {
      try { helper.stdin.write("H"); }
      catch (error) { this.fail(helper, error); }
    }
  }

  remoteMouseActivity(input) {
    if (!this.active || this.blocked || this.disposed || !this.helper || this.helper.stopping) return;
    if (!["mouseMove", "mouseDown", "mouseUp", "wheel"].includes(input.type)) return;
    try { this.helper.stdin.write(this.hideOnRemote ? "M" : "V"); }
    catch (error) { this.fail(this.helper, error); }
  }

  start() {
    try {
      const helper = this.spawn(this.executable, ["--cursor-visibility-helper", String(process.pid)], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
      this.helper = helper;
      let buffer = "";
      helper.stdout.on("data", (data) => {
        buffer += data.toString();
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop();
        for (const line of lines) {
          if (["[CURSOR] Physical host mouse active", "[CURSOR] Physical host pointer moved"].includes(line)
            && this.active && this.helper === helper && !helper.stopping) this.onHostMouseActivity();
          if (line === "[CURSOR] Physical host pointer moved") continue;
          if (line.startsWith("[CURSOR]")) this.log(line);
        }
      });
      helper.stderr.on("data", (data) => this.log(`[CURSOR] Native error: ${data.toString().slice(0, 1000).trim()}`));
      helper.on("error", (error) => this.fail(helper, error));
      helper.stdin.on("error", (error) => this.fail(helper, error));
      helper.on("close", (code) => {
        if (this.helper !== helper) return;
        this.helper = null;
        if (!helper.stopping && this.active) {
          this.blocked = true;
          this.log(`[CURSOR] Failed to hide local host cursor: helper exited (${code}); watchdog restoration required`);
        }
        this.tick();
      });
    } catch (error) {
      this.blocked = true;
      this.log(`[CURSOR] Failed to hide local host cursor: ${error.message}`);
    }
  }

  fail(helper, error) {
    if (this.helper !== helper || helper.stopping) return;
    this.blocked = true;
    this.log(`[CURSOR] Failed to hide local host cursor: ${error.message}`);
    this.stop();
  }

  stop() {
    const helper = this.helper;
    if (!helper || helper.stopping) return;
    helper.stopping = true;
    try { helper.stdin.end("R"); }
    catch (error) { this.log(`[CURSOR] Failed to restore local host cursor: ${error.message}; native watchdog remains active`); }
  }

  dispose() {
    this.setActive(false);
    this.disposed = true;
    clearInterval(this.timer);
  }
}

module.exports = { RemoteCursorVisibility };
