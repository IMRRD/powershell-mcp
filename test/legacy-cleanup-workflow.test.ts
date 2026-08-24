import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("one-shot legacy npm cleanup", () => {
  it("is manually gated and uses only the package-scoped secret", () => {
    const workflow = readFileSync(resolve(root, ".github/workflows/retire-legacy-npm.yml"), "utf8");

    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).not.toContain("pull_request:");
    expect(workflow).not.toContain("push:");
    expect(workflow).toContain("github.actor == 'isak-ialogics'");
    expect(workflow).toContain("github.triggering_actor == 'isak-ialogics'");
    expect(workflow).toContain("NODE_AUTH_TOKEN: ${{ secrets.NPM_LEGACY_TOKEN }}");
    expect(workflow).toContain("permissions:\n  contents: read");
  });

  it("publishes the exact forwarder once, deprecates every legacy version, and verifies both states", () => {
    const workflow = readFileSync(resolve(root, ".github/workflows/retire-legacy-npm.yml"), "utf8");

    expect(workflow).toContain("powershell-mcp@0.3.2");
    expect(workflow).toContain("npm publish --access public");
    expect(workflow).toContain("npm deprecate 'powershell-mcp@*'");
    expect(workflow).toContain("@imrrd/powershell-mcp");
    expect(workflow).toContain("npm view powershell-mcp@0.3.2 version");
    expect(workflow).toContain("npm view \"powershell-mcp@${version}\" deprecated");
  });
});
