import { describe, expect, it } from 'vitest';
import { selectIntegrationEngines } from './integration-engine.js';

describe('integration engine admission', () => {
  const probe = (exe: string) => exe === 'pwsh.exe' ? '7.5.0' : exe === 'powershell.exe' ? '5.1.19041.1' : null;
  it('selects Windows PowerShell even when pwsh is installed', () => {
    expect(selectIntegrationEngines('powershell', 'win32', probe)).toEqual([{ exe: 'powershell.exe', version: '5.1.19041.1' }]);
  });
  it('refuses absent required engine rather than falling back or skipping', () => {
    expect(() => selectIntegrationEngines('powershell', 'win32', () => null)).toThrow(/Required engine powershell.*unavailable/);
  });
  it('preserves developer auto discovery and rejects invalid lane values', () => {
    expect(selectIntegrationEngines(null, 'win32', probe).map(x => x.exe)).toEqual(['powershell.exe', 'pwsh.exe']);
    expect(() => selectIntegrationEngines('unknown', 'win32', probe)).toThrow(/Invalid MCP_REQUIRED_ENGINE/);
  });
  it('refuses an executable reporting the wrong major version', () => {
    expect(() => selectIntegrationEngines('powershell', 'win32', () => '7.5.0')).toThrow(/version/);
  });
});
