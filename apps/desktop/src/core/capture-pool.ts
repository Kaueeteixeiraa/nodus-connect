export type PooledCapture = {
  stream: MediaStream;
  stop: () => void;
  setReduced: (reduced: boolean) => boolean;
};

export type CaptureLease = {
  stream: MediaStream;
  release: () => void;
  setReduced: (reduced: boolean) => boolean;
};

type Entry = { capture: PooledCapture; users: Map<symbol, boolean> };

export class CapturePool {
  private entries = new Map<string, Promise<Entry>>();

  async acquire(key: string, create: () => Promise<PooledCapture>): Promise<CaptureLease> {
    let pending = this.entries.get(key);
    if (!pending) {
      pending = create().then((capture) => ({ capture, users: new Map<symbol, boolean>() }));
      this.entries.set(key, pending);
      pending.catch(() => {
        if (this.entries.get(key) === pending) this.entries.delete(key);
      });
    }

    const entry = await pending;
    const token = Symbol(key);
    const stream = entry.capture.stream.clone();
    entry.users.set(token, false);
    let released = false;

    return {
      stream,
      setReduced: (reduced) => {
        if (released) return false;
        const previous = entry.users.get(token) ?? false;
        entry.users.set(token, reduced);
        const applied = entry.capture.setReduced([...entry.users.values()].some(Boolean));
        if (!applied) entry.users.set(token, previous);
        return applied;
      },
      release: () => {
        if (released) return;
        released = true;
        stream.getTracks().forEach((track) => track.stop());
        entry.users.delete(token);
        if (entry.users.size) {
          entry.capture.setReduced([...entry.users.values()].some(Boolean));
        } else {
          queueMicrotask(() => {
            if (entry.users.size || this.entries.get(key) !== pending) return;
            this.entries.delete(key);
            entry.capture.stop();
          });
        }
      },
    };
  }
}
