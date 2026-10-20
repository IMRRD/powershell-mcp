import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";

vi.mock("ssh2", () => ({ Client: class extends EventEmitter {
  connect() { queueMicrotask(() => this.emit("ready")); }
  end() { /* local stream double */ }
  exec(command: string, cb: (error: Error | null, stream: EventEmitter & { stderr: EventEmitter }) => void) {
    const stream = Object.assign(new EventEmitter(), { stderr: new EventEmitter() });
    cb(null, stream);
    if (command === "late") {
      setTimeout(() => { stream.emit("data", Buffer.from("late")); stream.stderr.emit("data", Buffer.from("late")); stream.emit("close", 0); }, 20);
      return;
    }
    if (command === "error") {
      queueMicrotask(() => { this.emit("error", Error("synthetic")); stream.emit("data", Buffer.from("late")); stream.emit("close", 0); });
      return;
    }
    queueMicrotask(() => {
      const bytes = Buffer.from("A😀B");
      for (const byte of bytes) { stream.emit("data", Buffer.from([byte])); stream.stderr.emit("data", Buffer.from([byte])); }
      stream.emit("end"); stream.stderr.emit("end");
      stream.emit("close", 0);
    });
  }
} }));

import { runSsh } from "../src/ssh.js";
import { logStore } from "../src/full-logs.js";

describe("SSH data stream capture", () => {
  it("marks an early timeout incomplete even if the stream delivers late data", async () => {
    const r = await runSsh({ host: "synthetic.invalid", username: "local", command: "late", password: "synthetic", timeoutMs: 1, logOutput: true });
    expect(r).toMatchObject({ timedOut: true, exitCode: null, log: { complete: false } });
    expect(logStore.read(r.log!.handle, "stdout", 0, 10).complete).toBe(false);
    logStore.delete(r.log!.handle);
  });
  it("marks connection error incomplete before subsequent stream output", async () => {
    const r = await runSsh({ host: "synthetic.invalid", username: "local", command: "error", password: "synthetic", logOutput: true });
    expect(r).toMatchObject({ exitCode: null, log: { complete: false } });
    logStore.delete(r.log!.handle);
  });
  it("retains Unicode-safe tail independently on both streams", async () => {
    const r = await runSsh({ host: "synthetic.invalid", username: "local", command: "ignored", password: "synthetic", maxOutputBytes: 5, tail: true });
    expect(r).toMatchObject({ stdout: "😀B", stderr: "😀B", truncated: true, exitCode: 0,
      stdoutCapture: { observedBytes: 6, capturedBytes: 5, omittedBytes: 1 },
      stderrCapture: { observedBytes: 6, capturedBytes: 5, omittedBytes: 1 } });
  });
});
