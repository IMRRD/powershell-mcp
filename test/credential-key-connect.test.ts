import { expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { generateKeyPairSync } from "node:crypto";
import { createRequire } from "node:module";
const { utils } = createRequire(import.meta.url)("ssh2") as typeof import("ssh2");

const { connects } = vi.hoisted(() => ({ connects: [] as Record<string, unknown>[] }));
vi.mock("ssh2", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ssh2")>();
  return { ...actual, Client: class extends EventEmitter {
    connect(config: Record<string, unknown>) { connects.push(config); this.emit("error", new Error("synthetic stop before network")); }
    end() {}
  } };
});
import { runSsh } from "../src/ssh.js";
import { runSftp } from "../src/sftp.js";

it("forwards a real synthetic encrypted PEM and passphrase to both ssh2 transports", async () => {
  const passphrase = "synthetic-key-passphrase";
  const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs1", format: "pem", cipher: "aes-256-cbc", passphrase }, publicKeyEncoding: { type: "spki", format: "pem" } }).privateKey;
  expect(utils.parseKey(privateKey, "wrong-passphrase")).toBeInstanceOf(Error);
  expect(utils.parseKey(privateKey, passphrase)).not.toBeInstanceOf(Error);
  for (const run of [
    () => runSsh({ host: "example.invalid", username: "synthetic", command: "true", privateKey, passphrase }),
    () => runSftp({ host: "example.invalid", username: "synthetic", localPath: "none", remotePath: "none", direction: "upload", privateKey, passphrase }),
  ]) {
    const before = connects.length;
    const result = await run();
    expect(connects).toHaveLength(before + 1);
    expect(connects[before]).toMatchObject({ privateKey, passphrase });
    expect(utils.parseKey(connects[before].privateKey as string, connects[before].passphrase as string)).not.toBeInstanceOf(Error);
    expect(JSON.stringify(result)).not.toContain(passphrase);
    expect(JSON.stringify(result)).not.toContain(privateKey);
  }
});
