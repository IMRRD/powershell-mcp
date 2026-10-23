/** Fixed producer implementation shared by strict local and remote runspaces.
 * Retention is O(cap), encoding uses fixed scratch space, and no pipeline items
 * or complete formatted transcript are accumulated. User-created objects and
 * PowerShell's own formatter/remoting buffers are outside this bound.
 */
export const PRODUCER_BOOTSTRAP = `
if (-not ('McpBoundedWriter' -as [type])) {
Add-Type -ErrorAction Stop -TypeDefinition @'
using System;
using System.IO;
using System.Text;
using System.Collections;
public sealed class McpBoundedWriter : TextWriter {
  readonly byte[] ring;
  readonly bool tail;
  readonly int limit;
  readonly Encoder encoder = new UTF8Encoding(false).GetEncoder();
  readonly char[] chars = new char[2048];
  readonly byte[] scratch = new byte[8192];
  int size, start;
  long observed;
  public override Encoding Encoding { get { return Encoding.UTF8; } }
  public McpBoundedWriter(int cap, bool keepTail) {
    limit = Math.Max(0, Math.Min(8388608, cap)); tail = keepTail;
    ring = new byte[limit];
  }
  void Retain(int count) {
    observed += count;
    if (limit == 0) return;
    if (!tail) {
      int n = Math.Min(count, limit - size);
      Array.Copy(scratch, 0, ring, size, n); size += n;
    } else {
      int offset = Math.Max(0, count - limit);
      for (int i = offset; i < count; i++) {
        if (size < limit) { ring[(start + size) % limit] = scratch[i]; size++; }
        else { ring[start] = scratch[i]; start = (start + 1) % limit; }
      }
    }
  }
  public override void Write(char value) { Write(new string(value, 1)); }
  public override void Write(string value) {
    if (value == null) return;
    lock (this) {
      for (int p = 0; p < value.Length;) {
        int n = Math.Min(chars.Length, value.Length - p);
        value.CopyTo(p, chars, 0, n); p += n;
        Retain(encoder.GetBytes(chars, 0, n, scratch, 0, false));
      }
    }
  }
  public override void WriteLine(string value) { lock (this) { Write(value); Write(NewLine); } }
  public IDictionary Snapshot() {
    lock (this) {
      Retain(encoder.GetBytes(chars, 0, 0, scratch, 0, true));
      byte[] bytes = new byte[size];
      for (int i = 0; i < size; i++) bytes[i] = ring[(start + i) % limit];
      int offset = 0, count = size;
      if (tail && observed > size) {
        while (count > 0 && (bytes[offset] & 0xc0) == 0x80) { offset++; count--; }
      }
      var utf8 = new UTF8Encoding(false, true);
      string text = "";
      while (count > 0) {
        try { text = utf8.GetString(bytes, offset, count); break; }
        catch (DecoderFallbackException) { count--; }
      }
      return new Hashtable { {"output", text}, {"observedBytes", observed},
        {"capturedBytes", count}, {"omittedBytes", observed - count},
        {"truncated", observed > count} };
    }
  }
}
'@
}
$producer = [McpBoundedWriter]::new([int]$payloadLimit, [bool]$payloadTail)
$errors = New-Object System.Collections.ArrayList
$producerState = @{ limited = $false; failed = $false }

function LimitText($value) {
  $text = [string]$value
  if ($text.Length -gt 256) { $text = $text.Substring(0,256); $producerState.limited = $true }
  return $text
}
function RecordError($entry) {
  $producerState.failed = $true
  if ($errors.Count -ge 8) { $producerState.limited = $true; return }
  if ($entry -is [System.Management.Automation.ErrorRecord]) {
    [void]$errors.Add(@{ category=(LimitText $entry.CategoryInfo.Category); fullyQualifiedErrorId=(LimitText $entry.FullyQualifiedErrorId); exceptionType=(LimitText $entry.Exception.GetType().FullName); message=(LimitText $entry.Exception.Message) })
  } else {
    [void]$errors.Add(@{ category='ParserError'; fullyQualifiedErrorId=(LimitText $entry.ErrorId); exceptionType='ParseError'; message=(LimitText $entry.Message) })
  }
}
`;

// Out-String -Stream retains PowerShell's formatting without collecting the
// entire output. Errors are summarized before entering the formatter.
export const PRODUCER_PIPELINE = `ForEach-Object {
  if ($_ -is [System.Management.Automation.ErrorRecord]) {
    if ($_.FullyQualifiedErrorId -ne 'NativeCommandError' -or -not $nativeErrorsAreDiagnostics) { RecordError $_ }
    [string]$_.Exception.Message
  } else { $_ }
} | Out-String -Stream -Width 240 | ForEach-Object { $producer.WriteLine([string]$_) }`;
