export type Severity = 'WASPADA' | 'SIAGA' | 'AWAS';

// What the advisor knows about one fire, taken from its published event.
export interface FireFacts {
  id: string;
  province: string;
  count: number;
  satellites: string[];
  frp: number;
  severity: Severity;
  earliest: string;
}

export interface Flag {
  id: string;
  score: number;
  reasons: string[];
  growth: number;
}

export const LABEL = 'ADVISORY: automated, not an official assessment';

const fmt = (n: number) => String(Math.round(n * 100) / 100);

// Deterministic summary used whenever the LLM is absent, slow, failing or rejected.
export function templateSummary(f: FireFacts, flag: Flag): string {
  const why = flag.reasons.length > 0 ? ` Ditandai karena ${flag.reasons.join('; ')}.` : '';
  return `Kebakaran di ${f.province}: ${f.count} titik panas dari satelit ${f.satellites.join(', ')}, total FRP ${fmt(f.frp)} MW, tingkat ${f.severity}.${why}`;
}

// The numbers the model is allowed to mention: everything we sent it, in a few spellings.
export function allowedNumbers(f: FireFacts, flag: Flag): Set<string> {
  const out = new Set<string>();
  const add = (n: number) => {
    for (const s of [String(n), fmt(n), fmt(n).replace('.', ','), String(Math.round(n))]) out.add(s);
  };
  add(f.count);
  add(f.frp);
  add(flag.growth);
  for (const r of flag.reasons) for (const m of r.match(/\d+(?:[.,]\d+)?/g) ?? []) out.add(m);
  for (const s of f.satellites) for (const m of s.match(/\d+/g) ?? []) out.add(m);
  for (const m of f.earliest.match(/\d+(?:[.,]\d+)?/g) ?? []) out.add(m); // exactly as the timestamp is written
  for (const m of f.earliest.match(/\d+/g) ?? []) { out.add(m); out.add(String(Number(m))); } // a date or time may be written as 05:30 or 5:30
  return out;
}

export type Verdict = { ok: true; text: string } | { ok: false; why: string };

// The model's answer is data from outside: it is only used if it stays within what we told it.
export function validateSummary(raw: unknown, f: FireFacts, flag: Flag): Verdict {
  if (typeof raw !== 'string') return { ok: false, why: 'not text' };
  const text = raw.trim().replace(/^["“]|["”]$/g, '');
  if (text.length < 20 || text.length > 300) return { ok: false, why: 'length' };
  if (/[\r\n]/.test(text)) return { ok: false, why: 'multiple lines' };
  if (/https?:|www\.|[*#`\[\]<>]/.test(text)) return { ok: false, why: 'markup or link' };
  if (!text.toLowerCase().includes(f.province.toLowerCase())) return { ok: false, why: 'province missing' };
  const allowed = allowedNumbers(f, flag);
  for (const n of text.match(/\d+(?:[.,]\d+)?/g) ?? []) if (!allowed.has(n) && !allowed.has(n.replace(',', '.'))) return { ok: false, why: `unknown number ${n}` };
  return { ok: true, text };
}
