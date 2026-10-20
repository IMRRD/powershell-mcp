import { describe, it, expect } from "vitest";
import { fromProcess, fromSsh, fromSftp, resultShape, toolResult } from "../src/result.js";
import { z } from "zod";

const processResult = { stdout: "", stderr: "", exitCode: 0, timedOut: false, truncated: false, durationMs: 4, shell: "pwsh" };
const sshResult = { stdout: "", stderr: "", exitCode: null, timedOut: false, truncated: false, durationMs: 4 };

describe("shared result contract", () => {
  it("does not treat a remote host exit as command success or invent a remote code", () => {
    const data = fromProcess(processResult, "winrm", "example.invalid");
    expect(data).toMatchObject({ exitCode: null, terminationStatus: "unknown", detail: { localExitCode: 0 } });
    expect(toolResult(data, "original").isError).toBe(true);
    expect(z.object(resultShape).parse(data)).toEqual(data);
  });
  it("marks unknown SSH exit and unsolicited signals as unknown, not cancellation", () => {
    expect(fromSsh(sshResult, "u@h", 20).terminationStatus).toBe("unknown");
    const data = fromSsh({ ...sshResult, signal: "TERM" }, "u@h", 20);
    expect(data).toMatchObject({ terminationStatus: "unknown", detail: { signal: "TERM" } });
    expect(fromSsh({ ...sshResult, signal: "SEGV" }, "u@h", 20).terminationStatus).toBe("unknown");
    expect(toolResult(data, "original").isError).toBe(true);
  });
  it("does not interpret ordinary output as spawn failure", () => {
    const data = fromProcess({ ...processResult, stderr: "[spawn error] harmless\nFailed to spawn fake" }, "program", "node");
    expect(data.terminationStatus).toBe("completed");
    expect(toolResult(data, "original").isError).toBe(false);
  });
  it("uses typed spawn failure rather than stderr text", () => {
    expect(fromProcess({ ...processResult, exitCode: null, spawnError: "ENOENT" }, "program", "missing").terminationStatus).toBe("transport_error");
  });
  it("accepts a validated WinRM invocation without inventing a remote native exit", () => {
    const data = fromProcess({ ...processResult, invocationStatus: "completed", stdout: "remote output" }, "winrm", "host");
    expect(data).toMatchObject({ terminationStatus: "completed", exitCode: null, stdout: "remote output" });
    expect(toolResult(data, "original").isError).toBe(false);
  });
  it("distinguishes remote script errors and connection failures", () => {
    expect(fromProcess({ ...processResult, invocationStatus: "remote_error" }, "winrm", "host").terminationStatus).toBe("remote_error");
    expect(fromProcess({ ...processResult, invocationStatus: "transport_error" }, "winrm", "host").terminationStatus).toBe("transport_error");
  });
  it("separates SFTP success from process exit and preserves honest byte accounting", () => {
    const data = fromSftp({ ok: true, durationMs: 3 }, "u@h:/a", "upload");
    expect(data).toMatchObject({ exitCode: null, terminationStatus: "completed", detail: { direction: "upload" } });
    expect(data.detail).not.toHaveProperty("bytes");
    expect(fromSftp({ ok: false, timedOut: true, durationMs: 3 }, "u@h:/a", "download").terminationStatus).toBe("timeout");
  });
});
