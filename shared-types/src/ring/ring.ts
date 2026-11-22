import { createHash } from 'node:crypto';

// Consistent-hash ring with virtual nodes; replicas are the next `rf` distinct units clockwise (preferring distinct physical/VM nodes first).
export class Ring {
  private points: Array<{ pos: number; unit: string }> = [];
  private readonly nodeOf: (unit: string) => string;

  constructor(readonly units: string[], readonly rf: number, vnodes = 64, nodeOf?: (unit: string) => string) {
    this.nodeOf = nodeOf ?? ((u) => u);
    for (const unit of units) for (let i = 0; i < vnodes; i++) this.points.push({ pos: hash32(`${unit}#${i}`), unit });
    this.points.sort((a, b) => a.pos - b.pos);
  }

  replicas(key: string): string[] {
    return this.walk(this.firstIndex(hash32(key)));
  }

  // Every distinct replica set the ring can produce; used to decide whether some key could be unreachable.
  replicaSets(): string[][] {
    const seen = new Map<string, string[]>();
    for (let i = 0; i < this.points.length; i++) {
      const set = this.walk(i);
      seen.set([...set].sort().join('|'), set);
    }
    return [...seen.values()];
  }

  private firstIndex(pos: number): number {
    let lo = 0, hi = this.points.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.points[mid].pos < pos) lo = mid + 1; else hi = mid;
    }
    return lo % this.points.length;
  }

  private walk(start: number): string[] {
    const out: string[] = [];
    const seenNodes = new Set<string>();
    const want = Math.min(this.rf, this.units.length);
    // First pass: place replicas on distinct nodes (P1-K4: every unit's replica must reside on a different node from its primary)
    for (let i = 0; out.length < want && i < this.points.length; i++) {
      const unit = this.points[(start + i) % this.points.length].unit;
      const node = this.nodeOf(unit);
      if (!out.includes(unit) && !seenNodes.has(node)) {
        out.push(unit);
        seenNodes.add(node);
      }
    }
    // Fallback when total distinct nodes < rf
    for (let i = 0; out.length < want && i < this.points.length; i++) {
      const unit = this.points[(start + i) % this.points.length].unit;
      if (!out.includes(unit)) out.push(unit);
    }
    return out;
  }
}

function hash32(s: string): number {
  return createHash('sha256').update(s).digest().readUInt32BE(0);
}
