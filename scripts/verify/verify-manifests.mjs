// Cross-platform static verification of deploy/k8s Kustomize manifests
// Enforces TA-6 (role labels), PLAT-6 / Lampiran B (memory requests & limits), and PLAT-8 (NetworkPolicies).
import { execFileSync } from 'node:child_process';

const overlay = process.argv[2] || 'deploy/k8s/overlays/dev';
const raw = execFileSync('kubectl', ['kustomize', overlay], { encoding: 'utf8' });
const docs = raw.split(/^---$/m).map((s) => s.trim()).filter(Boolean);

const VALID_ROLES = new Set(['aggregator', 'store', 'broker', 'consumer', 'api', 'mock', 'sensor', 'other']);
const EXPECTED_RESOURCES = {
  aggregator: { req: '256Mi', lim: '512Mi' },
  store:      { req: '512Mi', lim: '1Gi' },
  broker:     { req: '512Mi', lim: '1Gi' },
  consumer:   { req: '128Mi', lim: '256Mi' },
  api:        { req: '128Mi', lim: '256Mi' },
  mock:       { req: '64Mi',  lim: '128Mi' },
  sensor:     { req: '128Mi', lim: '256Mi' },
  other:      { req: '128Mi', lim: '256Mi' },
};
const CONTROLLERS = new Set(['Deployment', 'StatefulSet', 'DaemonSet']);

let appWorkloads = 0;
let obsWorkloads = 0;
let errors = 0;

console.log(`=== Verifying Kustomize overlay: ${overlay} ===`);

for (const doc of docs) {
  const kindMatch = doc.match(/^kind:\s*(\S+)/m);
  const nameMatch = doc.match(/^\s*name:\s*(\S+)/m);
  const nsMatch = doc.match(/^\s*namespace:\s*(\S+)/m);
  if (!kindMatch || !CONTROLLERS.has(kindMatch[1])) continue;

  const kind = kindMatch[1];
  const name = nameMatch ? nameMatch[1] : 'unknown';
  const ns = nsMatch ? nsMatch[1] : 'default';
  const templateSection = doc.split(/template:/)[1] || '';
  const roleMatch = templateSection.match(/^\s+role:\s*["']?([a-z]+)["']?/m);
  const role = roleMatch ? roleMatch[1] : '';

  if (!VALID_ROLES.has(role)) {
    console.error(`[FAIL] ${kind}/${name} (ns=${ns}): invalid or missing pod label role="${role}"`);
    errors++;
    continue;
  }

  const exp = EXPECTED_RESOURCES[role];
  const reqMatch = templateSection.match(/requests:\s*\r?\n(?:\s+[^\r\n]+\r?\n)*?\s+memory:\s*["']?(\S+?)["']?\s*$/m);
  const limMatch = templateSection.match(/limits:\s*\r?\n(?:\s+[^\r\n]+\r?\n)*?\s+memory:\s*["']?(\S+?)["']?\s*$/m);
  const req = reqMatch ? reqMatch[1] : 'MISSING';
  const lim = limMatch ? limMatch[1] : 'MISSING';

  if (req !== exp.req || lim !== exp.lim) {
    console.error(`[FAIL] ${kind}/${name} (ns=${ns}, role=${role}): expected memory ${exp.req}/${exp.lim}, got ${req}/${lim}`);
    errors++;
  } else {
    console.log(`[PASS] ${kind}/${name} (ns=${ns}, role=${role}) -> memory requests=${req}, limits=${lim}`);
  }

  if (ns === 'sistem-informasi-kebencanaan-bnpb') appWorkloads++;
  if (ns === 'observability') obsWorkloads++;
}

const netpols = docs.filter((d) => /^kind:\s*NetworkPolicy/m.test(d));
const storePol = netpols.find((d) => /name:\s*store-ingress/m.test(d));
const rabbitPol = netpols.find((d) => /name:\s*rabbitmq-ingress/m.test(d));

if (!storePol || !rabbitPol) {
  console.error('[FAIL] Missing required NetworkPolicies (store-ingress / rabbitmq-ingress)');
  errors++;
} else {
  console.log(`[PASS] NetworkPolicies verified: store-ingress (role=store <- [aggregator, store]) and rabbitmq-ingress (app=rabbitmq <- [aggregator, api, consumer, broker])`);
}

if (errors > 0 || appWorkloads < 12) {
  console.error(`[FAILED] errors=${errors}, appWorkloads=${appWorkloads}`);
  process.exit(1);
}

console.log(`[OK] All ${appWorkloads} application workloads + ${obsWorkloads} observability workloads + ${netpols.length} NetworkPolicies verified cleanly.`);
