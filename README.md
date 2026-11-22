# Platform Koordinasi Kebencanaan BNPB — IF4031 Milestone 2

## 1. Ikhtisar Arsitektur (Milestone 2: Sistem Terdistribusi Skalabel)

Platform Koordinasi Kebencanaan BNPB mengagregasi empat sumber bahaya (**BMKG** `SEISMIC`, **PVMBG** `VOLCANIC`, **Citra Satelit** `WILDFIRE`, dan **Sensor Pantai** `COASTAL`) ke dalam format kanonik `HazardEvent`, menyimpannya pada penyimpanan terdistribusi berbasis kuorum (**Problem 1**), mengoordinasikan pemrosesan satelit menggunakan pemilihan pemimpin & *fencing token* (**Problem 2**), memproses laporan lapangan secara idempoten dengan karantina pesan rusak (**Problem 3**), menjalankan agregasi analitik terisolasi (**Problem 4**), serta menjamin ketahanan menyeluruh dan jalur cepat peringatan kritis di bawah gangguan berlapis (**Problem 5**).

Seluruh sistem berjalan di atas klaster **Kubernetes 3-node (`k3s` / `k3d`)** yang dikelola secara deklaratif menggunakan **Kustomize** (`deploy/k8s/`) pada namespace `sistem-informasi-kebencanaan-bnpb` dan `observability`.

---

## 2. Deklarasi Topologi Klaster (`TOPO-1`)

| Node | Peran Kubernetes | Host Fisik (Mode Demo 3-Laptop) | IP LAN | Spesifikasi VM | Beban Kerja Utama |
|---|---|---|---|---|---|
| `node-a` | `control-plane, etcd, worker` | Laptop Anggota 3 (Host-A) | `192.168.10.11` | 4 vCPU, 6 GiB RAM (`linux/amd64`) | `storage-unit` (1 pod), `rabbitmq-0`, `aggregator`, `bmkg-mock`, `pvmbg-mock`, `sensor-pantai`, `observability` |
| `node-b` | `worker` | Laptop Anggota 2 (Host-B) | `192.168.10.12` | 4 vCPU, 4 GiB RAM (`linux/amd64`) | `storage-unit` (1 pod), `rabbitmq-1`, `aggregator`, `client-api`, `satellite-processor`, `notifier`, `analytics-dashboard` |
| `node-c` | `worker` | Laptop Anggota 1 (Host-C) | `192.168.10.13` | 4 vCPU, 4 GiB RAM (`linux/amd64`) | `storage-unit` (1 pod), `rabbitmq-2`, `auth-service`, `client-api`, `satellite-processor`, `field-report-processor`, `dashboard-updater`, `notifier` |

- **Arsitektur Image Asisten (`PLAT-4`):** `sustuna/satelit-feed@sha256:9fb2fe52...` dan `sustuna/sensor-pantai@sha256:51fbd90d...` dipin dengan digest SHA-256 pada arsitektur `linux/amd64`.
- **Plafon Resource (`PLAT-5`):** Total limit seluruh pod aplikasi di namespace `bnpb-system` adalah **7,45 vCPU** dan **7,31 GiB RAM** (memenuhi batas Lampiran B $\le 8\text{ vCPU}$ dan $\le 8\text{ GiB RAM}$).
- **Isolasi Jaringan (`PLAT-8`):** `NetworkPolicy` `store-ingress` membatasi akses TCP `8085` ke `storage-unit` hanya untuk layanan penyimpan/pemroses sah; `client-api` ditolak di tingkat jaringan jika mencoba mengakses `storage-unit` secara langsung.

---

## 3. Panduan Clean-Start (Klaster Kubernetes M2)

### Opsi A — Klaster Dev Lokal 3-Node (`k3d`)

1. Pastikan Docker, `kubectl`, dan `k3d` telah terpasang.
2. Buat klaster 3-node (`1 server + 2 agents`) beserta local registry `bnpb-registry.localhost:5000`:
   ```bash
   make dev-up
   ```
3. Siapkan file environment dan Kubernetes Secret di namespace `bnpb-system`:
   ```bash
   cp .env.local.example .env.local
   make secrets
   ```
4. Bangun seluruh image layanan, dorong ke registry klaster, dan terapkan manifes Kustomize (`overlays/dev`):
   ```bash
   make build push up
   ```

