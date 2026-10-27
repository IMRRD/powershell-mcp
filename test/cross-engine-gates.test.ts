import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
const text = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
describe('cross-engine release gate', () => {
  it('requires both Windows engines and Linux for the same reusable release gate', () => {
    const ci = text('.github/workflows/ci.yml');
    expect(ci).toContain('workflow_call:');
    expect(ci).toMatch(/os: windows-latest\s+engine: powershell/);
    expect(ci).toMatch(/os: windows-latest\s+engine: pwsh/);
    expect(ci).toMatch(/os: ubuntu-latest\s+engine: pwsh/);
    expect(ci).toContain('npm ci');
    expect(ci).toContain('node scripts/check-test-report.mjs');
    expect(ci).toContain('node scripts/installed-smoke.mjs');
    for (const workflow of ['publish.yml', 'publish-mcp.yml']) {
      expect(text(`.github/workflows/${workflow}`)).toMatch(/cross-engine-gate:[\s\S]*?uses: \.\/\.github\/workflows\/ci.yml[\s\S]*?needs: cross-engine-gate/);
    }
  });
  it('keeps Windows local spawn paths hidden without claiming foreground focus', () => {
    for (const source of ['src/powershell.ts', 'src/program.ts', 'src/execution-lifecycle.ts'])
      expect(text(source)).toContain('windowsHide: true');
    expect(text('README.md')).toContain('headless CI cannot prove foreground focus preservation');
  });
});

describe('Vitest report validator contract', () => {
  const requiredSuites = ['lifecycle-acceptance', 'owned-process', 'remote-lifecycle', 'execution-lifecycle', 'structured-protocol', 'host-trust', 'credential-ref', 'staged-sftp', 'ssh', 'sftp', 'powershell'];
  // Independent expected contract, not parsed from the validator implementation.
  const proofs = ['program', 'powershell', 'durable'].flatMap(caller => [0, 4500].map(delay =>
    `lifecycle acceptance ${caller} cancels parent child grandchild after ${delay}ms startup within a bound and preserves unrelated process`));
  const engineProof = 'runPowerShell (integration) executes required engine and verifies child version';
  const assertion = (fullName: string, status = 'passed') => ({ fullName, status });
  const fixture = () => {
    const testResults = requiredSuites.map(name => ({ name: `C:\\repo\\test\\${name}.test.ts`, assertionResults: [assertion(`${name} suite control`)] }));
    testResults[0].assertionResults.push(...proofs.map(title => assertion(title)));
    testResults.at(-1)!.assertionResults.push(assertion(engineProof));
    testResults.push({ name: '/repo/test/linux-supervisor-eof.test.ts', assertionResults: Array.from({ length: 4 }, (_, lane) => assertion(`EOF lane ${lane}`)) });
    const count = testResults.flatMap(s => s.assertionResults).length;
    return { numTotalTests: count, numPassedTests: count, numFailedTests: 0, numPendingTests: 0, testResults };
  };
  const validate = (report: ReturnType<typeof fixture>, platform = 'win32', engine = 'powershell') => {
    const dir = mkdtempSync(join(tmpdir(), 'report-validator-'));
    try {
      const path = join(dir, 'report.json');
      writeFileSync(path, JSON.stringify(report));
      // Run the actual CLI source in a child. Override only platform to exercise
      // both OS gates on every host; these fixtures do not execute PowerShell.
      return spawnSync(process.execPath, ['--input-type=module', '--eval',
        `Object.defineProperty(process, 'platform', { value: ${JSON.stringify(platform)} }); await import(${JSON.stringify(new URL('../scripts/check-test-report.mjs', import.meta.url).href)});`, 'check-test-report.mjs', path],
      { encoding: 'utf8', windowsHide: true, timeout: 10000, env: { ...process.env, MCP_REQUIRED_ENGINE: engine } });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  };
  const rejects = (report: ReturnType<typeof fixture>, reason: string, platform = 'win32', engine = 'powershell') => {
    const result = validate(report, platform, engine);
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain(reason);
  };

  it.each([['win32', 'powershell'], ['linux', 'pwsh']])('accepts all six proofs and required gates on %s / %s', (platform, engine) => {
    const result = validate(fixture(), platform, engine);
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
  });

  for (const title of proofs) for (const state of ['missing', 'failed', 'pending']) {
    it(`rejects ${state} owned-tree proof: ${title}`, () => {
      const report = fixture(), assertions = report.testResults[0].assertionResults;
      const index = assertions.findIndex(a => a.fullName === title);
      if (state === 'missing') assertions.splice(index, 1);
      else assertions[index].status = state;
      // Keep aggregate counts valid to isolate the exact proof/status guard.
      rejects(report, `Missing owned-tree proof: ${title}`);
    });
  }

  it('rejects the three legacy titles even when all required suites pass', () => {
    const report = fixture();
    report.testResults[0].assertionResults = ['program', 'powershell', 'durable'].map(caller =>
      assertion(`lifecycle acceptance ${caller} cancels parent child grandchild within a bound and preserves unrelated process`));
    rejects(report, `Missing owned-tree proof: ${proofs[0]}`);
  });

  it.each(proofs)('requires an exact fullName for %s', title => {
    const report = fixture();
    report.testResults[0].assertionResults.find(a => a.fullName === title)!.fullName += ' extra';
    rejects(report, `Missing owned-tree proof: ${title}`);
  });

  it.each(requiredSuites)('retains required suite admission for %s', name => {
    const report = fixture();
    report.testResults = report.testResults.filter(s => !s.name.endsWith(`\\${name}.test.ts`));
    rejects(report, `Required suite absent or entirely skipped: ${name}.test.ts`);
  });

  it('rejects an entirely skipped required suite', () => {
    const report = fixture();
    report.testResults[1].assertionResults[0].status = 'pending';
    rejects(report, 'Required suite absent or entirely skipped: owned-process.test.ts');
  });

  it.each(['missing', 'failed', 'pending'])('retains required child engine proof when %s', state => {
    const report = fixture(), suite = report.testResults.find(s => s.name.endsWith('\\powershell.test.ts'))!;
    if (state === 'missing') suite.assertionResults = suite.assertionResults.filter(a => a.fullName !== engineProof);
    else suite.assertionResults.find(a => a.fullName === engineProof)!.status = state;
    rejects(report, 'Missing actual child executable/version integration proof');
  });

  it('refuses Windows PowerShell on Linux even with passing report proofs', () => {
    rejects(fixture(), 'Windows PowerShell requires Windows', 'linux');
  });

  it.each(['missing', 'three lanes', 'five lanes', 'failed', 'pending'])('retains Linux EOF admission with %s', state => {
    const report = fixture(), suite = report.testResults.at(-1)!;
    if (state === 'missing') report.testResults.pop();
    else if (state === 'three lanes') suite.assertionResults.pop();
    else if (state === 'five lanes') suite.assertionResults.push(assertion('extra EOF lane'));
    else suite.assertionResults[0].status = state;
    rejects(report, 'Missing repeated Linux native echo/EOF completion proof (four lanes, 64 invocations)', 'linux', 'pwsh');
  });

  it.each(['empty', 'failed', 'inconsistent', 'fractional'])('retains aggregate report admission for %s counts', state => {
    const report = fixture();
    if (state === 'empty') report.numPassedTests = report.numTotalTests = 0;
    else if (state === 'failed') { report.numFailedTests = 1; report.numPassedTests--; }
    else if (state === 'inconsistent') report.numTotalTests++;
    else report.numTotalTests += 0.5;
    rejects(report, 'Invalid/failed/empty Vitest report');
  });
});
