/**
 * M2 CONTRACT — deterministic helpers. These are part of the contract: every member MUST use these
 * (copy verbatim into shared-types) so ids, cursors and checksums are identical everywhere.
 *
 */
import { createHash } from 'node:crypto';
import type { Detection, HazardEvent, HazardSource } from './types.js';

const sha256hex = (s: string | Uint8Array): string => createHash('sha256').update(s).digest('hex');

/** C-ID. Ring key AND public id. Same (source, source_ref_id) → same id, forever. */
export function hazardId(source: HazardSource, sourceRefId: string): string {
  return 'hz-' + sha256hex(`${source}|${sourceRefId}`).slice(0, 12);
}

/** Field report id: same reporter + same Idempotency-Key → same report (safe client retry). */
export function reportId(reporterIdentity: string, idempotencyKey: string): string {
  return 'fr-' + sha256hex(`${reporterIdentity}|${idempotencyKey}`).slice(0, 16);
}

/** Parked message id: same bytes from the same source → same record (no double parking). */
export function messageId(source: string, raw: Uint8Array): string {
  const h = createHash('sha256').update(source + '|').update(raw).digest('hex');
  return 'msg-' + h.slice(0, 12);
}

export function outboxMessageId(hazardIdValue: string, version: number): string {
  return `ob-${hazardIdValue}:${version}`;
}

/**
 * Detection key as the feed prints it: satellite|acq_date|acq_time|latitude|longitude.
 * acq_time = integer without padding; lat/lon with EXACTLY 5 decimals.
 * Verified against 58/58 `update` keys and 25/25 `retract` keys of a real capture
 * (fixtures/satellite/feed-capture-sample.json). JS numbers lose trailing zeros, so toFixed(5) is required.
 */
export function detectionKey(d: Pick<Detection, 'satellite' | 'acq_date' | 'acq_time' | 'latitude' | 'longitude'>): string {
  return `${d.satellite}|${d.acq_date}|${d.acq_time}|${d.latitude.toFixed(5)}|${d.longitude.toFixed(5)}`;
}

/** Detection time (FIRE-2): acq_date + acq_time in UTC. */
export function detectionTimeUtc(d: Pick<Detection, 'acq_date' | 'acq_time'>): string {
  const hh = Math.floor(d.acq_time / 100);
  const mm = d.acq_time % 100;
  return `${d.acq_date}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00Z`;
}

/** Stable fire id: smallest detection key (byte order) of the connected set. See contract §3.5. */
export function fireId(detectionKeys: string[]): string {
  if (detectionKeys.length === 0) throw new Error('fireId: empty detection set');
  const min = [...detectionKeys].sort(compareBytes)[0];
  return 'fire-' + sha256hex(min).slice(0, 12);
}

/** Byte-order string comparison (UTF-8), as Lampiran A requires for checksum sorting and tie-breaks. */
export function compareBytes(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/** Total order for listings: ingested_at asc, then hazard_id (byte order). */
export function compareEvents(a: Pick<HazardEvent, 'ingested_at' | 'hazard_id'>, b: Pick<HazardEvent, 'ingested_at' | 'hazard_id'>): number {
  if (a.ingested_at !== b.ingested_at) return a.ingested_at < b.ingested_at ? -1 : 1; // ISO-8601 UTC, fixed width ⇒ lexicographic == chronological
  return compareBytes(a.hazard_id, b.hazard_id);
}

/** Lampiran A checksum: sha256 over source_ref_id values sorted ascending by BYTE order, joined by "\n", no trailing newline. */
export function computeChecksum(sourceRefIds: string[]): string {
  return sha256hex([...sourceRefIds].sort(compareBytes).join('\n'));
}

/* Cursor: opaque to clients, deterministic for us. "after this (ingested_at, hazard_id)". */
export interface CursorPosition { t: string; h: string }
export function encodeCursor(p: CursorPosition): string {
  return Buffer.from(JSON.stringify(p), 'utf8').toString('base64url');
}
export function decodeCursor(c: string): CursorPosition {
  let o: unknown;
  try {
    o = JSON.parse(Buffer.from(c, 'base64url').toString('utf8'));
  } catch {
    throw new Error('invalid cursor');
  }
  const p = o as Partial<CursorPosition>;
  if (typeof p?.t !== 'string' || typeof p?.h !== 'string') throw new Error('invalid cursor');
  return { t: p.t, h: p.h };
}

/** ISO-8601 UTC with fixed millisecond width, so string comparison == time comparison. */
export function isoMs(d: Date | number): string {
  return new Date(d).toISOString(); // always YYYY-MM-DDTHH:mm:ss.sssZ
}

/** C-TIME: next ingested_at for a source. Never goes backwards across leaders or a skewed clock. */
export function nextIngestedAt(nowMs: number, floorIso: string | null): string {
  const floor = floorIso ? Date.parse(floorIso) : -Infinity;
  return isoMs(Math.max(nowMs, floor + 1));
}

/** Dashboard category (contract §3.3). Mutually exclusive; sums to the Audit total. */
export function dashboardCategory(e: Pick<HazardEvent, 'hazard_type' | 'attributes'>): 'gempa' | 'tsunami' | 'gunung_berapi' | 'kebakaran_hutan' | 'pesisir' {
  switch (e.hazard_type) {
    case 'SEISMIC': return e.attributes?.potential_tsunami === true ? 'tsunami' : 'gempa';
    case 'VOLCANIC': return 'gunung_berapi';
    case 'WILDFIRE': return 'kebakaran_hutan';
    case 'COASTAL': return 'pesisir';
  }
}
