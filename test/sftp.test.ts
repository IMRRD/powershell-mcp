import { describe, it, expect } from "vitest";
import { runSftp, formatSftp, type SftpOptions, type SftpResult } from "../src/sftp.js";

const base: SftpOptions = {
  host: "h", username: "u", localPath: "/tmp/a", remotePath: "/tmp/b", direction: "upload",
};

describe("formatSftp", () => {
  it("renders a successful upload", () => {
    const r: SftpResult = { ok: true, bytes: 123, durationMs: 9 };
    const out = formatSftp(base, r);
    expect(out).toContain("sftp upload");
    expect(out).toContain("→");
    expect(out).toContain("123 bytes");
  });
  it("renders a failure", () => {
    const out = formatSftp({ ...base, direction: "download" }, { ok: false, error: "nope", durationMs: 4 });
    expect(out).toContain("sftp download");
    expect(out).toContain("FAILED: nope");
  });
});

describe("runSftp (no auth)", () => {
  it("rejects gracefully without auth", async () => {
    const r = await runSftp({ ...base, timeoutMs: 3000 });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/no auth/i);
  });
});