### Opsi B — Klaster Demo 3-VM Lintas Host (`k3s`)

1. Pada **Host-A (`192.168.10.11`)**, jalankan skrip bootstrap server + registry lokal:
   ```bash
   NODE_IP=192.168.10.11 bash scripts/cluster/k3s-server.sh
   ```
2. Pada **Host-B (`192.168.10.12`)** dan **Host-C (`192.168.10.13`)**, gabungkan worker ke server:
   ```bash
   SERVER_IP=192.168.10.11 K3S_TOKEN=<token-dari-host-a> NODE_IP=192.168.10.12 bash scripts/cluster/k3s-agent.sh
   ```
3. Deploy overlay `demo` beserta stack observabilitas:
   ```bash
   REGISTRY=192.168.10.11:5000 make secrets build push up-demo
   ```

### Verifikasi Kepatuhan Klaster (`TA-1..8`, `PLAT-5`, `PLAT-8`)

```bash
make verify
# Menjalankan:
# - bash scripts/verify/verify-labels.sh     (label app.kubernetes.io/{name,component,part-of})
# - bash scripts/verify/verify-resources.sh  (requests/limits tiap kontainer & plafon <= 8 vCPU / 8 GiB)
# - bash scripts/verify/verify-netpol.sh     (isolasi NetworkPolicy store-ingress & rabbitmq-ingress)
```

Untuk verifikasi statis seluruh manifes Kustomize tanpa klaster aktif:
```bash
node scripts/verify/verify-manifests.mjs deploy/k8s
node scripts/verify/verify-manifests.mjs deploy/k8s/overlays/dev
node scripts/verify/verify-manifests.mjs deploy/k8s/overlays/demo
```

---

## 4. Referensi Variabel Lingkungan (`.env.example`)

| Kelompok | Variabel Utama | Dipakai Oleh |
|---|---|---|
| Klaster & Registry | `REGISTRY`, `TAG`, `NAMESPACE`, `OBS_NAMESPACE` | `Makefile`, skrip klaster |
| Penyimpanan Kuorum (P1) | `STORAGE_PEERS`, `QUORUM_N=3`, `QUORUM_W=2`, `QUORUM_R=2`, `HINT_REPLAY_INTERVAL_MS`, `ANTI_ENTROPY_INTERVAL_MS` | `storage-unit`, `aggregator`, `satellite-processor`, `field-report-processor`, `analytics-dashboard` |
| Koordinasi & Satelit (P2) | `LEADER_LEASE_TTL_MS`, `LEADER_RENEW_INTERVAL_MS`, `SAT_FEED_URL`, `SAT_AUTH_TOKEN`, `SAT_POLL_INTERVAL_MS` | `satellite-processor` |
| Laporan Lapangan (P3) | `FIELD_REPORTS_QUEUE`, `DLX_EXCHANGE`, `PARKED_MAX_RETRIES`, `JWT_CLOCK_TOLERANCE_S=60` | `auth-service`, `client-api`, `field-report-processor` |
| Analitik (P4) | `ANALYTICS_INTERVAL_MS`, `ANALYTICS_WINDOW_SECONDS`, `ANALYTICS_CONCURRENCY_LIMIT` | `analytics-dashboard` |
| Sensor Pantai & Ketahanan (P5) | `PANTAI_URL`, `PANTAI_PROFILE`, `PANTAI_TIMEOUT_MS=2500`, `CB_FAILURE_THRESHOLD=4`, `CB_OPEN_MS=8000`, `BULKHEAD_MAX_CONCURRENT=4`, `ADMISSION_MAX_INFLIGHT=60`, `ADMISSION_MEDIA_SHED_RATIO=0.60`, `ADMISSION_INTERNAL_SHED_RATIO=0.85` | `sensor-pantai`, `aggregator`, `client-api`, `notifier` |
| Broker & Auth | `RABBITMQ_URL`, `CLIENT_JWT_SECRET`, `INTERNAL_SERVICE_KEY`, `BMKG_API_KEY`, `PVMBG_JWT_SECRET`, `PVMBG_ACCESS_TOKEN` | Seluruh layanan terkait |
| Ingest guard / parking | `MAX_MESSAGE_BYTES` (262144), `MAX_JSON_DEPTH` (32), `PARK_MAX_ATTEMPTS` (8) | aggregator (`src/ingest/`) |
| Mapper PVMBG | `VOLCANIC_MAPPER_VERSION` (`v1` default, `v2` after a schema change) | aggregator (`src/mapping/`) |
| Satelit | `SAT_FEED_BASE_URL`, `SAT_GROUP_TOKEN`, `SAT_ALLOWED_LATENESS_MIN` (360), `SAT_FLUSH_INTERVAL_MS` (250), `SAT_WRITE_CONCURRENCY` (32), `SAT_CHECKPOINT_EVERY_N` (100), `SAT_BATCH_SIZE` (500), `SAT_IDLE_TIMEOUT_MS` (30000), `SAT_RECONNECT_MIN_MS`, `SAT_RECONNECT_MAX_MS`, `SAT_SESSION_POLL_MS`, `SATELLITE_PORT` (8094) | satellite-processor |
| Laporan lapangan | `SWEEP_INTERVAL_MS` (200), `RECONCILE_INTERVAL_MS` (60000), `FIELD_REPORT_PORT` (8095) | field-report-processor |
| Advisor (bonus) | `ADVISOR_PORT` (8097), `ADVISOR_POLL_MS` (30000), `ADVISOR_LLM_BASE_URL`, `ADVISOR_LLM_MODEL` (`openai/gpt-oss-20b`), `ADVISOR_LLM_TIMEOUT_MS` (5000), `ADVISOR_LLM_RATE_PER_MIN` (20), `ADVISOR_QUEUE_MAX`, `ADVISOR_BREAKER_FAILURES`, `ADVISOR_BREAKER_COOLDOWN_MS`, kunci `GROQ_API_KEY` / `ADVISOR_LLM_API_KEY` (hanya di `.env.local`/Secret) | advisor |

