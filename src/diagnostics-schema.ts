/** Restricted local contract. No free-text field, execution ID, target or identity. */
export const DIAGNOSTICS_POLICY = 'restricted-local-v1' as const;
export const DIAGNOSTIC_TOOLS = ['run_program', 'run_powershell', 'list_services', 'get_service', 'control_service', 'system_info', 'ssh_exec', 'winrm_exec', 'sftp_upload', 'sftp_download'] as const;
export type DiagnosticTool = typeof DIAGNOSTIC_TOOLS[number];
export const DIAGNOSTIC_TYPES = ['completed', 'nonzero_exit', 'script_error', 'remote_error', 'transport_error', 'timeout', 'cancelled', 'unknown', 'Error', 'TypeError', 'RangeError', 'SyntaxError', 'other_exception'] as const;
export type DiagnosticType = typeof DIAGNOSTIC_TYPES[number];
export const CORRELATION = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const INSTALLATION = /^[a-z][a-z0-9-]{0,63}$/;
export interface DiagnosticRecord {
  schemaVersion: 1;
  correlationId: string;
  stage: `${DiagnosticTool}.handler` | `${DiagnosticTool}.result`;
  type: 'started' | DiagnosticType;
  nativeCode: number | null;
  elapsedMs: number;
}
export type DiagnosticPair = [DiagnosticRecord, DiagnosticRecord];
export function nativeCode(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= -2147483648 && value <= 2147483647 ? value : null;
}
export function diagnosticPair(tool: DiagnosticTool, id: string, elapsed: number, type: unknown, code: unknown): DiagnosticPair {
  return [
    { schemaVersion: 1, correlationId: id, stage: `${tool}.handler`, type: 'started', nativeCode: null, elapsedMs: 0 },
    { schemaVersion: 1, correlationId: id, stage: `${tool}.result`, type: DIAGNOSTIC_TYPES.includes(type as DiagnosticType) ? type as DiagnosticType : 'unknown', nativeCode: nativeCode(code), elapsedMs: Number.isFinite(elapsed) ? Math.max(0, Math.min(300000, Math.floor(elapsed))) : 300000 },
  ];
}
export function validDiagnosticPair(value: unknown): value is DiagnosticPair {
  if (!Array.isArray(value) || value.length !== 2) return false;
  for (const row of value) {
    if (!row || typeof row !== 'object' || Array.isArray(row) || Object.keys(row).sort().join(',') !== 'correlationId,elapsedMs,nativeCode,schemaVersion,stage,type' ||
      row.schemaVersion !== 1 || typeof row.correlationId !== 'string' || !CORRELATION.test(row.correlationId) ||
      !Number.isInteger(row.elapsedMs) || row.elapsedMs < 0 || row.elapsedMs > 300000 ||
      (row.nativeCode !== null && nativeCode(row.nativeCode) === null)) return false;
  }
  return DIAGNOSTIC_TOOLS.some(tool => value[0].stage === `${tool}.handler` && value[1].stage === `${tool}.result`) &&
    value[0].correlationId === value[1].correlationId && value[0].type === 'started' && value[0].nativeCode === null && value[0].elapsedMs === 0 && DIAGNOSTIC_TYPES.includes(value[1].type);
}
