# Platform Koordinasi Kebencanaan BNPB

## Overview

Implementasi Milestone 1 IF4031. Platform ini menggabungkan data bahaya dari mock BMKG dan PVMBG ke format kanonik `HazardEvent`, menyajikannya melalui Client API yang terproteksi RBAC, dan mendistribusikan event baru melalui RabbitMQ.

- `bmkg-mock` dan `pvmbg-mock` adalah sumber eksternal dengan kredensial berbeda.
- `aggregator` melakukan polling paralel per sumber, memetakan data, menyimpan Canonical Store PostgreSQL, dan menerbitkan event baru.
- `client-api` adalah API publik ber-RBAC. Ia membaca data hanya lewat API internal Aggregator.
- `auth-service` menerbitkan access token dan refresh token untuk Media, Tim Lapangan, dan BNPB Internal.
- `dashboard-updater` dan `notifier` adalah consumer independen dari exchange RabbitMQ fanout.
- `dashboard-queue-init` dan `notifier-queue-init` adalah job sekali jalan yang menyiapkan queue milik masing-masing consumer sebelum Aggregator mulai menerbitkan event. Status `Exited (0)` setelah startup adalah normal.

## Prerequisites

- Docker Desktop dengan Docker Compose v2.
- Node.js 20 atau lebih baru. Hanya diperlukan untuk membuat token PVMBG, menjalankan test, dan menjalankan k6.
- k6, hanya untuk skenario load test Problem 2.

## Quick Start

1. Salin `.env.example` menjadi `.env`.
2. Ganti seluruh nilai `replace-with-...` dengan kredensial lokal yang unik. Jangan commit `.env`.
3. Buat token PVMBG dan simpan hasilnya di `PVMBG_ACCESS_TOKEN` pada `.env`. Aggregator tidak akan start tanpa token ini.

   ```bash
   node scripts/mint-pvmbg-token.js
   ```

4. Jalankan seluruh sistem:

   ```bash
   docker compose up -d --build
   docker compose ps
   ```

   Queue RabbitMQ dan pesan yang menunggu disimpan dalam volume `rabbitmq_data`. Jangan gunakan `docker compose down --volumes` bila data demo perlu dipertahankan.

5. Pastikan setiap service sehat:

   ```bash
   curl -s http://localhost:8081/health
   curl -s http://localhost:8082/health
   curl -s http://localhost:8090/health
   curl -s http://localhost:8080/health
   curl -s http://localhost:8091/health
   curl -s http://localhost:8092/health
   curl -s http://localhost:8093/health
   ```

Port publik: BMKG `8081`, PVMBG `8082`, Client API `8080`, Aggregator `8090` (debug), Auth Service `8091`, Dashboard Consumer `8092`, Notifier `8093`, PostgreSQL `5432`, RabbitMQ AMQP `5672`, dan RabbitMQ management `15672`.

Contoh di bawah memakai `bash` (macOS dan Linux). Di Windows PowerShell, ganti `curl` dengan `Invoke-RestMethod` dan `$TOKEN` dengan `$token`.

## Configuration

`.env.example` memuat seluruh variabel dengan nilai contoh. Tiap service hanya menerima variabel yang dibacanya, sesuai `environment:` di `docker-compose.yml`. Nilai diambil dari `.env` lewat interpolasi.

