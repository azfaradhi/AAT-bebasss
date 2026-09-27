// Phase 1 boundary only: this is replaced by authenticated BMKG/PVMBG clients in Phase 2.
export interface PollingSource {
  readonly name: string;
  poll(): Promise<unknown>;
}

export function createStubSourceClient(name: string): PollingSource {
  return {
    name,
    async poll(): Promise<{ source: string; records: unknown[]; received_at: string }> {
      // This is deliberately replaceable by an authenticated BMKG/PVMBG HTTP client in Phase 2.
      return { source: name, records: [], received_at: new Date().toISOString() };
    },
  };
}
