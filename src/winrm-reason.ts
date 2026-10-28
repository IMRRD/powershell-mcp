/** Boundary evidence, not a diagnosis of the remote host or historical failures. */
export const WINRM_REASONS = ['completed', 'remote_script_error', 'authentication_exception', 'access_exception', 'remoting_transport_exception', 'invoke_exception', 'wrapper_result_invalid', 'frame_invalid', 'frame_body_invalid', 'local_host_error', 'local_launch_error', 'timeout', 'cancelled', 'unknown'] as const;
export type WinRmReason = typeof WINRM_REASONS[number];
export const WINRM_TRANSPORT_REASONS: readonly WinRmReason[] = ['authentication_exception', 'access_exception', 'remoting_transport_exception', 'invoke_exception', 'wrapper_result_invalid', 'unknown'];