| Kelompok | Variabel | Dipakai oleh |
|---|---|---|
| Sumber BMKG | `BMKG_PORT`, `BMKG_API_KEY`, `BMKG_DELAY_MIN_MS`, `BMKG_DELAY_MAX_MS` | bmkg-mock (key juga aggregator) |
| Sumber PVMBG | `PVMBG_PORT`, `PVMBG_JWT_SECRET`, `PVMBG_DELAY_MIN_MS`, `PVMBG_DELAY_MAX_MS`, `PVMBG_ACCESS_TOKEN` | pvmbg-mock, aggregator |
| Aggregator | `AGGREGATOR_PORT`, `POLL_INTERVAL_MS`, `POLL_LOOKBACK_MS`, `SOURCE_REQUEST_TIMEOUT_MS`, `CIRCUIT_BREAKER_FAILURE_THRESHOLD`, `CIRCUIT_BREAKER_COOLDOWN_MS`, `PVMBG_MAX_CONCURRENT_CALLS`, `DATABASE_URL`, `RABBITMQ_URL`, `INTERNAL_SERVICE_KEY` | aggregator |
| Client API | `CLIENT_API_PORT`, `CLIENT_JWT_SECRET`, `AGGREGATOR_REQUEST_TIMEOUT_MS`, `INTERNAL_SERVICE_KEY` | client-api |
| Auth | `AUTH_SERVICE_PORT`, `CLIENT_JWT_SECRET`, `ACCESS_TOKEN_TTL_SECONDS` (default 60), `REFRESH_TOKEN_TTL_SECONDS` (default 900), `AUTH_{MEDIA,LAPANGAN,INTERNAL}_CLIENT_ID`, `AUTH_{MEDIA,LAPANGAN,INTERNAL}_CLIENT_SECRET` | auth-service |
| Consumer | `DASHBOARD_CONSUMER_PORT`, `NOTIFIER_CONSUMER_PORT`, `RABBITMQ_URL` | dashboard-updater, notifier |
| Infrastruktur | `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_PORT`, `RABBITMQ_USER`, `RABBITMQ_PASSWORD` | postgres, rabbitmq |

Semua nilai di `.env.example` hanyalah contoh lokal. Tidak ada credential produksi di repository.

API internal Aggregator (`GET /internal/hazard-events`) menerima `hazard_type` (`SEISMIC` atau `VOLCANIC`), `since` (ISO 8601), dan `limit` (1 sampai 1000, default 500). Header wajibnya `X-Internal-Key`. Client API meneruskan `hazard_type`, `since`, dan `limit` dari query-nya.

## Problem 1 Demo

Setelah polling berjalan, aktifkan field baru PVMBG saat sistem tetap hidup:

```bash
curl -s -X POST http://localhost:8082/admin/schema-version \
  -H 'Content-Type: application/json' -d '{"enabled":true}'
sleep 12
```

Ambil token Internal, lalu baca hazard mentah. Event PVMBG baru harus memiliki `attributes.confidence_level`, sementara record lama tetap dapat dibaca:

```bash
TOKEN=$(curl -s -X POST http://localhost:8091/auth/token \
  -H 'Content-Type: application/json' \
  -d '{"client_id":"internal-client","client_secret":"<AUTH_INTERNAL_CLIENT_SECRET>"}' \
  | node -pe 'JSON.parse(require("fs").readFileSync(0)).access_token')
curl -s "http://localhost:8080/hazard-events?view=raw" -H "Authorization: Bearer $TOKEN"
```

## Problem 2 Demo

Atur `PVMBG_DELAY_MIN_MS=3000` dan `PVMBG_DELAY_MAX_MS=3000` di `.env`, lalu recreate `pvmbg-mock`:

```bash
docker compose up -d --force-recreate pvmbg-mock
```

Skenario yang digunakan dalam laporan menjalankan 50 virtual user BMKG-only
(`SEISMIC`) dan 10 virtual user vulkanik (`VOLCANIC`) secara bersamaan selama
60 detik. Karena access token berlaku 60 detik secara default, atur
`ACCESS_TOKEN_TTL_SECONDS=300` di `.env` dan recreate `auth-service` sebelum
pengujian. Ambil token Lapangan baru tepat sebelum menjalankan k6; jangan
gunakan `$TOKEN` dari demo sebelumnya karena mungkin sudah kedaluwarsa.

```bash
docker compose up -d --no-deps --force-recreate auth-service
CLIENT_JWT=$(curl -s -X POST http://localhost:8091/auth/token \
  -H 'Content-Type: application/json' \
  -d '{"client_id":"<AUTH_LAPANGAN_CLIENT_ID>","client_secret":"<AUTH_LAPANGAN_CLIENT_SECRET>"}' \
  | node -pe 'JSON.parse(require("fs").readFileSync(0)).access_token')
BASE_URL=http://localhost:8080 CLIENT_JWT="$CLIENT_JWT" k6 run tests/phase6/p2-concurrency.k6.js
```

Skrip tersebut menetapkan threshold p95 BMKG-only di bawah 300 ms dan error
rate BMKG-only di bawah 1%. Catat juga throughput, p50/p95/p99, serta error
rate keseluruhan dari hasil uji untuk dibandingkan dengan tabel Problem 2
di laporan.

