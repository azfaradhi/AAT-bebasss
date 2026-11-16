export type FrameKind = 'detection' | 'update' | 'retract' | 'heartbeat';

export interface SatFrame {
  offset: number;
  kind: FrameKind;
  data: Record<string, unknown>;
}

export interface SinkContext {
  fence: number;
  signal: AbortSignal;
}

// Consumer of validated frames (the fire pipeline). apply() must be idempotent: after a crash the same frames are re-delivered.
export interface FrameSink {
  apply(batch: SatFrame[], ctx: SinkContext): Promise<void>;
}

export class CollectingSink implements FrameSink {
  readonly frames: SatFrame[] = [];
  async apply(batch: SatFrame[]): Promise<void> {
    this.frames.push(...batch);
  }
}
