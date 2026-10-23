export interface StreamCapture {
  /** UTF-8 rendered retained bytes; malformed input uses replacement characters. */
  text: string;
  observedBytes: number;
  /** Original input bytes represented by text, not the UTF-8 length of replacement characters. */
  capturedBytes: number;
  omittedBytes: number;
  truncated: boolean;
}

const retainedBytes = Symbol("retained original bytes");
type RawCapture = StreamCapture & { [retainedBytes]?: Buffer };

/** Envelope captures are validated UTF-8; local captures retain original OS bytes. */
export function captureBytes(capture: StreamCapture): Buffer {
  return (capture as RawCapture)[retainedBytes] ?? Buffer.from(capture.text, 'utf8');
}

/** Stable local-then-remote order; cross-host arrival order is unavailable. */
export function combineCaptures(captures: StreamCapture[], limit: number, tail: boolean): StreamCapture {
  const collector = new OutputCollector(limit, tail);
  for (const capture of captures) collector.append(captureBytes(capture));
  const combined = collector.snapshot();
  combined.observedBytes = captures.reduce((sum, capture) => sum + capture.observedBytes, 0);
  combined.omittedBytes = combined.observedBytes - combined.capturedBytes;
  combined.truncated = combined.omittedBytes > 0;
  return combined;
}

export function captureDiagnostic(previous: StreamCapture | undefined, diagnostic: string, limit: number, tail = false): StreamCapture {
  const collector = new OutputCollector(limit, tail);
  if (previous) {
    const raw = (previous as RawCapture)[retainedBytes];
    if (!raw) throw new Error("Diagnostic capture requires original retained bytes");
    collector.append(raw);
  }
  collector.append(Buffer.from(diagnostic, "utf8"));
  const capture = collector.snapshot();
  const priorOmitted = previous?.omittedBytes ?? 0;
  capture.observedBytes += priorOmitted;
  capture.omittedBytes += priorOmitted;
  capture.truncated ||= priorOmitted > 0;
  return capture;
}

/** Keeps at most limit raw bytes; decoding is deferred until the stream closes. */
export class OutputCollector {
  private bytes = Buffer.alloc(0);
  private observed = 0;
  private tailBoundaryDrop = 0;
  constructor(readonly limit: number, readonly tail = false) {
    if (!Number.isSafeInteger(limit) || limit < 0) throw new RangeError("Invalid output limit");
  }
  append(chunk: Buffer): void {
    this.observed += chunk.length;
    if (this.tail) {
      const combined = Buffer.concat([this.bytes, chunk]);
      const start = Math.max(0, combined.length - this.limit);
      this.tailBoundaryDrop = 0;
      if (start > 0 && start < combined.length) {
        for (let i = Math.max(0, start - 3); i < start; i++) {
          const lead = combined[i];
          const width = lead >= 0xc2 && lead <= 0xdf ? 2 : lead >= 0xe0 && lead <= 0xef ? 3 : lead >= 0xf0 && lead <= 0xf4 ? 4 : 0;
          if (width && i + width > start && i + width <= combined.length) {
            const scalar = combined.subarray(i, i + width);
            try { new TextDecoder("utf-8", { fatal: true }).decode(scalar);
              this.tailBoundaryDrop = i + width - start; break;
            } catch { /* malformed source is retained */ }
          }
        }
      }
      this.bytes = Buffer.from(combined.subarray(Math.max(0, combined.length - this.limit - 3)));
    } else if (this.bytes.length < this.limit) {
      this.bytes = Buffer.concat([this.bytes, chunk.subarray(0, this.limit - this.bytes.length)]);
    }
  }
  snapshot(): StreamCapture {
    let bytes = this.tail ? this.bytes.subarray(Math.max(0, this.bytes.length - this.limit)) : this.bytes;
    if (this.tail && this.observed > this.limit) bytes = bytes.subarray(this.tailBoundaryDrop);
    if (!this.tail && this.observed > bytes.length) {
      // Only a valid lead and continuation run reaching the right boundary is
      // incomplete. Interior malformed input must still decode as replacement.
      for (let i = Math.max(0, bytes.length - 3); i < bytes.length; i++) {
        const lead = bytes[i];
        const width = lead >= 0xc2 && lead <= 0xdf ? 2 : lead >= 0xe0 && lead <= 0xef ? 3 : lead >= 0xf0 && lead <= 0xf4 ? 4 : 0;
        if (width <= bytes.length - i) continue;
        const prefix = bytes.subarray(i + 1);
        if ([...prefix].every(b => b >= 0x80 && b <= 0xbf) &&
            (prefix.length === 0 || (lead !== 0xe0 || prefix[0] >= 0xa0) && (lead !== 0xed || prefix[0] < 0xa0) &&
             (lead !== 0xf0 || prefix[0] >= 0x90) && (lead !== 0xf4 || prefix[0] < 0x90))) {
          bytes = bytes.subarray(0, i); break;
        }
      }
    }
    const capturedBytes = bytes.length;
    const capture: RawCapture = { text: bytes.toString("utf8"), observedBytes: this.observed, capturedBytes,
      omittedBytes: this.observed - capturedBytes, truncated: this.observed > capturedBytes };
    Object.defineProperty(capture, retainedBytes, { value: Buffer.from(bytes) });
    return capture;
  }
}