Untuk graceful degradation, aktifkan outage PVMBG. Data seismik tetap normal, data vulkanik membalas data terakhir dengan `meta.stale_since` yang terisi. Setelah outage selesai, polling pulih tanpa restart:

```bash
curl -s -X POST http://localhost:8082/admin/outage \
  -H 'Content-Type: application/json' -d '{"enabled":true,"duration_seconds":15}'
sleep 5
curl -s "http://localhost:8080/hazard-events?hazard_type=SEISMIC" -H "Authorization: Bearer $TOKEN"
curl -s "http://localhost:8080/hazard-events?hazard_type=VOLCANIC" -H "Authorization: Bearer $TOKEN"
```

## Problem 3 Demo

Setiap client memiliki `client_id` dan `client_secret` sendiri dari `.env`. Ambil token Media, lalu coba permintaan mentah:

```bash
MEDIA=$(curl -s -X POST http://localhost:8091/auth/token \
  -H 'Content-Type: application/json' \
  -d '{"client_id":"media-client","client_secret":"<AUTH_MEDIA_CLIENT_SECRET>"}' \
  | node -pe 'JSON.parse(require("fs").readFileSync(0)).access_token')
curl -s -o /dev/null -w "%{http_code}\n" "http://localhost:8080/hazard-events?view=raw" -H "Authorization: Bearer $MEDIA"
# harus 403 FORBIDDEN_FIELD_ACCESS
curl -s "http://localhost:8080/hazard-events" -H "Authorization: Bearer $MEDIA"
# hanya field Ringkasan
```

Token access Tim Lapangan kedaluwarsa setelah `ACCESS_TOKEN_TTL_SECONDS` (60 detik). Setelah menunggu lebih lama, pakai `POST /auth/refresh` untuk mendapatkan pasangan token baru tanpa login ulang:

```bash
curl -s -X POST http://localhost:8091/auth/refresh \
  -H 'Content-Type: application/json' -d '{"refresh_token":"<refresh_token dari respons sebelumnya>"}'
```

Kredensial lintas domain harus ditolak. Kunci BMKG ke PVMBG, dan Bearer PVMBG ke BMKG:

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:8082/volcanic-reports -H "X-BMKG-Key: <BMKG_API_KEY>"   # 403
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:8081/seismic-events -H "Authorization: Bearer $MEDIA"    # 403
```

Isolasi secret antar container: container client-api tidak boleh menerima kunci domain lain.

```bash
docker compose exec client-api env | grep -E "SECRET|KEY|DATABASE"
# hanya CLIENT_JWT_SECRET dan INTERNAL_SERVICE_KEY yang muncul
```

## Problem 4 Demo

Setiap service berjalan di container sendiri. Restart satu service tidak menghentikan service lain:

```bash
docker compose restart pvmbg-mock
docker compose ps
```

`attributes` disimpan sebagai PostgreSQL `JSONB`. Demo Problem 1 membuktikan `confidence_level` tersimpan tanpa menambah kolom atau menjalankan migrasi. Hanya Aggregator yang memakai `DATABASE_URL`. Service lain mengambil data lewat API internal Aggregator.

## Problem 5 Demo

RabbitMQ memakai exchange fanout `hazard_events_exchange`. Kedua consumer menerima event yang sama:

```bash
docker compose logs dashboard-updater notifier
docker compose stop notifier
docker compose logs dashboard-updater
docker compose start notifier
```

Ketika notifier mati, producer dan dashboard-updater tidak terhenti. Setelah notifier hidup lagi, queue durable mengirim event yang tertunda.

Consumer baru tidak perlu mengubah producer. `demo-logger` adalah alat demo manual dan tidak masuk `docker compose`:

```bash
cd services/consumers/demo-logger
npm install
RABBITMQ_URL='<RABBITMQ_URL dari .env>' npx tsx index.ts
```

## Test dan build

Jalankan per service dari folder masing-masing:

```bash
npm test
npm run build
```

Service yang punya test: `aggregator`, `auth-service`, `client-api`, `consumers/dashboard-updater`, `consumers/notifier`, `bmkg-mock`, dan `pvmbg-mock`.
