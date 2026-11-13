import type { GuardLimits, GuardResult } from '../../../../shared-types/src/m2/types';

export const DEFAULT_LIMITS: GuardLimits = { maxBytes: 262_144, maxDepth: 32 };

// Never throws. Order is fixed (CONTRACT-MEMBER-1 A1): size, strict UTF-8, depth, JSON.parse.
// A leading UTF-8 BOM is stripped rather than parked (RFC 8259 §8.1).
export function guardBytes(raw: Uint8Array, limits: Partial<GuardLimits> = {}): GuardResult {
  try {
    const { maxBytes, maxDepth } = { ...DEFAULT_LIMITS, ...limits };
    if (raw.byteLength > maxBytes) return { ok: false, reason_code: 'PAYLOAD_TOO_LARGE', detail: `${raw.byteLength} bytes > ${maxBytes}` };
    let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(raw); } // default ignoreBOM=false strips a leading BOM
    catch { return { ok: false, reason_code: 'INVALID_UTF8', detail: 'not valid UTF-8' }; }
    let depth = 0, inStr = false, esc = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text.charCodeAt(i);
      if (inStr) { if (esc) esc = false; else if (ch === 0x5c) esc = true; else if (ch === 0x22) inStr = false; continue; }
      if (ch === 0x22) inStr = true;
      else if (ch === 0x7b || ch === 0x5b) { depth++; if (depth > maxDepth) return { ok: false, reason_code: 'NESTING_TOO_DEEP', detail: `depth > ${maxDepth}` }; }
      else if (ch === 0x7d || ch === 0x5d) depth--;
    }
    try { return { ok: true, json: JSON.parse(text) }; }
    catch (e) { return { ok: false, reason_code: 'MALFORMED_JSON', detail: (e as Error).message.slice(0, 200) }; }
  } catch (e) {
    // defence in depth: guard must never throw, whatever the input
    return { ok: false, reason_code: 'MALFORMED_JSON', detail: `guard failure: ${(e as Error).message}`.slice(0, 200) };
  }
}

// HTTP variant: size first, then rejects a declared non-JSON content type.
export function guardHttpBody(raw: Uint8Array, contentType: string | null | undefined, limits: Partial<GuardLimits> = {}): GuardResult {
  const { maxBytes } = { ...DEFAULT_LIMITS, ...limits };
  if (raw.byteLength > maxBytes) return guardBytes(raw, limits);
  if (contentType && !/^application\/([a-z0-9.+-]+\+)?json\s*(;|$)/i.test(contentType.trim())) {
    return { ok: false, reason_code: 'MALFORMED_JSON', detail: `unexpected content-type: ${contentType.slice(0, 80)}` };
  }
  return guardBytes(raw, limits);
}
