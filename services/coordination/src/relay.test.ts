import { afterEach, describe, expect, it } from "vitest";
import { getIceServers } from "./relay";

const keys = [
  "NODUS_ICE_SERVERS_JSON",
  "NODUS_STUN_URLS",
  "NODUS_TURN_URLS",
  "NODUS_TURN_URL",
  "NODUS_TURN_USERNAME",
  "NODUS_TURN_CREDENTIAL",
  "NODUS_TURN_SECRET",
];
const backup = Object.fromEntries(keys.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const key of keys) {
    if (backup[key]) process.env[key] = backup[key];
    else delete process.env[key];
  }
});

describe("getIceServers", () => {
  it("uses public STUN by default", () => {
    for (const key of keys) delete process.env[key];
    expect(getIceServers()).toEqual([{ urls: ["stun:stun.l.google.com:19302"] }]);
  });

  it("adds TURN when credentials exist", () => {
    process.env.NODUS_TURN_URLS = "turn:turn.example.com:3478?transport=udp";
    process.env.NODUS_TURN_USERNAME = "user";
    process.env.NODUS_TURN_CREDENTIAL = "secret";

    expect(getIceServers()).toContainEqual({
      urls: ["turn:turn.example.com:3478?transport=udp"],
      username: "user",
      credential: "secret",
    });
  });

  it("keeps multiple TURN routes together", () => {
    process.env.NODUS_TURN_URLS = "turn:turn.example.com:3478?transport=udp,turn:turn.example.com:443?transport=tcp";
    process.env.NODUS_TURN_USERNAME = "user";
    process.env.NODUS_TURN_CREDENTIAL = "secret";

    expect(getIceServers()).toContainEqual({
      urls: ["turn:turn.example.com:3478?transport=udp", "turn:turn.example.com:443?transport=tcp"],
      username: "user",
      credential: "secret",
    });
  });

  it("accepts whitespace-separated TURN routes", () => {
    process.env.NODUS_TURN_URLS = "turn:turn.example.com:80?transport=udp turn:turn.example.com:443?transport=tcp";
    process.env.NODUS_TURN_USERNAME = "user";
    process.env.NODUS_TURN_CREDENTIAL = "secret";

    expect(getIceServers()).toContainEqual({
      urls: ["turn:turn.example.com:80?transport=udp", "turn:turn.example.com:443?transport=tcp"],
      username: "user",
      credential: "secret",
    });
  });
});
