import { describe, it, expect } from "vitest";
import { runSsh, formatSsh, type SshResult } from "../src/ssh.js";

describe("formatSsh", () => {
  it("renders a successful result", () => {
    const r: SshResult = { stdout: "hello\n", stderr: "", exitCode: 0, timedOut: false, durationMs: 12 };
    const out = formatSsh("isak@nuc", r);
    expect(out).toContain("$ ssh isak@nuc");
    expect(out).toContain("exit=0");
    expect(out).toContain("hello");
  });

  it("surfaces errors and non-zero exit", () => {
    const r: SshResult = { stdout: "", stderr: "boom", exitCode: 1, timedOut: false, error: "connection error", durationMs: 5 };
    const out = formatSsh("u@h", r);
    expect(out).toContain("[error] connection error");
    expect(out).toContain("[stderr]");
    expect(out).toContain("boom");
  });
});

describe("runSsh (no auth)", () => {
  it("rejects gracefully when no auth is supplied", async () => {
    const r = await runSsh({ host: "127.0.0.1", username: "nobody", command: "true", timeoutMs: 3000 });
    expect(r.error).toMatch(/no auth/i);
    expect(r.exitCode).toBeNull();
  });

  it("returns an error (not a throw) for an unreachable host", async () => {
    const r = await runSsh({ host: "10.255.255.1", username: "x", password: "y", command: "true", timeoutMs: 2500 });
    expect(r.exitCode).toBeNull();
    expect(r.error || r.timedOut).toBeTruthy();
  });
});

// Opt-in live test: set SSH_TEST_HOST / SSH_TEST_USER / SSH_TEST_KEY to run.
const liveHost = process.env.SSH_TEST_HOST;
describe.skipIf(!liveHost)("runSsh (live)", () => {
  it("executes a command on the real host", async () => {
    const r = await runSsh({
      host: liveHost!,
      username: process.env.SSH_TEST_USER || "isak",
      privateKeyPath: process.env.SSH_TEST_KEY,
      command: "echo SSH_LIVE_OK",
      timeoutMs: 15000,
    });
    expect(r.stdout).toContain("SSH_LIVE_OK");
    expect(r.exitCode).toBe(0);
  });
});
