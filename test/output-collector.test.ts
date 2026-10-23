import { describe, expect, it } from "vitest";
import { OutputCollector, captureBytes, captureDiagnostic, combineCaptures } from "../src/output-collector.js";
import { captureFromEnvelope, displayCapture } from "../src/envelope-output.js";

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

describe("combination preserves observed byte positions", () => {
  const sources: [Buffer, string][] = [
    [Buffer.from('A'), '€'], [Buffer.from('€'), 'A'],
    [Buffer.from('A¢€😀Z'), '¢€😀B'], [Buffer.from('¢€😀'), ''],
    [Buffer.alloc(0), '¢€😀'], [Buffer.from('€'), '😀'],
    [Buffer.from([0xff, 0x41, 0xe2, 0x82, 0xac]), '€Z'],
    [Buffer.from([0xe2, 0x28, 0xa1, 0xc0, 0xaf]), '😀'],
    [Buffer.from([0xf0, 0x9f]), 'Z'],
    [Buffer.from([0xe2]), '€'], [Buffer.from([0xf0, 0x9f]), '€'],
  ];
  for (const [index, [local, remote]] of sources.entries()) for (const tail of [false, true]) {
    it.each([0, 1, 2, 3, 4, 5, 6, 7, 8, 11, 32])(`matches one stream for case=${index} tail=${tail} cap=%s`, cap => {
      const first = new OutputCollector(cap, tail); first.append(local);
      const second = new OutputCollector(cap, tail); second.append(Buffer.from(remote));
      const remoteCapture = second.snapshot();
      // Exercise the wire contract too: remote captures have no private raw metadata.
      const envelope = captureFromEnvelope(remoteCapture as unknown as Record<string, unknown>, remoteCapture.text);
      const reference = new OutputCollector(cap, tail);
      reference.append(local); reference.append(Buffer.from(remote));
      const combined = combineCaptures([first.snapshot(), envelope], cap, tail);
      expect(combined).toEqual(reference.snapshot());
      expect(captureBytes(combined)).toEqual(captureBytes(reference.snapshot()));
      const smaller = Math.max(0, cap - 1);
      const recap = new OutputCollector(smaller, tail); recap.append(local); recap.append(Buffer.from(remote));
      expect(displayCapture(combined, smaller, tail)).toEqual(recap.snapshot());
    });
  }

  it.each([false, true])('keeps interior gaps during later display recapping (tail=%s)', tail => {
    const first = new OutputCollector(1, tail); first.append(Buffer.from('ABC'));
    const second = new OutputCollector(1, tail); second.append(Buffer.from('DEF'));
    const combined = combineCaptures([first.snapshot(), second.snapshot()], 6, tail);
    expect(combined).toMatchObject({ text: tail ? 'CF' : 'AD', observedBytes: 6, capturedBytes: 2, omittedBytes: 4 });
    expect(displayCapture(combined, 2, tail)).toMatchObject({ text: tail ? 'F' : 'A', observedBytes: 6, capturedBytes: 1, omittedBytes: 5 });
  });

  it.each([false, true])('does not allocate omitted regions (tail=%s)', tail => {
    const huge = { text: '', observedBytes: 1_000_000_000, capturedBytes: 0, omittedBytes: 1_000_000_000, truncated: true };
    const c = new OutputCollector(1, tail); c.append(Buffer.from('A'));
    const combined = combineCaptures(tail ? [c.snapshot(), huge] : [huge, c.snapshot()], 1, tail);
    expect(combined).toEqual({ text: '', observedBytes: 1_000_000_001, capturedBytes: 0, omittedBytes: 1_000_000_001, truncated: true });
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