---

## 5. Menjalankan Pengujian Otomatis & Skenario Demo Problem 5

### Unit & Integration Tests

```bash
# Kontrak & Fakes M2
cd shared-types && npm test

# Layanan Inti & Ketahanan (Storage-Unit, Analytics-Dashboard, Auth, Client-API, Aggregator, Notifier, Dashboard-Updater, Obs-Kit)
cd tools/obs-kit && npm test
cd services/storage-unit && npm run build && npm test
cd services/analytics-dashboard && npm test
cd services/auth-service && npm test
cd services/client-api && npm test
cd services/aggregator && npm test
cd services/consumers/notifier && npm test
cd services/consumers/dashboard-updater && npm test
```

### Skenario Demo & Verifikasi Problem 5 (`scripts/demo/`)

- **`P5-K1` (Jalur Cepat Peringatan Kritis $\le 5\text{ s}$, 0 Hilang):**
  ```bash
  bash scripts/demo/p5-k1-critical.sh
  ```
- **`P5-K2` (Deteksi & Karantina Sensor Pantai Bohong — `CONTRACT_VIOLATION`):**
  ```bash
  bash scripts/demo/p5-k2-quarantine.sh
  ```
- **`P5-K4` (Isolasi `sensor-pantai` Lambat/Mati — Circuit Breaker & Bulkhead):**
  ```bash
  bash scripts/demo/p5-k4-sensor-down.sh
  ```
- **`P5-K5` (Pengendalian Admisi Berprioritas & Load Shedding Klien `media`):**
  ```bash
  bash scripts/demo/p5-k5-shed.sh
  ```
- **`R6` (Ketahanan Klaster RabbitMQ Quorum Queue Saat Pod Broker Dihentikan Paksa):**
  ```bash
  bash scripts/demo/p5-broker-kill.sh
  ```
- **`P5-K6` (Skenario Game Day — 4 Kegagalan Bersamaan):**
  ```bash
  bash scripts/demo/p5-k6-gameday.sh
  ```
- **`P5-K8` (Evaluasi SLI/SLO & Sisa Error Budget):**
  ```bash
  bash scripts/demo/p5-k8-slo-budget.sh
  ```
- **Switchover Kredensial Saat Ujian (`MB3-T17`):**
  ```bash
  bash scripts/demo/exam-switchover.sh /path/to/pantai.key http://satelit-exam:8083/frames <exam-token>
  ```

---

