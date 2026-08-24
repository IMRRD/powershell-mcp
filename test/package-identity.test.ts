import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const text = (path: string) => readFileSync(resolve(root, path), "utf8");

describe("canonical package identity", () => {
  it("keeps the npm package and MCP Registry manifest aligned", () => {
    const pkg = JSON.parse(text("package.json"));
    const server = JSON.parse(text("server.json"));

    expect(pkg.name).toBe("@imrrd/powershell-mcp");
    expect(pkg.version).toBe("0.5.2");
    expect(server.name).toBe(pkg.mcpName);
    expect(server.version).toBe(pkg.version);
    expect(server.description.length).toBeLessThanOrEqual(100);
    expect(server.packages).toEqual([
      expect.objectContaining({
        registryType: "npm",
        identifier: pkg.name,
        version: pkg.version,
        transport: { type: "stdio" },
      }),
    ]);
  });

  it("documents the scoped package and migration from the obsolete name", () => {
    const readme = text("README.md");

    expect(readme).toContain("https://www.npmjs.com/package/@imrrd/powershell-mcp");
    expect(readme).toContain("npm install -g @imrrd/powershell-mcp");
    expect(readme).toContain("@imrrd/powershell-mcp@latest");
    expect(readme).toContain("`powershell-mcp` is deprecated");
  });

  it("ships a canonical package-based MCP client example", () => {
    const example = JSON.parse(text("examples/claude_desktop_config.json"));
    const powershell = example.mcpServers.powershell;

    expect(powershell.command).toBe("npx");
    expect(powershell.args).toEqual(["-y", "@imrrd/powershell-mcp@latest"]);
    expect(powershell.env?.PWSH_MCP_EXE).toBeUndefined();
  });

  it("pins the official MCP publisher and uses GitHub OIDC", () => {
    const workflow = text(".github/workflows/publish-mcp.yml");

    expect(workflow).toContain("mcp-publisher_linux_amd64.tar.gz");
    expect(workflow).toContain("a06c9096dcb9727c13555b6be26c7effa707b01f06a4c561ba7a3635443cf2cc");
    expect(workflow).not.toContain("releases/latest");
    expect(workflow).toContain("id-token: write");
    expect(workflow).toContain("mcp-publisher login github-oidc");
    expect(workflow).toContain("mcp-publisher validate");
    expect(workflow).toContain("mcp-publisher publish");
  });
});
