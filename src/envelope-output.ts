import { OutputCollector, captureBytes, type StreamCapture } from "./output-collector.js";
import { logStore } from "./full-logs.js";

export function protectedPayload(body: Record<string, unknown>, displayLimit: number, tail: boolean, quota?: number, reservedLog?: ReturnType<typeof logStore.create>, combinedStderr?: StreamCapture) {
  const full = captureFromEnvelope(body, body.output as string);
  const stderr = combinedStderr ?? (body.stderr === undefined ? undefined : captureFromEnvelope(body.stderr as Record<string, unknown>, (body.stderr as Record<string, unknown>).output as string));
  const log = reservedLog ?? logStore.create(quota);
  log.append('stdout', Buffer.from(full.text, 'utf8'));
  if (stderr) log.append('stderr', captureBytes(stderr));
  const metadata = log.finish(!full.truncated && !stderr?.truncated);
  return { display: displayCapture(full, displayLimit, tail), log: metadata };
}

export function displayCapture(full: StreamCapture, displayLimit: number, tail: boolean): StreamCapture {
  const collector = new OutputCollector(displayLimit, tail);
  collector.append(captureBytes(full));
  const display = collector.snapshot();
  display.observedBytes = full.observedBytes;
  display.omittedBytes = full.observedBytes - display.capturedBytes;
  display.truncated = display.omittedBytes > 0;
  return display;
}

export function payloadLimit(displayLimit: number, logOutput?: boolean, quota?: number) {
  return logOutput ? Math.max(displayLimit, quota ?? 8_388_608) : displayLimit;
}

/** Finite bound for base64 of worst-case JSON escaped payload plus metadata. */
export function frameLimit(payloadBytes: number) {
  return Math.ceil((payloadBytes * 6 + 65536) / 3) * 4 + 128;
}

export function captureFromEnvelope(body: Record<string, unknown>, text: string): StreamCapture {
  const observedBytes = body.observedBytes, capturedBytes = body.capturedBytes;
  if (!Number.isSafeInteger(observedBytes) || !Number.isSafeInteger(capturedBytes) ||
      (observedBytes as number) < 0 || (capturedBytes as number) < 0 ||
      (capturedBytes as number) > (observedBytes as number) ||
      (body.omittedBytes !== (observedBytes as number) - (capturedBytes as number)) ||
      body.truncated !== ((observedBytes as number) > (capturedBytes as number)) ||
      Buffer.byteLength(text, "utf8") !== capturedBytes) throw Error("Invalid output accounting");
  return { text, observedBytes: observedBytes as number, capturedBytes: capturedBytes as number,
    omittedBytes: body.omittedBytes as number, truncated: body.truncated as boolean };
}