## 5a. Skenario Demo dan Verifikasi Problem 3 dan 4 (`scripts/demo/`)

### Problem 3: data tidak valid, DLQ, laporan lapangan

Semua skrip berikut berjalan lokal tanpa cluster (in-process, penyimpanan in-memory) dan mencetak tabel PASS/FAIL. Hasilnya tersimpan di `AAT-docs/m2/evidence/P3/`.

| Skrip | Membuktikan |
|---|---|
| `scripts/demo/p3-k1-schema-policy.sh` | Tiap jenis perubahan skema PVMBG sesuai tabel deklarasi (diterima otomatis atau di-park) |
| `scripts/demo/p3-k3-fuzz.sh` | 9 respons berbahaya (JSON terpotong, nesting 10 000, UTF-8 rusak, 50 MB, kosong, content-type salah, NUL, BOM, batch campuran) tidak membuat proses crash; yang sehat tetap tersimpan. Dengan `AGGREGATOR_NAMESPACE` terisi, skrip juga memeriksa `restartCount == 0` di cluster |
| `scripts/demo/p3-k4-replay.sh` | Pesan yang di-park dipulihkan oleh mapper v2 + `POST /ops/replay`, tanpa duplikat, replay kedua tidak mengubah apa pun |
| `scripts/demo/p3-k5-ops-only.sh` | `/ops/unprocessed`: media 403, lapangan 403, internal 200; endpoint audit menampilkan `retrying` dan `parked` |
| `scripts/demo/p3-k6-field-reports-kill.sh` | 500 laporan dengan kunci idempoten berulang, receiver dimatikan, processor dijeda lalu dimatikan: tidak ada laporan 202 yang hilang atau diproses dua kali |
| `scripts/verify/p3-owned-manifests.sh` | Label `role`, memori Lampiran B, probe, dan tidak ada secret literal pada manifest komponen kami |

Mode skema PVMBG: `POST /admin/schema-version` menerima `{"enabled":true}` (lama) atau `{"mode":"baseline|additive|rename|type_change|drop_required"}`; mode hanya berlaku untuk record yang dibuat setelahnya. `POST /admin/fuzz {"case":"truncated_json"|...|null}` membuat mock PVMBG mengirim respons berbahaya. Mapper PVMBG dipilih dengan `VOLCANIC_MAPPER_VERSION` (`v1` kebijakan terdeklarasi, `v2` memahami field yang di-rename dan angka bertipe string).

Kedua mock menyediakan `GET /admin/request-log?since=<ISO>` (log request dengan `caller_instance` dari header `X-Aggregator-Instance`), `/ready`, dan `/metrics` (histogram `bnpb_http_server_request_duration_seconds`). `PVMBG_LIVE_INTERVAL_MS` mengatur interval record baru (default 10000).

### Problem 4: aliran satelit

`tools/feed-fixture-server` memutar ulang 3 000 frame hasil capture nyata dengan aturan feed asli (offset bersama, `from=` inklusif, `Last-Event-ID` eksklusif, koneksi kedua ditolak 429) dan dapat memutus koneksi. Hasil bukti di `AAT-docs/m2/evidence/P4/`.

