import { describe, expect, it } from "vitest";
import { OutputCollector, captureDiagnostic } from "../src/output-collector.js";

describe("byte-bounded collector", () => {
  it("clips one oversized chunk and counts all observed bytes", () => {
    const c = new OutputCollector(3);
    c.append(Buffer.from("abcdefgh"));
    expect(c.snapshot()).toEqual({ text: "abc", observedBytes: 8, capturedBytes: 3, omittedBytes: 5, truncated: true });
  });
  it("retains exact limit without truncation and drains subsequent chunks", () => {
    const c = new OutputCollector(4);
    c.append(Buffer.from("ab")); c.append(Buffer.from("cd"));
    expect(c.snapshot()).toMatchObject({ text: "abcd", observedBytes: 4, capturedBytes: 4, omittedBytes: 0, truncated: false });
    c.append(Buffer.from("ef"));
    expect(c.snapshot()).toMatchObject({ text: "abcd", observedBytes: 6, omittedBytes: 2, truncated: true });
  });
  it("decodes emoji split across chunks, and drops incomplete retained boundaries honestly", () => {
    const bytes = Buffer.from("A😀B");
    for (const tail of [false, true]) {
      const c = new OutputCollector(5, tail);
      for (const b of bytes) c.append(Buffer.from([b]));
      expect(c.snapshot()).toMatchObject({ text: tail ? "😀B" : "A😀", observedBytes: 6, capturedBytes: 5, omittedBytes: 1, truncated: true });
    }
    const c = new OutputCollector(2, true);
    c.append(Buffer.from("😀"));
    expect(c.snapshot()).toMatchObject({ text: "", capturedBytes: 0, omittedBytes: 4, truncated: true });
  });
  it("handles zero capacity, newline-free tail and malformed UTF-8 explicitly", () => {
    const zero = new OutputCollector(0); zero.append(Buffer.from("abc"));
    expect(zero.snapshot()).toMatchObject({ text: "", observedBytes: 3, capturedBytes: 0, omittedBytes: 3 });
    const tail = new OutputCollector(3, true); tail.append(Buffer.from("abcdefgh"));
    expect(tail.snapshot().text).toBe("fgh");
    const malformed = new OutputCollector(2); malformed.append(Buffer.from([0xff, 0x61]));
    expect(malformed.snapshot()).toMatchObject({ text: "�a", capturedBytes: 2, observedBytes: 2 });
  });
  it("retains malformed interior bytes while removing only a cut valid scalar", () => {
    const head = new OutputCollector(4); head.append(Buffer.from([0xff, 0x61, 0xe2, 0x82, 0xac, 0x62]));
    expect(head.snapshot()).toEqual({ text: "�a", observedBytes: 6, capturedBytes: 2, omittedBytes: 4, truncated: true });
    const tail = new OutputCollector(4, true); tail.append(Buffer.from([0x61, 0xe2, 0x82, 0xac, 0xff, 0x62]));
    expect(tail.snapshot()).toEqual({ text: "�b", observedBytes: 6, capturedBytes: 2, omittedBytes: 4, truncated: true });
    const split = new OutputCollector(4, true);
    for (const byte of [0x61, 0xe2, 0x82, 0xac, 0xff, 0x62]) split.append(Buffer.from([byte]));
    expect(split.snapshot()).toEqual(tail.snapshot());
  });
  it("preserves malformed bytes and complete scalars at exact and zero limits", () => {
    for (const tail of [false, true]) {
      const exact = new OutputCollector(4, tail); exact.append(Buffer.from([0xff, 0xe2, 0x82, 0xac]));
      expect(exact.snapshot()).toMatchObject({ text: "�€", capturedBytes: 4, omittedBytes: 0 });
      const zero = new OutputCollector(0, tail); zero.append(Buffer.from("€"));
      expect(zero.snapshot()).toMatchObject({ text: "", capturedBytes: 0, omittedBytes: 3 });
      if (tail) {
        const split = new OutputCollector(1, true);
        for (const byte of Buffer.from("€")) split.append(Buffer.from([byte]));
        expect(split.snapshot()).toMatchObject({ text: "", capturedBytes: 0, omittedBytes: 3 });
      }
    }
  });
});

describe("diagnostic byte provenance", () => {
  it.each([false, true])("counts original malformed bytes when appending (tail=%s)", tail => {
    const prior = new OutputCollector(2, tail);
    prior.append(Buffer.from([0xff, 0x41]));
    const result = captureDiagnostic(prior.snapshot(), "Z", 1, tail);
    expect(result).toMatchObject({ text: tail ? "Z" : "�", observedBytes: 3, capturedBytes: 1, omittedBytes: 2, truncated: true });
  });
});
