import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import os from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return { ...actual, spawn: spawnMock };
});

import { runPowerShell } from "../src/powershell.js";

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  pid = 1234;
  kill = vi.fn();
}

afterEach(() => {
  vi.restoreAllMocks();
  spawnMock.mockReset();
});

describe("runPowerShell executable fallback", () => {
  it("retries powershell.exe when default pwsh is missing on Windows", async () => {
    vi.spyOn(os, "platform").mockReturnValue("win32");
    const missingPwsh = new FakeChild();
    const windowsPowerShell = new FakeChild();

    spawnMock
      .mockImplementationOnce(() => {
        queueMicrotask(() => {
          missingPwsh.emit("error", Object.assign(new Error("spawn pwsh ENOENT"), { code: "ENOENT" }));
        });
        return missingPwsh;
      })
      .mockImplementationOnce(() => {
        queueMicrotask(() => {
          windowsPowerShell.stdout.write("fallback-ok\n");
          windowsPowerShell.stdout.end();
          windowsPowerShell.stderr.end();
          windowsPowerShell.emit("close", 0);
        });
        return windowsPowerShell;
      });

    const result = await runPowerShell("Write-Output fallback-ok");

    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(spawnMock.mock.calls.map((call) => call[0])).toEqual(["pwsh", "powershell.exe"]);
    expect(result.shell).toBe("powershell.exe");
    expect(result.stdout).toBe("fallback-ok");
    expect(result.exitCode).toBe(0);
  });

  it("does not hide an invalid explicit executable behind a fallback", async () => {
    vi.spyOn(os, "platform").mockReturnValue("win32");
    const missingExplicit = new FakeChild();
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => {
        missingExplicit.emit("error", Object.assign(new Error("spawn custom ENOENT"), { code: "ENOENT" }));
      });
      return missingExplicit;
    });

    const result = await runPowerShell("Get-Date", { exe: "custom-pwsh" });

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(result.shell).toBe("custom-pwsh");
    expect(result.exitCode).toBeNull();
    expect(result.stderr).toContain("spawn custom ENOENT");
  });
});
