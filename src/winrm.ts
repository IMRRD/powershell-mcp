import { runPowerShell, type PsResult } from "./powershell.js";

export interface WinRmOptions {
  computerName: string;
  command: string;
  username?: string;
  password?: string;
  useSsl?: boolean;
  /** Negotiate (default) | Kerberos | Basic | CredSSP | Default */
  authentication?: "Default" | "Negotiate" | "Kerberos" | "Basic" | "CredSSP";
  timeoutMs?: number;
}

const sq = (s: string) => s.replace(/'/g, "''");

/**
 * Run a command on a remote *Windows* host via PowerShell Remoting (WinRM),
 * using Invoke-Command -ComputerName. Native to Windows Server — no SSH server
 * or agent install required on the target, only WinRM enabled. Output is
 * captured by the local hidden PowerShell host (no console window).
 */
export function runWinRm(opts: WinRmOptions): Promise<PsResult> {
  const cn = sq(opts.computerName);
  let prelude = "";
  let credArg = "";
  if (opts.username) {
    prelude =
      `$sec = ConvertTo-SecureString '${sq(opts.password ?? "")}' -AsPlainText -Force; ` +
      `$cred = New-Object System.Management.Automation.PSCredential('${sq(opts.username)}', $sec); `;
    credArg = "-Credential $cred ";
  }
  const ssl = opts.useSsl ? "-UseSSL " : "";
  const auth = opts.authentication ? `-Authentication ${opts.authentication} ` : "";
  // The remote command runs as a scriptblock; 2>&1 merges remote errors into the stream.
  const script =
    `${prelude}Invoke-Command -ComputerName '${cn}' ${ssl}${auth}${credArg}` +
    `-ScriptBlock { ${opts.command} } 2>&1 | Out-String -Width 240`;
  return runPowerShell(script, { timeoutMs: opts.timeoutMs ?? 120_000 });
}