| Skrip | Membuktikan |
|---|---|
| `scripts/demo/p4-k8-reconnect.sh` | 25 pemutusan koneksi paksa: offset 3 000/3 000 kontigu, tanpa duplikat, offset terakhir ter-commit |
| `scripts/demo/p4-k1-multi-satellite.sh` | Satu kebakaran yang terlihat beberapa satelit menjadi tepat satu HazardEvent |
| `scripts/demo/p4-k3-update-retract.sh` | `update` mempertahankan `hazard_id` dan mengubah atribut; `retract` di bawah 2 deteksi menghapus event; deteksi ulang menghidupkannya kembali dengan id sama |
| `scripts/demo/p4-k2-late-data.sh` | Deteksi terlambat di kedua sisi batas 360 menit: yang di dalam batas diterapkan, yang di luar dihitung dan dilaporkan |
| `scripts/demo/p4-k6-reference-diff.sh` | Hasil pipeline dibandingkan dengan perhitungan batch independen (brute-force) atas aliran yang sama; selisih dikategorikan per penyebab (`LATENESS_MIN=60` memperlihatkan selisih akibat batas keterlambatan) |
| `scripts/demo/bon2-advisor.sh` | Bonus BON-2: aliran yang sama diproses dengan dan tanpa advisor saat LLM palsu dibuat lambat, mati, dan salah: event identik, advisor menyerap semua kegagalan |
| `scripts/demo/bon2-real-llm.sh` | Satu panggilan nyata ke LLM gratis (Groq), kunci dibaca dari `.env.local` dan tidak pernah dicetak |
| `scripts/demo/p4-k7-live.sh` | Pipeline pada feed satelit NYATA ≥ 5 menit (token dibaca dari `.env.local`, tidak pernah dicetak); buka panel lag/keterlambatan di layar saat berjalan |
| `scripts/demo/p4-k8-disconnect.sh` | Pada feed nyata, koneksi kami diputus berkala: offset tetap kontigu, tanpa duplikat (mode cluster `KUBE=1` belum diimplementasi) |
| `scripts/demo/p4-k5-crash.sh` | Pipeline dibunuh 40 kali di titik tulis acak: hasil akhir identik byte-per-byte dengan run tanpa gangguan |
| `scripts/demo/p4-k4-burst.sh` | Burst ~108 000 frame: lag, waktu catch-up, p95 event-to-store, memori, tanpa kehilangan data; `WRITE_LATENCY_MS` memodelkan latensi tulis ring |

Statistik proses: `GET :8094/internal/satellite/stats` (watermark, kebakaran terbuka, penghitung keterlambatan) dan `/metrics` (`bnpb_sat_offset_lag`, `bnpb_sat_late_*`, `bnpb_sat_event_to_store_seconds`).

---

## 5b. Skenario Demo, Pengujian Beban (`k6`), dan Verifikasi Problem 1, Problem 2, Audit API, & Bonus 3

Seluruh skrip berikut menjalankan **proses sistem operasi nyata** (`storage-unit`, `aggregator`, `analytics-dashboard`, `client-api`, `bmkg-mock`, `pvmbg-mock`, `p2-lb`, dan `k6`) melalui HTTP dan mencetak hasil verifikasi `[PASS]/[FAIL]`. Bukti eksekusi tersimpan di `AAT-docs/m2/evidence/{P1,P2,INTEGRATION,BONUS}/`.

