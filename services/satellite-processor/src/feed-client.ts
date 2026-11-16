import { SseParser, type RawFrame } from './sse-parser';

export class FeedHttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'FeedHttpError';
  }
  // 400/401/403 will not fix themselves: alert and slow down instead of hammering.
  get permanent(): boolean {
    return this.status === 400 || this.status === 401 || this.status === 403;
  }
}

export interface FeedClientOptions {
  baseUrl: string;
  token: string;
  idleTimeoutMs: number;
  fetchImpl?: typeof fetch;
}

// One stream connection. Resume rule: always `from = lastOffset + 1` (inclusive), never Last-Event-ID, so there is one off-by-one to test.
export class FeedClient {
  constructor(private readonly opts: FeedClientOptions) {}

  private get fetcher(): typeof fetch {
    return this.opts.fetchImpl ?? fetch;
  }

  private headers(): Record<string, string> {
    return { authorization: `Bearer ${this.opts.token}`, accept: 'text/event-stream' };
  }

  async session(signal?: AbortSignal): Promise<{ latest_offset: number } | null> {
    try {
      const res = await this.fetcher(new URL('/v1/session', this.opts.baseUrl), { headers: this.headers(), signal });
      return res.ok ? ((await res.json()) as { latest_offset: number }) : null;
    } catch {
      return null;
    }
  }

  // Yields frames until the server closes the stream. Throws FeedHttpError on a non-200 and Error('idle timeout') on silence.
  async *stream(from: number, signal: AbortSignal): AsyncGenerator<RawFrame> {
    const url = new URL('/v1/stream', this.opts.baseUrl);
    url.searchParams.set('from', String(from));
    const idle = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => idle.abort(new Error('idle timeout')), this.opts.idleTimeoutMs);
    };
    const combined = AbortSignal.any([signal, idle.signal]);
    arm();
    try {
      const res = await this.fetcher(url, { headers: this.headers(), signal: combined });
      if (!res.ok || !res.body) throw new FeedHttpError(res.status, `feed returned HTTP ${res.status}`);
      const parser = new SseParser();
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        arm();
        for (const frame of parser.push(value)) yield frame;
      }
    } catch (err) {
      if (idle.signal.aborted && !signal.aborted) throw new Error('idle timeout');
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}
