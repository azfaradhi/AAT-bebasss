import { readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { KubeConflictError, type KubeApi, type KubeConfigMap, type KubeLease } from './kube-api';

export interface HttpKubeOptions {
  baseUrl: string;
  namespace: string;
  token?: string;
  ca?: string;
  leaseDurationSeconds?: number;
  timeoutMs?: number;
}

const micro = (): string => new Date().toISOString().replace(/\.(\d{3})Z$/, '.$1000Z');

// Minimal Kubernetes REST client (Lease and ConfigMap only), using the pod's service account when run in a cluster.
export class HttpKubeApi implements KubeApi {
  constructor(private readonly o: HttpKubeOptions) {}

  static inCluster(env: NodeJS.ProcessEnv = process.env): HttpKubeApi {
    const dir = '/var/run/secrets/kubernetes.io/serviceaccount';
    return new HttpKubeApi({
      baseUrl: `https://${env.KUBERNETES_SERVICE_HOST}:${env.KUBERNETES_SERVICE_PORT ?? '443'}`,
      namespace: env.LEASE_NAMESPACE ?? readFileSync(`${dir}/namespace`, 'utf8').trim(),
      token: readFileSync(`${dir}/token`, 'utf8').trim(),
      ca: readFileSync(`${dir}/ca.crt`, 'utf8'),
      leaseDurationSeconds: Number(env.LEASE_DURATION_SECONDS ?? 10),
    });
  }

  private request(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
    const url = new URL(path, this.o.baseUrl);
    const lib = url.protocol === 'https:' ? https : http;
    return new Promise((resolve, reject) => {
      const req = lib.request(url, {
        method,
        ca: this.o.ca,
        timeout: this.o.timeoutMs ?? 5000,
        headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}), ...(this.o.token ? { authorization: `Bearer ${this.o.token}` } : {}) },
      }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json: unknown = null;
          try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON error body */ }
          resolve({ status: res.statusCode ?? 0, json });
        });
      });
      req.on('timeout', () => req.destroy(new Error('kube request timed out')));
      req.on('error', reject);
      if (body) req.write(JSON.stringify(body));
      req.end();
    });
  }

  private leasePath(name?: string): string { return `/apis/coordination.k8s.io/v1/namespaces/${this.o.namespace}/leases${name ? `/${name}` : ''}`; }
  private cmPath(name?: string): string { return `/api/v1/namespaces/${this.o.namespace}/configmaps${name ? `/${name}` : ''}`; }
  private toLease(j: any): KubeLease {
    return { name: j.metadata.name, resourceVersion: j.metadata.resourceVersion, holder: j.spec?.holderIdentity ?? null, transitions: j.spec?.leaseTransitions ?? 0 };
  }
  private leaseBody(name: string, holder: string | null, transitions: number, resourceVersion?: string) {
    return {
      apiVersion: 'coordination.k8s.io/v1', kind: 'Lease',
      metadata: { name, ...(resourceVersion ? { resourceVersion } : {}) },
      spec: { holderIdentity: holder, leaseDurationSeconds: this.o.leaseDurationSeconds ?? 10, leaseTransitions: transitions, acquireTime: micro(), renewTime: micro() },
    };
  }
  private check(r: { status: number; json: any }, what: string): any {
    if (r.status === 409) throw new KubeConflictError(what);
    if (r.status < 200 || r.status >= 300) throw new Error(`kube ${what} failed with HTTP ${r.status}`);
    return r.json;
  }

  async getLease(name: string): Promise<KubeLease | null> {
    const r = await this.request('GET', this.leasePath(name));
    return r.status === 404 ? null : this.toLease(this.check(r, `get lease ${name}`));
  }
  async createLease(name: string, holder: string): Promise<KubeLease> {
    return this.toLease(this.check(await this.request('POST', this.leasePath(), this.leaseBody(name, holder, 1)), `create lease ${name}`));
  }
  async updateLease(name: string, resourceVersion: string, holder: string | null, transitions: number): Promise<KubeLease> {
    return this.toLease(this.check(await this.request('PUT', this.leasePath(name), this.leaseBody(name, holder, transitions, resourceVersion)), `update lease ${name}`));
  }
  async getConfigMap(name: string): Promise<KubeConfigMap | null> {
    const r = await this.request('GET', this.cmPath(name));
    if (r.status === 404) return null;
    const j = this.check(r, `get configmap ${name}`);
    return { name, resourceVersion: j.metadata.resourceVersion, data: j.data ?? {} };
  }
  async createConfigMap(name: string, data: Record<string, string>): Promise<KubeConfigMap> {
    const j = this.check(await this.request('POST', this.cmPath(), { apiVersion: 'v1', kind: 'ConfigMap', metadata: { name }, data }), `create configmap ${name}`);
    return { name, resourceVersion: j.metadata.resourceVersion, data: j.data ?? {} };
  }
  async updateConfigMap(name: string, resourceVersion: string, data: Record<string, string>): Promise<KubeConfigMap> {
    const j = this.check(await this.request('PUT', this.cmPath(name), { apiVersion: 'v1', kind: 'ConfigMap', metadata: { name, resourceVersion }, data }), `update configmap ${name}`);
    return { name, resourceVersion: j.metadata.resourceVersion, data: j.data ?? {} };
  }
}
