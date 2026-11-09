import { beforeAll, expect, it, vi } from 'vitest';

type Handler = (args: object, extra: { signal: AbortSignal }) => Promise<unknown>;
const { handlers, run } = vi.hoisted(() => ({
  handlers: new Map<string, Handler>(),
  run: vi.fn(),
}));
vi.mock('@modelcontextprotocol/sdk/server/mcp.js', () => ({ McpServer: class {
  registerTool(name: string, _config: unknown, handler: Handler) { handlers.set(name, handler); }
  async connect() {}
} }));
vi.mock('../src/powershell.js', async original => ({ ...await original<typeof import('../src/powershell.js')>(), runPowerShell: run }));
vi.mock('../src/program.js', () => ({ runProgram: run }));
vi.mock('../src/execution-lifecycle.js', () => ({ executionStore: {} }));
vi.mock('../src/telemetry.js', () => ({ startupPing: vi.fn(), recordTool: vi.fn(), startFlushTimer: vi.fn() }));

beforeAll(async () => { await import('../src/index.js'); });

// All synchronous local owned-process tools must carry MCP request cancellation
// to the execution layer. Service/system handlers are synthetic; no host probe
// or service operation is executed by this contract test.
it.each([
  ['run_program', { program: 'synthetic' }],
  ['run_powershell', { script: 'synthetic' }],
  ['list_services', {}],
  ['get_service', { name: 'synthetic' }],
  ['control_service', { name: 'synthetic', action: 'status' }],
  ['system_info', {}],
])('%s propagates cancellation to its owned execution', async (name, args) => {
  const abort = new AbortController();
  let stopped = false;
  run.mockReset().mockImplementation((_command, argsOrOptions, options) => {
    const signal: AbortSignal | undefined = (options ?? argsOrOptions)?.signal;
    return new Promise(resolve => {
      const finish = () => { stopped = true; resolve({ stdout: '', stderr: '', exitCode: null, timedOut: false,
        cancelled: true, durationMs: 1, shell: 'synthetic', truncated: false }); };
      signal?.addEventListener('abort', finish, { once: true });
      // Bound the defective route so the RED run doesn't hang a test worker.
      setTimeout(() => resolve({ stdout: '', stderr: '', exitCode: null, timedOut: false,
        durationMs: 1, shell: 'synthetic', truncated: false }), 50).unref();
    });
  });
  const pending = handlers.get(name as string)!(args as object, { signal: abort.signal });
  abort.abort();
  await pending;
  expect(stopped).toBe(true);
});
