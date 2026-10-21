import { readFileSync } from 'node:fs';
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
