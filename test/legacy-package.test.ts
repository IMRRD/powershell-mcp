import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("legacy unscoped npm compatibility package", () => {
  it("forwards old installs to the canonical scoped package", () => {
    const directory = resolve(root, "compat/powershell-mcp");
    const manifest = JSON.parse(readFileSync(resolve(directory, "package.json"), "utf8"));
    const wrapper = readFileSync(resolve(directory, "bin/powershell-mcp.js"), "utf8");
    const readme = readFileSync(resolve(directory, "README.md"), "utf8");

    expect(manifest.name).toBe("powershell-mcp");
    expect(manifest.version).toBe("0.3.2");
    expect(manifest.dependencies).toEqual({ "@imrrd/powershell-mcp": "^0.5.2" });
    expect(manifest.bin).toEqual({ "powershell-mcp": "bin/powershell-mcp.js" });
    expect(wrapper).toContain('import "@imrrd/powershell-mcp"');
    expect(readme).toContain("https://www.npmjs.com/package/@imrrd/powershell-mcp");
    expect(readme).toContain("npm install -g @imrrd/powershell-mcp");
    expect(readme).toContain("receives no further releases");
    expect(readme).toContain("@imrrd/powershell-mcp@0.5.3");
  });
});
