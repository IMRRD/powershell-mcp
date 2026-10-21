import { spawnSync } from "node:child_process";

import { INPUT_LIMIT } from "./typed-input.js";

export type Engine = "pwsh" | "powershell";
export function engineExecutable(engine: Engine): string { return engine === "pwsh" ? "pwsh" : "powershell.exe"; }
export function detectEngine(exe: string): { executable: string; version: string } | null {
  const result = spawnSync(exe, ["-NoProfile", "-NonInteractive", "-Command", "$PSVersionTable.PSVersion.ToString()"], { timeout: 3000, windowsHide: true, encoding: "utf8", maxBuffer: 4096 });
  return result.status === 0 && /^\d+\.\d+/.test(result.stdout.trim()) ? { executable: exe, version: result.stdout.trim() } : null;
}
export function capabilities(version: string) {
  const supported = process.platform === "win32" ? ["pwsh", "powershell"] : ["pwsh"];
  return { packageVersion: version, protocolVersion: 1, supportedEngines: supported,
    availableEngines: supported.map(engine => ({ engine, ...detectEngine(engineExecutable(engine as Engine)) })).filter(entry => entry.version),
    defaultEnginePolicy: "Explicit engine selects only that engine; otherwise configured PWSH_MCP_EXE selects only that executable; without either, try pwsh then powershell.exe on Windows (pwsh only elsewhere).", transports: ["powershell", "program", "winrm", "ssh", "sftp"],
    limits: { inputBytes: INPUT_LIMIT, outputBytesPerStream: 8_388_608, timeoutMs: 900_000 },
  };
}