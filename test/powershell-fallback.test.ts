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
  stdin = new PassThrough();
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
  it("writes sensitive input through stdin without adding it to argv or environment", async () => {
    const child = new FakeChild();
    let received = "";
    child.stdin.on("data", (chunk: Buffer) => { received += chunk.toString("utf8"); });
    child.stdin.on("finish", () => {
      queueMicrotask(() => {
        child.stdout.end();
        child.stderr.end();
        child.emit("close", 0);
      });
    });
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => child.emit("spawn"));
      return child;
    });

    const secret = "SYNTHETIC-STDIN-ONLY";
    const result = await runPowerShell("fixed-bootstrap", { stdin: secret });
    const [, args, options] = spawnMock.mock.calls[0];

    expect(args).not.toContain(secret);
    expect(JSON.stringify(options.env)).not.toContain(secret);
    expect(options.stdio).toEqual(["pipe", "pipe", "pipe"]);
    expect(received).toBe(secret);
    expect(result.exitCode).toBe(0);
  });

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

  it("delivers stdin only to the successful Windows fallback", async () => {
    vi.spyOn(os, "platform").mockReturnValue("win32");
    const missingPwsh = new FakeChild();
    const windowsPowerShell = new FakeChild();
    let missingInput = "";
    let fallbackInput = "";
    missingPwsh.stdin.on("data", (chunk: Buffer) => { missingInput += chunk.toString("utf8"); });
    windowsPowerShell.stdin.on("data", (chunk: Buffer) => { fallbackInput += chunk.toString("utf8"); });
    windowsPowerShell.stdin.on("finish", () => {
      queueMicrotask(() => {
        windowsPowerShell.stdout.end();
        windowsPowerShell.stderr.end();
        windowsPowerShell.emit("close", 0);
      });
    });

    spawnMock
      .mockImplementationOnce(() => {
        queueMicrotask(() => missingPwsh.emit(
          "error",
          Object.assign(new Error("spawn pwsh ENOENT"), { code: "ENOENT" }),
        ));
        return missingPwsh;
      })
      .mockImplementationOnce(() => {
        queueMicrotask(() => windowsPowerShell.emit("spawn"));
        return windowsPowerShell;
      });

    const result = await runPowerShell("fixed-bootstrap", { stdin: "fallback-secret" });

    expect(missingInput).toBe("");
    expect(fallbackInput).toBe("fallback-secret");
    expect(spawnMock.mock.calls.every(([, args]) => !args.includes("fallback-secret"))).toBe(true);
    expect(result.shell).toBe("powershell.exe");
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
