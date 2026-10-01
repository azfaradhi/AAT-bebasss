// In-memory dedup set, keyed on hazard_id, bounded so it can't grow forever.
// It does not survive a consumer restart, so a redelivery right after a crash can be applied twice.
export class SeenSet {
  private readonly ids = new Set<string>();

  constructor(private readonly maxSize = 10_000) {}

  has(id: string): boolean {
    return this.ids.has(id);
  }

  add(id: string): void {
    this.ids.add(id);
    if (this.ids.size > this.maxSize) {
      const oldest = this.ids.values().next().value;
      if (oldest !== undefined) this.ids.delete(oldest);
    }
  }
}
