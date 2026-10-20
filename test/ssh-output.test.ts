import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";

vi.mock("ssh2", () => ({ Client: class extends EventEmitter {
  connect() { queueMicrotask(() => this.emit("ready")); }
  end() { /* local stream double */ }
  exec(_command: string, cb: (error: Error | null, stream: EventEmitter & { stderr: EventEmitter }) => void) {
    const stream = Object.assign(new EventEmitter(), { stderr: new EventEmitter() });
    cb(null, stream);
    queueMicrotask(() => {
      const bytes = Buffer.from("A😀B");
      for (const byte of bytes) { stream.emit("data", Buffer.from([byte])); stream.stderr.emit("data", Buffer.from([byte])); }
      stream.emit("close", 0);
    });
  }
} }));

import { runSsh } from "../src/ssh.js";

describe("SSH data stream capture", () => {
  it("retains Unicode-safe tail independently on both streams", async () => {
    const r = await runSsh({ host: "synthetic.invalid", username: "local", command: "ignored", password: "synthetic", maxOutputBytes: 5, tail: true });
    expect(r).toMatchObject({ stdout: "😀B", stderr: "😀B", truncated: true, exitCode: 0,
      stdoutCapture: { observedBytes: 6, capturedBytes: 5, omittedBytes: 1 },
      stderrCapture: { observedBytes: 6, capturedBytes: 5, omittedBytes: 1 } });
  });
});
