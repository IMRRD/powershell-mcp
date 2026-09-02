import { beforeEach, describe, expect, it, vi } from "vitest";

const { runPowerShellMock } = vi.hoisted(() => ({ runPowerShellMock: vi.fn() }));

vi.mock("../src/powershell.js", () => ({ runPowerShell: runPowerShellMock }));

import { WINRM_BOOTSTRAP, runWinRm } from "../src/winrm.js";

const result = {
  stdout: "ok",
  stderr: "",
  exitCode: 0,
  timedOut: false,
  durationMs: 1,
  shell: "pwsh",
  truncated: false,
};

describe("WinRM credential transport", () => {
  beforeEach(() => {
    runPowerShellMock.mockReset();
    runPowerShellMock.mockResolvedValue(result);
  });

  it("keeps all caller-controlled WinRM values out of argv, script text, and environment", async () => {
    const password = "SYNTHETIC-secret-'-$()-✓";
    const username = "SYNTHETIC\\researcher";
    const command = "Write-Output 'remote-only'";

    await runWinRm({
      computerName: "synthetic.invalid",
      command,
      username,
      password,
      useSsl: true,
      authentication: "Negotiate",
    });

    expect(runPowerShellMock).toHaveBeenCalledOnce();
    const [script, options] = runPowerShellMock.mock.calls[0];
    const processMetadata = JSON.stringify({ script, env: options.env ?? {} });

    expect(script).toBe(WINRM_BOOTSTRAP);
    expect(processMetadata).not.toContain(password);
    expect(processMetadata).not.toContain(username);
    expect(processMetadata).not.toContain(command);
    expect(processMetadata).not.toContain("synthetic.invalid");
    expect(options.env).toBeUndefined();
    expect(typeof options.stdin).toBe("string");

    const payload = JSON.parse(Buffer.from(options.stdin, "base64").toString("utf8"));
    expect(payload).toEqual({
      computerName: "synthetic.invalid",
      command,
      username,
      password,
      useSsl: true,
      authentication: "Negotiate",
    });
  });

  it("keeps integrated-identity calls credential-free", async () => {
    await runWinRm({ computerName: "host.invalid", command: "hostname" });

    const [, options] = runPowerShellMock.mock.calls[0];
    const payload = JSON.parse(Buffer.from(options.stdin, "base64").toString("utf8"));

    expect(payload.username).toBeUndefined();
    expect(payload.password).toBeUndefined();
  });
});
