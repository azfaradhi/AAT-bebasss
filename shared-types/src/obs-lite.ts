import { METRICS } from './m2/types';

// Stand-in for the platform obs-kit: any service exposing /metrics with these exact names satisfies the contract.
const BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

interface Series { counts: number[]; sum: number; count: number }
interface MinimalApp {
  addHook(name: 'onResponse', fn: (request: any, reply: any) => Promise<void>): unknown; // eslint-disable-line @typescript-eslint/no-explicit-any
}

export class HttpMetrics {
  private readonly series = new Map<string, Series>();

  constructor(private readonly service: string) {}

  observe(route: string, method: string, status: number, seconds: number): void {
    const key = [route, method, `${Math.floor(status / 100)}xx`].join('|');
    let s = this.series.get(key);
    if (!s) { s = { counts: BUCKETS.map(() => 0), sum: 0, count: 0 }; this.series.set(key, s); }
    BUCKETS.forEach((le, i) => { if (seconds <= le) s!.counts[i]++; });
    s.sum += seconds;
    s.count++;
  }

  render(): string {
    const name = METRICS.httpServerDuration;
    const lines = [`# TYPE ${name} histogram`];
    for (const [key, s] of this.series) {
      const [route, method, statusClass] = key.split('|');
      const labels = `service="${this.service}",route="${route}",method="${method}",status_class="${statusClass}"`;
      BUCKETS.forEach((le, i) => lines.push(`${name}_bucket{${labels},le="${le}"} ${s.counts[i]}`));
      lines.push(`${name}_bucket{${labels},le="+Inf"} ${s.count}`, `${name}_sum{${labels}} ${s.sum}`, `${name}_count{${labels}} ${s.count}`);
    }
    return `${lines.join('\n')}\n`;
  }
}

// RED metrics for a Fastify app: one histogram observation per response, labelled with the route pattern (bounded cardinality).
export function registerHttpMetrics(app: MinimalApp, service: string): HttpMetrics {
  const metrics = new HttpMetrics(service);
  app.addHook('onResponse', async (request, reply) => {
    metrics.observe(request.routeOptions?.url ?? 'unmatched', request.method, reply.statusCode, reply.elapsedTime / 1000);
  });
  return metrics;
}

// Contract log shape: ts, level, service, instance, node (plus correlation_id / trace_id added by the caller's mixin).
export function loggerOptions(service: string, env: NodeJS.ProcessEnv = process.env) {
  return {
    base: { service, instance: env.POD_NAME ?? env.HOSTNAME ?? 'local', node: env.NODE_NAME ?? 'local' },
    timestamp: () => `,"ts":"${new Date().toISOString()}"`,
    formatters: { level: (label: string) => ({ level: label }) },
  };
}
