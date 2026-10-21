import { z } from "zod";

export const INPUT_LIMIT = 1_048_576;
export const typedParameters = z.record(z.string().regex(/^[a-zA-Z_][a-zA-Z_0-9]*$/), z.unknown()).optional();

export function validateParameters(value: unknown): asserts value is Record<string, unknown> {
  function visit(v: unknown, depth: number): void {
    if (depth > 8) throw Error("parameter depth limit exceeded");
    if (v === null || typeof v === "string" || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v))) return;
    if (Array.isArray(v)) { for (const item of v) visit(item, depth + 1); return; }
    if (typeof v === "object" && v && Object.getPrototypeOf(v) === Object.prototype) {
      for (const [key, item] of Object.entries(v)) {
        if (key === "__proto__" || key === "constructor" || key === "prototype") throw Error("unsafe parameter key");
        visit(item, depth + 1);
      }
      return;
    }
    throw Error("unsupported parameter value");
  }
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw Error("parameters must be an object");
  for (const key of Object.keys(value)) if (!/^[a-zA-Z_][a-zA-Z_0-9]*$/.test(key)) throw Error("invalid parameter name");
  visit(value, 0);
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > INPUT_LIMIT) throw Error("input limit exceeded");
}

// Convert JSON objects to PowerShell hashtables, preserving nested arrays, scalars and null.
export const PARAMETER_BOOTSTRAP = `function Convert-Parameter($value) {
  if ($null -eq $value) { return $null }
  if ($value -is [System.Array]) {
    $array = [System.Collections.ArrayList]::new()
    foreach ($entry in $value) { [void]$array.Add((Convert-Parameter $entry)) }
    return ,($array.ToArray())
  }
  if ($value -is [pscustomobject]) {
    $table = @{}
    foreach ($property in $value.PSObject.Properties) { $table[$property.Name] = Convert-Parameter $property.Value }
    return $table
  }
  return $value
}`;