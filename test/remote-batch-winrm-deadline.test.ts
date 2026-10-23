import { describe, it, expect, vi } from 'vitest';

const launch = vi.hoisted(() => vi.fn());
vi.mock('../src/powershell.js', () => ({ runPowerShell: launch }));
import { executeBatchTarget } from '../src/remote-batch.js';

 describe('batch WinRM dispatch boundary', () => {
  it('does not launch after synchronous payload preparation exhausts the deadline', async () => {
    const clock = vi.spyOn(Date, 'now');
    let now = 1000;
    clock.mockImplementation(() => now);
    let reads = 0;
    const parameters = { get value() { if (++reads >= 3) now = 2000; return 'safe'; } };
    try {
      const result = await executeBatchTarget({ transport: 'winrm', host: 'local-double', command: 'Write-Output ok', parameters }, 100);
      expect(reads).toBeGreaterThanOrEqual(3);
      expect(result).toMatchObject({ status: 'unknown', reason: expect.stringMatching(/unverified/) });
      expect(launch).not.toHaveBeenCalled();
    } finally { clock.mockRestore(); }
  });
});
