import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("v0.9.1 release contract", () => {
  it("pins a trusted-publishing-compatible Node and npm toolchain", () => {
    const workflow = readFileSync(resolve(root, ".github/workflows/publish.yml"), "utf8");

    expect(workflow).toContain("node-version: 24.15.0");
    expect(workflow).toContain("npm install -g npm@11.6.2");
    expect(workflow).not.toContain("npm@latest");
    expect(workflow).toContain("id-token: write");
    expect(workflow).toContain("npm publish --access public --provenance");
    expect(workflow).toContain("tags: ['v*.*.*']");
    expect(workflow).not.toContain("release:");
  });

  it("keeps package and lockfile versions aligned", () => {
    const manifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
    const lockfile = JSON.parse(readFileSync(resolve(root, "package-lock.json"), "utf8"));

    expect(manifest.version).toBe("0.9.1");
    expect(lockfile.version).toBe("0.9.1");
    expect(lockfile.packages[""].version).toBe("0.9.1");
  });

  it("does not retain a credentialed legacy release workflow", () => {
    expect(existsSync(resolve(root, ".github/workflows/publish-legacy-security.yml"))).toBe(false);
  });

  it("locks the selected security update versions", () => {
    const manifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
    const lockfile = JSON.parse(readFileSync(resolve(root, "package-lock.json"), "utf8"));
    expect(manifest.dependencies.zod).toBe("^4.6.6");
    for (const [name, version] of Object.entries({ "@hono/node-server": "2.1.3", "body-parser": "2.4.0", "fast-uri": "4.2.3", qs: "6.16.1" })) {
      expect(manifest.overrides[name]).toBe(version);
      expect(lockfile.packages[`node_modules/${name}`].version).toBe(version);
    }
    expect(lockfile.packages['node_modules/zod'].version).toBe('4.6.6');
  });
});