| Skrip | Kriteria | Membuktikan |
|---|---|---|
| `npx --prefix services/aggregator tsx scripts/demo/p1-k1-catalogue-loader.ts [--file <path>]` | `P1-K1`, `P1-K2` | Memuat 3.600 gempa katalog historis Indonesia (`scripts/demo/fixtures/katalog-gempa-historis.csv` atau berkas CSV/JSON asisten via `--file`), melaporkan ketimpangan geografis alami, matriks sebaran shard (*primary* vs *replica*) per node (`node-a..c`), memverifikasi 100% `primary.node != replica.node`, checksum SHA-256 Audit API, serta beban tulis saat lonjakan 1.500 gempa di satu wilayah |
| `npx --prefix services/aggregator tsx scripts/demo/p1-surge-e2e.ts` | `P1-K2` | Pengukuran beban tulis tiap unit penyimpanan saat pemuatan dataset 8 wilayah vs lonjakan 3.000 gempa di satu wilayah ("Palu") |
| `npx --prefix services/aggregator tsx scripts/demo/p1-k3-x09-e2e.ts` | `P1-K3`, `X-09` | Penelusuran berhalaman Audit API atas 1.200 event lintas 4 sumber = urutan acuan `(ingested_at, hazard_id)`; `GET /hazard-events?limit=50` lewat `client-api` = 50 terbaru lintas seluruh jenis bahaya; toleransi *clock skew* JWT $\pm 60\text{ s}$ pada pergeseran jam $+45\text{ s}$ dan $-30\text{ s}$ |
| `npx --prefix services/aggregator tsx scripts/demo/p1-ring-demo.ts` | `P1-K4`, `P1-K6` | Mematikan 1 proses `storage-unit` (`SIGKILL`) dan menghapus seluruh direktori disknya: checksum SHA-256 Audit API sebelum dan sesudah identik (0 event hilang), `repair()` memulihkan redundansi (`redundancy_ok=true`), dan sistem tahan kehilangan node berikutnya |
| `npx --prefix services/aggregator tsx scripts/demo/p1-join-e2e.ts` | `P1-K5`, `P1-K6` | Menambahkan node/unit penyimpanan ke-4 secara hidup saat baca/tulis berjalan: 0 baca/tulis gagal, menjadi `STABLE` dalam $\approx 1\text{ s}$ dan ikut menanggung 26,7% salinan serta beban tulis |
| `npx --prefix services/aggregator tsx scripts/demo/p1-analytics-e2e.ts` | `P1-K7` | Dasbor analitik browser (`services/analytics-dashboard`, grafik SVG per kategori bahaya $\times$ waktu, distribusi `severity`, tabel `area_name`) = hitungan langsung Audit API; spanduk *"Data belum lengkap"* muncul otomatis ketika `partial=true` |
| `npx --prefix services/aggregator tsx scripts/demo/p2-poller-e2e.ts` | `P2-K2..K5` | Dua poller berbagi Kubernetes `Lease` (`bmkg`, `pvmbg`): log mock hanya mencatat 1 `caller_instance` aktif; *failover* $\le 4{,}1\text{ s}$ ($\le 60\text{ s}$) saat leader di-`SIGKILL`; tahan pergeseran jam $+45\text{ s}/-30\text{ s}$ dan pembekuan proses (`SIGSTOP`/`SIGCONT`) |
| `npx --prefix services/aggregator tsx scripts/demo/p2-clock-freeze-e2e.ts` | `P2-K4`, `P2-K5` | Uji khusus pergeseran jam dinding $+45\text{ s} / -30\text{ s}$ dan pembekuan pemimpin (*zombie leader*) pada koordinator Lease |
| `npx --prefix services/aggregator tsx scripts/demo/p2-failover-e2e.ts` | `P2-K3` | *Failover* pemimpin pemroses satelit dalam $\approx 4\text{ s}$ tanpa celah offset dan tanpa event ganda |
| `npx --prefix services/aggregator tsx scripts/demo/p1-p2-cross-x10-x11-x12-e2e.ts` | `X-10..X-12`, `P2-K5` | `ingested_at` imutabel & monotonik ketat lintas pergantian pemimpin dengan lompatan jam mundur ($+45\text{ s} \to -30\text{ s}$, `X-10`); pengamatan langsung penolakan tulis pemimpin zombi **HTTP 409 `FENCED`** (`FencedError`) dari `storage-unit` + metrik `bnpb_fencing_rejections_total` (`P2-K5`); konsistensi dasbor analitik di bawah beban tulis 4 sumber (`X-11`); jawaban identik Audit API dari ketiga replika Aggregator (`X-12`) |
| `ulimit -n 10240 && P2_K6_DURATION_S=120 npx --prefix services/aggregator tsx scripts/demo/p2-k1-k6-k7-k8-e2e.ts` | `P2-K1`, `P2-K6`, `P2-K7`, `P2-K8` | $\ge 3$ replika Aggregator lintas node di belakang Load Balancer `p2-lb.ts` yang mengisolasi replika tak sehat (`P2-K1`); benchmark `k6` throughput 3 replika $\ge 2{,}0\times$ 1 replika (`P2-K7`); uji beban `k6` (`load-tests/p2/p2-sustained-scale.k6.js`) **10.000 VU selama 120 detik** dengan skala hidup **$3 \to 5 \to 2$** dan *error rate* $< 1\%$ (`P2-K6`); *rolling update* langsung $v1 \to v2$ dengan **0 permintaan gagal** (`P2-K8`) |
| `npx --prefix services/aggregator tsx scripts/demo/bon3-autoscaling-e2e.ts` | `BON-3` (`MB2-C1`) | Kapasitas menyesuaikan diri (*autoscaling* proporsional HPA v2 `HpaController`): replika Aggregator bertambah otomatis $3 \to 5$ saat beban naik melampaui target utilisasi 70% dan berkurang otomatis $5 \to 3$ setelah beban turun melewati jendela stabilisasi, dengan 0 permintaan gagal |

---

## 6. Kompatibilitas Mode Docker Compose (Milestone 1)

Sistem tetap mempertahankan `docker-compose.yml` untuk pengujian kompatibilitas Milestone 1 secara lokal:
```bash
cp .env.example .env
node scripts/mint-pvmbg-token.js
docker compose up -d --build
```
