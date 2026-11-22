// Pulls the Prometheus rule file and every dashboard PromQL expression out of deploy/k8s/observability/*.yaml so a local Prometheus can run the SAME rules and queries.
// usage: node scripts/demo/obs-extract.mjs <outDir>   ->  <outDir>/slo_rules.yml, <outDir>/exprs.json  [{dashboard, panel, expr}]
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const out = process.argv[2];
mkdirSync(out, { recursive: true });
const dir = join(import.meta.dirname, '../../deploy/k8s/observability');
const prom = readFileSync(join(dir, 'prometheus.yaml'), 'utf8');
const start = prom.indexOf('slo_rules.yml: |');
const body = prom.slice(prom.indexOf('\n', start) + 1, prom.indexOf('\n---', start));
writeFileSync(join(out, 'slo_rules.yml'), body.split('\n').map((l) => l.replace(/^ {4}/, '')).join('\n') + '\n');

const dash = readFileSync(join(dir, 'dashboards-configmap.yaml'), 'utf8');
const exprs = [];
for (const m of dash.matchAll(/^ {2}([\w-]+\.json): \|\n([\s\S]*?)(?=^ {2}[\w-]+\.json: \||(?![\s\S]))/gm)) {
  const json = JSON.parse(m[2].split('\n').map((l) => l.replace(/^ {4}/, '')).join('\n'));
  for (const p of json.panels ?? []) for (const t of p.targets ?? []) exprs.push({ dashboard: json.title, panel: p.title, expr: t.expr });
}
writeFileSync(join(out, 'exprs.json'), JSON.stringify(exprs, null, 1));
process.stdout.write(`${exprs.length} dashboard expressions, rules file ${body.split('\n').length} lines\n`);
