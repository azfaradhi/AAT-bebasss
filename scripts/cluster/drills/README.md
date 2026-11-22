# Cluster drills (k3s)

One script per spec criterion, run **against the live cluster** with `kubectl` and plain Node (>= 18, no dependencies). Each writes an evidence file
`evidence/<criterion>/<date>_<name>.txt` (header: date, nodes, code commit) with `[PASS]/[FAIL]` lines and a final `RESULT:`; commit that file and add a row to `evidence/INDEX.md`.
They reproduce, on the cluster, the scenarios that were already proven on local processes (`scripts/demo/*.ts`).

Prerequisites: `kubectl` pointing at the cluster, the app deployed (`make up`), the Tester Agent installed, `node` on PATH. The drills read credentials from the cluster Secret `bnpb-secrets`
(never printed) and create temporary `NodePort` Services named `<deployment>-drill`, deleted at exit. `NODE_IP` can be set when the first node's InternalIP is not reachable from the machine running the drill.
Run from the `AAT-bebasss` directory, e.g. `node scripts/cluster/drills/p1-node-loss.mjs`.

| Script | Criteria | What it does | Notes |
|---|---|---|---|
| `p1-node-loss.mjs` | P1-K1, K4, K5, K6 | baseline checksums + primary/replica placement, Tester `wipe-node`, continuous reader+writer, waits for ring recovery, compares checksums, optional second loss (`SECOND=1`) | `wipe-node` powers the VM off: start it by hand; mocks are scaled to 0 during the drill (`FREEZE=0` to keep them) |
| `p2-routing.mjs` | P2-K1 | 20 req/s to the aggregator Service while one pod is deleted; counts failures | |
| `p2-lease-failover.mjs` | P2-K1, K2, K3 | pods per node, one upstream caller (mock request log), kills the Lease holder, takeover time, no duplicate | `LEASE=bmkg` (or `pvmbg`) |
| `p2-clock-skew.mjs` | P2-K4 | Tester `clock-skew`; one holder at any instant, no lease flip-flop, no duplicate | |
| `p3-schema-replay.mjs` | P3-K1, K2, K4, K5 | PVMBG mock `rename`, parked records, ops-only routes, `VOLCANIC_MAPPER_VERSION=v2` + replay, no duplicates, second replay no-op | sets an env var on the aggregator Deployment and rolls it |
| `p3-field-reports.mjs` | P3-K6 | 150 reports + 20 retries, kills the processor and a client-api pod, 202 p95, accepted == processed | |
| `p4-satellite-leader.mjs` | P4-K5, K8 | scales satellite-processor to 2, kills the Lease holder, events keep arriving, no duplicate, no 429 on the standby | |
| `p5-sensor-outage.mjs` | P5-K3, K4 | sensor scaled to 0 for 90 s: client read latency, other sources, breaker, recovery | |
| `p5-priority-shed.mjs` | P5-K5 | 150 media vs 10 lapangan clients: lapangan served, media 429 | |

Not automated (do by hand and photograph/log): VM suspend/resume for P2-K5 (spec TA-8), Grafana dashboard and a trace across services (OBS-1/2, P5-K7), browser screenshots of the analytics dashboard (P1-K7), the real sensor behaviours B1-B8.
