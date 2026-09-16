import { describe, expect, it, vi } from "vitest";
import { CapturePool, type PooledCapture } from "./capture-pool";

describe("CapturePool", () => {
  it("shares one capture while keeping each session track independent", async () => {
    const tracks: { stop: ReturnType<typeof vi.fn> }[] = [];
    const capture: PooledCapture = {
      stream: {
        clone: () => {
          const track = { stop: vi.fn() };
          tracks.push(track);
          return { getTracks: () => [track] } as unknown as MediaStream;
        },
      } as MediaStream,
      stop: vi.fn(),
      setReduced: vi.fn(() => true),
    };
    const create = vi.fn(async () => capture);
    const pool = new CapturePool();
    const [first, second] = await Promise.all([
      pool.acquire("monitor:1", create),
      pool.acquire("monitor:1", create),
    ]);

    expect(create).toHaveBeenCalledTimes(1);
    expect(first.stream).not.toBe(second.stream);
    first.setReduced(true);
    second.setReduced(false);
    expect(capture.setReduced).toHaveBeenLastCalledWith(true);
    first.release();
    expect(tracks[0].stop).toHaveBeenCalledOnce();
    expect(capture.stop).not.toHaveBeenCalled();
    expect(capture.setReduced).toHaveBeenLastCalledWith(false);
    second.release();
    await Promise.resolve();
    expect(tracks[1].stop).toHaveBeenCalledOnce();
    expect(capture.stop).toHaveBeenCalledOnce();
  });

  it("retries a failed capture request", async () => {
    const pool = new CapturePool();
    await expect(pool.acquire("monitor:1", async () => { throw new Error("capture failed"); })).rejects.toThrow("capture failed");
    const stop = vi.fn();
    const lease = await pool.acquire("monitor:1", async () => ({
      stream: { clone: () => ({ getTracks: () => [] }) } as unknown as MediaStream,
      stop,
      setReduced: () => false,
    }));
    lease.release();
    await Promise.resolve();
    expect(stop).toHaveBeenCalledOnce();
  });
});
