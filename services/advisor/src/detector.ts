import type { FireFacts, Flag, Severity } from './facts';

export interface DetectorOptions {
  windowMs: number;
  zThreshold: number; // modified z-score, Iglewicz and Hoaglin (1993): 3.5
  minGrowth: number; // absolute growth in detections below which a fire is never flagged
  minFires: number; // statistics need a population
  frpFactor: number;
  frpMinDelta: number;
}

interface Sample { t: number; count: number; frp: number; sev: number }
const RANK: Record<Severity, number> = { WASPADA: 0, SIAGA: 1, AWAS: 2 };

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// Robust statistical anomaly detection over what is already published: growth of a fire against the other open fires
// (median / MAD), a severity step up, and a jump in total FRP. Local, deterministic, no network.
export class AnomalyDetector {
  private readonly history = new Map<string, Sample[]>();

  constructor(private readonly o: DetectorOptions) {}

  observe(now: number, fires: FireFacts[]): Flag[] {
    const seen = new Set<string>();
    const growth = new Map<string, number>();
    const reasons = new Map<string, string[]>();

    for (const f of fires) {
      seen.add(f.id);
      const series = this.history.get(f.id) ?? [];
      const base = series.find((s) => s.t >= now - this.o.windowMs) ?? series[0];
      const prev = series[series.length - 1];
      growth.set(f.id, base ? f.count - base.count : 0);
      const why: string[] = [];
      if (prev && RANK[f.severity] > prev.sev) why.push(`tingkat naik ke ${f.severity}`);
      if (base && f.frp >= base.frp * this.o.frpFactor && f.frp - base.frp >= this.o.frpMinDelta) why.push(`total FRP naik dari ${Math.round(base.frp)} ke ${Math.round(f.frp)} MW`);
      reasons.set(f.id, why);
      series.push({ t: now, count: f.count, frp: f.frp, sev: RANK[f.severity] });
      this.history.set(f.id, series.filter((s) => s.t >= now - this.o.windowMs * 2));
    }
    for (const id of [...this.history.keys()]) if (!seen.has(id)) this.history.delete(id);

    const values = [...growth.values()];
    const med = median(values);
    const mad = median(values.map((v) => Math.abs(v - med)));
    const flags: Flag[] = [];
    for (const f of fires) {
      const g = growth.get(f.id) ?? 0;
      const why = [...(reasons.get(f.id) ?? [])];
      let score = 0;
      if (values.length >= this.o.minFires && g >= this.o.minGrowth) {
        const z = mad > 0 ? (0.6745 * (g - med)) / mad : g > med ? this.o.zThreshold : 0;
        if (z >= this.o.zThreshold) { score = z; why.unshift(`pertumbuhan ${g} titik panas dalam jendela waktu, jauh di atas kebakaran lain`); }
      }
      if (why.length > 0) flags.push({ id: f.id, score: score || this.o.zThreshold, reasons: why, growth: g });
    }
    return flags.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));
  }
}
