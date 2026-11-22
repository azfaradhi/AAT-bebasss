# Pemetaan kriteria ke kode, pengujian, dan bukti

Berkas bukti ada di `evidence/<problem>/`. "k3s" berarti dijalankan pada cluster tiga VM; "proses nyata" berarti komponen berjalan sebagai proses terpisah dengan ring penyimpanan nyata.

## Problem 1: penyimpanan terdistribusi
| Kriteria | Kode | Pengujian dan skrip | Bukti |
|---|---|---|---|
| K1 muat katalog, unit tanpa seluruh data, sebaran primary/replica per node | `shared-types/src/ring/ring.ts`, `services/aggregator/src/audit/placement-route.ts` | `scripts/demo/p1-placement-e2e.ts`, `scripts/demo/p1-k1-catalogue-loader.ts` | `evidence/P1/K1/` (proses nyata) |
| K2 ketidakmerataan dan beban per node | `shared-types/src/ring/ring.ts` | `scripts/demo/p1-surge-e2e.ts`, `scripts/demo/p1-alternatives-measure.ts` | `evidence/P1/K2/` |
| K3 baca lintas lokasi berpaginasi | `shared-types/src/ring/http-storage-client.ts` | `scripts/demo/p1-k3-x09-e2e.ts` | `evidence/P1/K3/` |
| K4 kehilangan node dan data, tanpa kehilangan event | `services/storage-unit/src/engine.ts`, `shared-types/src/ring/http-storage-client.ts` (`repair`) | `services/storage-unit/src/ring.test.ts`, `scripts/cluster/drills/p1-unit-loss.mjs` | `evidence/P1/K4/` (k3s) |
| K5 unit bergabung tanpa menghentikan lalu lintas | `shared-types/src/ring/http-storage-client.ts` (`addUnits`) | `scripts/demo/p1-join-e2e.ts` | `evidence/P1/K5/` (k3s lulus pada volume kecil) |
| K6 bertahan hilang satu node lagi | `shared-types/src/ring/http-storage-client.ts` (`repair`) | `services/storage-unit/src/ring.test.ts` | `evidence/P1/K6/` (k3s) |
| K7 dasbor analitik sama dengan Audit, penanda data tidak lengkap | `services/analytics-dashboard/src/index.ts`, `services/aggregator/src/analytics/` | `scripts/demo/p1-analytics-e2e.ts` | `evidence/P1/K7/` (k3s) |

## Problem 2: banyak instance dan jam tidak dapat dipercaya
| Kriteria | Kode | Pengujian dan skrip | Bukti |
|---|---|---|---|
| K1 tiga instance, satu titik masuk | `deploy/k8s/aggregator/` | `scripts/demo/p2-k1-k6-k7-k8-e2e.ts`, `scripts/cluster/drills/p2-routing.mjs` | `evidence/P2/K1-K2/` (k3s) |
| K2 tiap sumber tepat sekali | `services/aggregator/src/polling/scheduler.ts`, `services/aggregator/src/coordination/` | `scripts/demo/p2-poller-e2e.ts` | `evidence/P2/K2/` (k3s) |
| K3 failover pengambil | `shared-types/src/coordination/lease-coordinator.ts` | `scripts/demo/p2-failover-e2e.ts`, `scripts/cluster/drills/p2-lease-failover.mjs` | `evidence/P2/K3/` (k3s) |
| K4 pergeseran jam | `shared-types/src/coordination/lease-coordinator.ts` | `scripts/demo/p2-clock-freeze-e2e.ts`, `scripts/cluster/drills/p2-clock-skew.mjs` | `evidence/P2/K4/` (k3s) |
| K5 pembekuan lalu bangun, fencing token | `shared-types/src/coordination/lease-coordinator.ts`, `services/storage-unit/src/engine.ts` | `scripts/demo/p1-p2-cross-x10-x11-x12-e2e.ts` | `evidence/P2/K5/` (k3s) |
| K6--K8 beban, throughput, ganti versi | `services/aggregator/src/app.ts` (`/ready`), `deploy/k8s/aggregator/hpa.yaml` | `load-tests/p2/`, `scripts/demo/p2-k1-k6-k7-k8-e2e.ts` | `evidence/P2/` |

