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
const retainedPositions = Symbol("retained byte positions");
type RetainedSpan = { start: number; bytes: Buffer };
type RawCapture = StreamCapture & { [retainedBytes]?: Buffer; [retainedPositions]?: RetainedSpan[] };

/** Envelope captures are validated UTF-8; local captures retain original OS bytes. */
export function captureBytes(capture: StreamCapture): Buffer {
  return (capture as RawCapture)[retainedBytes] ?? Buffer.from(capture.text, 'utf8');
}

function trimHeadBoundary(bytes: Buffer): Buffer {
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
      return bytes.subarray(0, i);
    }
  }
  return bytes;
}

/** Stable local-then-remote order; cross-host arrival order is unavailable. */
export function combineCaptures(captures: StreamCapture[], limit: number, tail: boolean): StreamCapture {
  if (!Number.isSafeInteger(limit) || limit < 0) throw new RangeError("Invalid output limit");
  const observedBytes = captures.reduce((sum, capture) => sum + capture.observedBytes, 0);
  const windowStart = tail ? Math.max(0, observedBytes - limit) : 0;
  const windowEnd = tail ? observedBytes : Math.min(observedBytes, limit);
  // Inputs use the requested head/tail direction. Envelope text is a prefix or
  // suffix of its observed segment, including any Unicode boundary omissions.
  // Keep three context bytes at the cut to distinguish valid UTF-8 from malformed
  // raw input. Neither missing regions nor the full observed stream are allocated.
  const contextStart = tail ? Math.max(0, windowStart - 3) : windowStart;
  const contextEnd = tail ? windowEnd : Math.min(observedBytes, windowEnd + 3);
  const runs: { start: number; end: number; pieces: Buffer[] }[] = [];
  let offset = 0;
  for (const capture of captures) {
    const raw = captureBytes(capture);
    const spans = (capture as RawCapture)[retainedPositions] ??
      [{ start: tail ? capture.observedBytes - raw.length : 0, bytes: raw }];
    for (const span of spans) {
      const start = Math.max(contextStart, offset + span.start);
      const end = Math.min(contextEnd, offset + span.start + span.bytes.length);
      if (end <= start) continue;
      const piece = span.bytes.subarray(start - offset - span.start, end - offset - span.start);
      const last = runs.at(-1);
      if (last?.end === start) { last.end = end; last.pieces.push(piece); }
      else runs.push({ start, end, pieces: [piece] });
    }
    offset += capture.observedBytes;
  }
  const positions: RetainedSpan[] = [];
  for (const run of runs) {
    const start = Math.max(windowStart, run.start), end = Math.min(windowEnd, run.end);
    if (end <= start) continue;
    const collector = new OutputCollector(end - start, tail);
    collector.append(Buffer.concat(run.pieces));
    let bytes = captureBytes(collector.snapshot());
    // The next source may have retained nothing, so this run can end exactly
    // at the cut without carrying the observed bytes beyond it as context.
    if (!tail && run.end === windowEnd && windowEnd < observedBytes) bytes = trimHeadBoundary(bytes);
    if (bytes.length) positions.push({ start: tail ? end - bytes.length : start, bytes });
  }
  const bytes = Buffer.concat(positions.map(span => span.bytes));
  const combined: RawCapture = { text: bytes.toString('utf8'), observedBytes, capturedBytes: bytes.length,
    omittedBytes: observedBytes - bytes.length, truncated: observedBytes > bytes.length };
  Object.defineProperty(combined, retainedBytes, { value: bytes });
  Object.defineProperty(combined, retainedPositions, { value: positions });
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
    let bytes: Buffer = this.tail ? this.bytes.subarray(Math.max(0, this.bytes.length - this.limit)) : this.bytes;
    if (this.tail && this.observed > this.limit) bytes = bytes.subarray(this.tailBoundaryDrop);
    if (!this.tail && this.observed > bytes.length) bytes = trimHeadBoundary(bytes);
    const capturedBytes = bytes.length;
    const capture: RawCapture = { text: bytes.toString("utf8"), observedBytes: this.observed, capturedBytes,
      omittedBytes: this.observed - capturedBytes, truncated: this.observed > capturedBytes };
    Object.defineProperty(capture, retainedBytes, { value: Buffer.from(bytes) });
    return capture;
  }
}
