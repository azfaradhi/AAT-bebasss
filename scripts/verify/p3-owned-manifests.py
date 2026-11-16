#!/usr/bin/env python3
"""Checks the manifests of the components owned by Member 1 against the deploy contract:
role label on every pod, Lampiran B memory requests/limits on every container, probes, no literal secret values.
Stand-in for `make verify-labels verify-resources` until the platform Makefile exists."""
import subprocess, sys, yaml

COMPONENTS = ['bmkg-mock', 'pvmbg-mock', 'satellite-processor', 'field-report-processor']
ROLES = {'aggregator': ('256Mi', '512Mi'), 'store': ('512Mi', '1Gi'), 'broker': ('512Mi', '1Gi'), 'consumer': ('128Mi', '256Mi'),
         'api': ('128Mi', '256Mi'), 'mock': ('64Mi', '128Mi'), 'other': ('128Mi', '256Mi'), 'sensor': ('128Mi', '256Mi')}
EXPECTED_ROLE = {'bmkg-mock': 'mock', 'pvmbg-mock': 'mock', 'satellite-processor': 'broker', 'field-report-processor': 'consumer'}
SECRETISH = ('SECRET', 'TOKEN', 'KEY', 'PASSWORD')

fails = 0
def check(ok, text):
    global fails
    print(('PASS  ' if ok else 'FAIL  ') + text)
    if not ok: fails += 1

for comp in COMPONENTS:
    out = subprocess.run(['kubectl', 'kustomize', f'deploy/k8s/{comp}'], capture_output=True, text=True)
    if out.returncode != 0:
        check(False, f'{comp}: kustomize failed: {out.stderr.strip()[:120]}'); continue
    docs = [d for d in yaml.safe_load_all(out.stdout) if d]
    for d in docs:
        if d['kind'] != 'Deployment': continue
        tpl = d['spec']['template']
        role = tpl['metadata']['labels'].get('role')
        check(role == EXPECTED_ROLE[comp] and role in ROLES, f'{comp}: pod label role={role}')
        check(d['metadata']['labels'].get('role') == role, f'{comp}: deployment label matches pod role')
        for c in tpl['spec']['containers'] + tpl['spec'].get('initContainers', []):
            req = c.get('resources', {}).get('requests', {}).get('memory')
            lim = c.get('resources', {}).get('limits', {}).get('memory')
            check((req, lim) == ROLES[role], f"{comp}/{c['name']}: memory {req}/{lim} (Lampiran B {role}: {'/'.join(ROLES[role])})")
            for p in ('startupProbe', 'readinessProbe', 'livenessProbe'):
                check(p in c, f"{comp}/{c['name']}: {p}")
            for e in c.get('env', []):
                if any(s in e['name'] for s in SECRETISH):
                    check('valueFrom' in e and 'value' not in e, f"{comp}/{c['name']}: {e['name']} comes from a Secret, no literal value")
            check('ports' in c, f"{comp}/{c['name']}: containerPort declared")
    check(any(d['kind'] == 'ConfigMap' for d in docs), f'{comp}: ConfigMap present')
print('\nPASS: all checks' if fails == 0 else f'\nFAIL: {fails} check(s)')
sys.exit(1 if fails else 0)
