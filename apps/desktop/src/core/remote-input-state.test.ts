import { describe, expect, it } from "vitest";
import { RemoteInputState } from "./remote-input-state";

const ctrl = { type: "keyDown" as const, keyCode: 162, code: "ControlLeft", location: 1, repeat: false };
const mouse = { type: "mouseDown" as const, button: 0, x: 0.5, y: 0.6 };
describe("remote input recovery", () => {
  it("releases only held keys and buttons once after a disconnected channel", () => {
    const state = new RemoteInputState();
    state.record("one", ctrl); state.record("one", mouse); state.record("one", { type: "clipboard" });
    expect(state.release("one")).toEqual([{ ...ctrl, type: "keyUp" }, { ...mouse, type: "mouseUp" }]);
    expect(state.release("one")).toEqual([]);
  });
  it("preserves input held by another session and clears keys already released", () => {
    const state = new RemoteInputState();
    state.record("one", ctrl); state.record("two", ctrl); state.record("one", mouse);
    state.record("one", { ...mouse, type: "mouseUp" });
    expect(state.release("one")).toEqual([]);
    expect(state.release("two")).toEqual([{ ...ctrl, type: "keyUp" }]);
  });
});