## Problem 3: pesan gagal, perubahan skema, laporan lapangan
| Kriteria | Kode | Pengujian dan skrip | Bukti |
|---|---|---|---|
| K1 deklarasi skema dan perilaku mock | `services/pvmbg-mock/src/app.ts`, `services/aggregator/src/mapping/` | `scripts/demo/p3-k1-schema-policy.sh` | `evidence/P3/K1-K2-K4/` (k3s) |
| K2 pesan gagal tersimpan utuh, retryable atau bukan | `services/aggregator/src/ingest/parker.ts` | `services/aggregator/src/ingest/parker.test.ts` | `evidence/P3/` |
| K3 pesan rusak tidak membuat crash | `services/aggregator/src/ingest/guard.ts`, `services/pvmbg-mock/src/fuzz.ts` | `scripts/demo/p3-k3-fuzz.sh` | `evidence/P3/K3/` |
| K4 proses ulang tanpa duplikat | `services/aggregator/src/ingest/replay.ts`, `services/aggregator/src/ingest/replay-route.ts` | `services/aggregator/src/ingest/replay.test.ts`, `scripts/cluster/drills/p3-schema-replay.mjs` | `evidence/P3/K4/` (k3s) |
| K5 hanya Internal Ops | `services/client-api/src/routes/ops-unprocessed.ts`, `services/client-api/src/routes/ops-replay.ts` | `scripts/demo/p3-k5-ops-only.sh` | `evidence/P3/K5-K6/` (k3s) |
| K6 laporan lapangan 202, tidak hilang, tidak ganda | `services/client-api/src/routes/field-reports.ts`, `services/field-report-processor/` | `scripts/demo/p3-k6-field-reports-kill.sh` | `evidence/P3/K5-K6/` (k3s) |

## Problem 4: aliran satelit
| Kriteria | Kode | Pengujian dan skrip | Bukti |
|---|---|---|---|
| K1--K3 kebakaran, waktu deteksi, update dan retract | `services/satellite-processor/src/fire/engine.ts`, `services/satellite-processor/src/fire/mapping.ts` | `services/satellite-processor/src/fire/engine.test.ts`, `scripts/demo/p4-k1-multi-satellite.sh` | `evidence/P4/` (k3s untuk K1) |
| K4 lonjakan, menyusul, p95, lag | `services/satellite-processor/src/processor.ts`, `services/satellite-processor/src/metrics.ts` | `scripts/demo/p4-e2e.ts` | `evidence/P4/REAL/` |
| K5 crash saat mengenali kebakaran | `services/satellite-processor/src/fire/fire-sink.ts` | `services/satellite-processor/src/fire/crash-points.test.ts`, `scripts/cluster/drills/p4-satellite-leader.mjs` | `evidence/P4/K5/` (k3s) |
| K7--K8 aliran live, putus-sambung | `services/satellite-processor/src/feed-client.ts` | `scripts/demo/p4-e2e.ts` | `evidence/P4/K7/`, `evidence/P4/K8/` |

## Problem 5: ketahanan menyeluruh
| Kriteria | Kode | Pengujian dan skrip | Bukti |
|---|---|---|---|
| K1 peringatan kritis sampai penerima | `services/aggregator/src/publisher/`, `services/consumers/notifier/` | `scripts/demo/int-full-e2e.ts` | `evidence/P5/K1/`, `evidence/INTEGRATION/` |
| K2 pelanggaran kontrak disisihkan | `services/aggregator/src/sources/pantai-client.ts` | `services/aggregator/src/sources/pantai-client.test.ts`, `scripts/demo/p5-behaviors-e2e.ts` | `evidence/P5/REAL/` |
| K3--K4 sensor bermasalah | `services/aggregator/src/resilience/circuit-breaker.ts`, `services/aggregator/src/sources/pantai-client.ts` | `scripts/demo/p5-e2e.ts`, `scripts/cluster/drills/p5-sensor-outage.mjs` | `evidence/P5/K4/` (k3s untuk K3) |
| K5 admisi berprioritas | `services/client-api/src/middleware/admission.ts`, `services/client-api/src/clients/aggregator-client.ts` | `scripts/demo/p5-shed-e2e.ts`, `scripts/cluster/drills/p5-priority-shed.mjs` | `evidence/P5/K5/` (k3s) |
| K6 kombinasi kegagalan | seluruh jalur di atas | `scripts/demo/p5-gameday-e2e.ts` | `evidence/P5/REAL/` |
| K7--K8 observabilitas, SLO | `tools/obs-kit/`, `deploy/k8s/observability/` | `scripts/demo/obs-metrics-audit.ts` | `evidence/P5/K7/` |

## Bonus
| Bonus | Kode | Pengujian dan skrip | Bukti |
|---|---|---|---|
| BON-2 komponen AI di luar jalur peringatan | `services/advisor/` | `scripts/demo/bon2-advisor.sh` | `evidence/BONUS/BON2/` |
| BON-3 kapasitas menyesuaikan diri | `services/aggregator/src/autoscaler/hpa-controller.ts`, `deploy/k8s/aggregator/hpa.yaml` | `scripts/demo/bon3-autoscaling-e2e.ts` | `evidence/BONUS/BON3/`, `evidence/BON3/` |
