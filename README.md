# Platform Koordinasi Kebencanaan BNPB — IF4031 Milestone 2

## 1. Ikhtisar Arsitektur (Milestone 2: Sistem Terdistribusi Skalabel)

Platform Koordinasi Kebencanaan BNPB mengagregasi empat sumber bahaya (**BMKG** `SEISMIC`, **PVMBG** `VOLCANIC`, **Citra Satelit** `WILDFIRE`, dan **Sensor Pantai** `COASTAL`) ke dalam format kanonik `HazardEvent`, menyimpannya pada penyimpanan terdistribusi berbasis kuorum (**Problem 1**), mengoordinasikan pemrosesan satelit menggunakan pemilihan pemimpin & *fencing token* (**Problem 2**), memproses laporan lapangan secara idempoten dengan karantina pesan rusak (**Problem 3**), menjalankan agregasi analitik terisolasi (**Problem 4**), serta menjamin ketahanan menyeluruh dan jalur cepat peringatan kritis di bawah gangguan berlapis (**Problem 5**).

Seluruh sistem berjalan di atas klaster **Kubernetes 3-node (`k3s` / `k3d`)** yang dikelola secara deklaratif menggunakan **Kustomize** (`deploy/k8s/`) pada namespace `bnpb-system` dan `observability`.

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

---

## 5. Menjalankan Pengujian Otomatis & Skenario Demo Problem 5

### Unit & Integration Tests

```bash
# Kontrak & Fakes M2
cd shared-types && npm test

# Layanan Inti & Ketahanan (Auth, Client-API, Aggregator, Notifier, Dashboard-Updater, Obs-Kit)
cd tools/obs-kit && npm test
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

## 6. Kompatibilitas Mode Docker Compose (Milestone 1)

Sistem tetap mempertahankan `docker-compose.yml` untuk pengujian kompatibilitas Milestone 1 secara lokal:
```bash
cp .env.example .env
node scripts/mint-pvmbg-token.js
docker compose up -d --build
```
