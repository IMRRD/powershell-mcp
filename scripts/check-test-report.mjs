import { readFileSync } from 'node:fs';
const report = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const { numTotalTests: discovered, numPassedTests: passed, numFailedTests: failed, numPendingTests: skipped } = report;
console.log(`Vitest discovered=${discovered} passed=${passed} failed=${failed} skipped=${skipped} suites=${report.testResults?.length ?? 0} engine=${process.env.MCP_REQUIRED_ENGINE ?? 'unspecified'}`);
if (!Number.isInteger(discovered) || !passed || failed || passed + failed + skipped !== discovered) throw new Error('Invalid/failed/empty Vitest report');
const names = (report.testResults ?? []).map(t => t.name.replaceAll('\\', '/'));
for (const required of ['lifecycle-acceptance.test.ts', 'owned-process.test.ts', 'remote-lifecycle.test.ts', 'execution-lifecycle.test.ts', 'structured-protocol.test.ts', 'host-trust.test.ts', 'credential-ref.test.ts', 'staged-sftp.test.ts', 'ssh.test.ts', 'sftp.test.ts', 'powershell.test.ts']) {
  const suite = report.testResults.find(t => t.name.replaceAll('\\', '/').endsWith('/' + required));
  if (!suite || !suite.assertionResults?.some(t => t.status === 'passed')) throw new Error(`Required suite absent or entirely skipped: ${required}`);
}
for (const title of ['program', 'powershell', 'durable'].flatMap(c => [0, 4500].map(delay => `lifecycle acceptance ${c} cancels parent child grandchild after ${delay}ms startup within a bound and preserves unrelated process`))) {
  if (!report.testResults.flatMap(s => s.assertionResults ?? []).some(t => t.fullName === title && t.status === 'passed')) throw Error(`Missing owned-tree proof: ${title}`);
}
if (process.platform === 'linux') {
  const suite = report.testResults.find(t => t.name.replaceAll('\\', '/').endsWith('/linux-supervisor-eof.test.ts'));
  if (suite?.assertionResults?.length !== 4 || !suite.assertionResults.every(t => t.status === 'passed'))
    throw Error('Missing repeated Linux native echo/EOF completion proof (four lanes, 64 invocations)');
}
if (process.env.MCP_REQUIRED_ENGINE === 'powershell' && process.platform !== 'win32') throw new Error('Windows PowerShell requires Windows');
if (process.env.MCP_REQUIRED_ENGINE) {
  const proof = report.testResults.flatMap(s => s.assertionResults ?? []).find(t => t.fullName === 'runPowerShell (integration) executes required engine and verifies child version');
  if (proof?.status !== 'passed') throw new Error('Missing actual child executable/version integration proof');
}
