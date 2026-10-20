import type { StreamCapture } from "./output-collector.js";

/** JSON escape expansion followed by base64 at the 8 MiB public cap. */
export const FRAME_OUTPUT_LIMIT = 70_000_000;

/** Inserted into trusted PowerShell bootstrap, never caller source. */
export const LIMIT_BOOTSTRAP = `
function LimitOutput([string]$text) {
  $bytes = [Text.Encoding]::UTF8.GetBytes($text)
  $limit = [Math]::Max(0, [Math]::Min(8388608, [int]$payloadLimit))
  if ($bytes.Length -le $limit) { return @{ output=$text; observedBytes=$bytes.Length; capturedBytes=$bytes.Length; omittedBytes=0; truncated=$false } }
  if ($payloadTail) { $start = $bytes.Length - $limit; $length = $limit } else { $start = 0; $length = $limit }
  $decoder = New-Object Text.UTF8Encoding($false, $true)
  while ($length -gt 0) {
    try { $retained = $decoder.GetString($bytes, $start, $length); break }
    catch [Text.DecoderFallbackException] {
      if ($payloadTail) { $start++; $length-- } else { $length-- }
    }
  }
  if ($length -eq 0) { $retained = '' }
  return @{ output=$retained; observedBytes=$bytes.Length; capturedBytes=$length; omittedBytes=($bytes.Length - $length); truncated=$true }
}
`;

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
