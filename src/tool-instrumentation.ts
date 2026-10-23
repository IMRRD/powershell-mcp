/** Fixed, private telemetry dimensions. Never pass arguments or response text to the recorder. */
export const TOOL_NAMES = ['run_powershell','list_services','get_service','control_service','system_info','ssh_exec','winrm_exec','sftp_upload','sftp_download','run_program','runtime_capabilities','start_execution','execution_status','read_execution_output','cancel_execution','read_output_log','delete_output_log','start_remote_batch','remote_batch_status','cancel_remote_batch'] as const;
export const OUTCOMES = ['success','nonzero','error','timeout','cancelled','unknown'] as const;
export const DURATIONS = ['lt100','lt1000','lt10000','gte10000'] as const;
export const FEATURES = ['execution','inspection','remote','transfer','lifecycle','logs'] as const;
export type ToolName = typeof TOOL_NAMES[number];
export type Outcome = typeof OUTCOMES[number];
export type Duration = typeof DURATIONS[number];
export type Feature = typeof FEATURES[number];
const features: Record<ToolName, Feature> = {
  run_powershell:'execution', run_program:'execution', list_services:'inspection', get_service:'inspection', control_service:'inspection', system_info:'inspection', runtime_capabilities:'inspection',
  ssh_exec:'remote', winrm_exec:'remote', start_remote_batch:'remote', remote_batch_status:'remote', cancel_remote_batch:'remote', sftp_upload:'transfer', sftp_download:'transfer',
  start_execution:'lifecycle', execution_status:'lifecycle', read_execution_output:'lifecycle', cancel_execution:'lifecycle', read_output_log:'logs', delete_output_log:'logs',
};
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function outcome(result: unknown): Outcome {
  if (!object(result)) return 'unknown';
  const data = result.structuredContent;
  if (object(data) && typeof data.terminationStatus === 'string') {
    const status = data.terminationStatus;
    return status === 'completed' ? 'success' : status === 'nonzero_exit' ? 'nonzero' : status === 'timeout' ? 'timeout' : status === 'cancelled' ? 'cancelled' : status === 'unknown' ? 'unknown' : 'error';
  }
  if (result.isError === true) return 'error';
  // Lifecycle replies are successful RPCs, not evidence the underlying job completed.
  const content = result.content;
  if (Array.isArray(content) && content.length === 1 && object(content[0]) && typeof content[0].text === 'string') {
    try {
      const body: unknown = JSON.parse(content[0].text);
      if (object(body)) {
        if (body.state === 'running' || body.state === 'reserved' || body.state === 'unknown' || body.status === 'running' || body.status === 'unknown') return 'unknown';
        if (body.state === 'cancelled' || body.status === 'cancelled') return 'cancelled';
        if (body.state === 'failed' || body.status === 'failed') return 'error';
        if (body.state === 'completed' || body.status === 'completed') return typeof body.exitCode === 'number' && body.exitCode !== 0 ? 'nonzero' : 'success';
      }
    } catch { return 'unknown'; }
  }
  return 'success'; // Read-only and accepted start/cancel RPCs, not a job outcome.
}
export function instrumentTool<T extends (...args: any[]) => any>(name: ToolName, handler: T, record: (name: ToolName, outcome: Outcome, duration: Duration, feature: Feature) => void): T {
  return (async (...args: Parameters<T>) => {
    const started = performance.now();
    let result: unknown, failed = false;
    try { result = await handler(...args); return result; }
    catch (error) { failed = true; throw error; }
    finally {
      const elapsed = performance.now() - started;
      const bucket: Duration = elapsed < 100 ? 'lt100' : elapsed < 1000 ? 'lt1000' : elapsed < 10000 ? 'lt10000' : 'gte10000';
      try { record(name, failed ? 'error' : outcome(result), bucket, features[name]); } catch { /* metrics cannot break RPC */ }
    }
  }) as T;
}
