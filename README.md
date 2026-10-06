# Platform Koordinasi Kebencanaan BNPB

Implementasi Milestone 1 IF4031 untuk menggabungkan data bahaya dari mock BMKG dan PVMBG ke format kanonik, menyajikannya melalui API terproteksi, serta mendistribusikan kejadian baru melalui RabbitMQ.

## Arsitektur

- `bmkg-mock` dan `pvmbg-mock` adalah sumber eksternal dengan kredensial berbeda.
- `aggregator` melakukan polling paralel, mapping data, menyimpan Canonical Store PostgreSQL, dan menerbitkan event baru.
- `client-api` adalah API publik ber-RBAC; ia membaca data hanya melalui API internal Aggregator.
- `auth-service` menerbitkan access token dan refresh token untuk Media, Tim Lapangan, serta BNPB Internal.
- `dashboard-updater` dan `notifier` adalah consumer independen dari exchange RabbitMQ fanout.

## Menjalankan dari kondisi awal

Prasyarat: Docker Desktop dengan Docker Compose v2 dan Node.js 20+ (hanya diperlukan untuk menjalankan k6 atau helper lokal).

1. Salin `.env.example` menjadi `.env`.
2. Ganti seluruh nilai `replace-with-...` dengan kredensial lokal yang unik. Jangan commit `.env`.
3. Buat token PVMBG dan salin hasilnya ke `PVMBG_ACCESS_TOKEN` pada `.env`:

   ```powershell
   node scripts/mint-pvmbg-token.js
   ```

4. Jalankan seluruh sistem:

   ```powershell
   docker compose up -d --build
   docker compose ps
   ```

5. Pastikan setiap container sehat:

   ```powershell
   Invoke-WebRequest http://localhost:8081/health
   Invoke-WebRequest http://localhost:8082/health
   Invoke-WebRequest http://localhost:8090/health
   Invoke-WebRequest http://localhost:8080/health
   Invoke-WebRequest http://localhost:8091/health
   ```

Port publik: BMKG `8081`, PVMBG `8082`, Client API `8080`, Aggregator `8090`, Auth Service `8091`, Dashboard Consumer `8092`, Notifier `8093`, dan RabbitMQ management `15672`.

## Konfigurasi

`.env.example` mendokumentasikan seluruh konfigurasi. Kelompoknya adalah:

- Source: `BMKG_*`, `PVMBG_*`, termasuk key/token dan delay simulasi.
- Aggregator: `POLL_INTERVAL_MS`, `SOURCE_REQUEST_TIMEOUT_MS`, circuit breaker, concurrency limit, URL source, `DATABASE_URL`, dan `INTERNAL_SERVICE_KEY`.
- Infrastruktur: `POSTGRES_*`, `RABBITMQ_USER`, `RABBITMQ_PASSWORD`, dan `RABBITMQ_URL`.
- Client/Auth: `CLIENT_*`, `AUTH_*`, `ACCESS_TOKEN_TTL_SECONDS`, dan `REFRESH_TOKEN_TTL_SECONDS`.
- Consumer: `DASHBOARD_CONSUMER_PORT` dan `NOTIFIER_CONSUMER_PORT`.

Semua nilai di `.env.example` hanyalah contoh lokal. Tidak ada credential produksi di repository.

## Bukti Problem 1 — perubahan skema tanpa restart

Setelah polling berjalan, aktifkan field baru PVMBG saat sistem tetap hidup:

```powershell
Invoke-RestMethod -Method Post -Uri http://localhost:8082/admin/schema-version `
  -ContentType 'application/json' -Body '{"enabled":true}'
Start-Sleep -Seconds 12
```

Ambil token Internal, lalu baca hazard mentah. Event PVMBG baru harus memiliki `attributes.confidence_level`, sementara record lama tetap dapat dibaca.

```powershell
$token = (Invoke-RestMethod -Method Post -Uri http://localhost:8091/auth/token `
  -ContentType 'application/json' -Body '{"client_id":"internal-client","client_secret":"<AUTH_INTERNAL_CLIENT_SECRET>"}').access_token
Invoke-RestMethod http://localhost:8080/hazard-events?view=raw -Headers @{ Authorization = "Bearer $token" }
```

## Bukti Problem 2 — concurrency, load, dan outage

Atur `PVMBG_DELAY_MIN_MS=3000` dan `PVMBG_DELAY_MAX_MS=3000` di `.env`, kemudian recreate `pvmbg-mock`:

```powershell
docker compose up -d --force-recreate pvmbg-mock
```

Jalankan 50 virtual users selama 60 detik terhadap data seismik BMKG. Script memverifikasi p95 `<300ms`, p99, dan error rate `<1%`.

```powershell
$env:BASE_URL = 'http://localhost:8080'
$env:CLIENT_JWT = $token
k6 run load-tests/k6/hazard-events.js
```

Untuk graceful degradation, aktifkan outage PVMBG. Endpoint tetap membalas data yang tersimpan dan `meta.stale_since` terisi. Setelah outage selesai, polling pulih tanpa restart.

```powershell
Invoke-RestMethod -Method Post -Uri http://localhost:8082/admin/outage `
  -ContentType 'application/json' -Body '{"enabled":true,"duration_seconds":15}'
Start-Sleep -Seconds 5
Invoke-RestMethod http://localhost:8080/hazard-events?view=raw -Headers @{ Authorization = "Bearer $token" }
```

## Bukti Problem 3 — trust domain dan RBAC

Gunakan endpoint `POST /auth/token` dengan salah satu identity pada `.env`, lalu panggil `GET /hazard-events` memakai `Authorization: Bearer <token>`.

- Token Media menerima bentuk Ringkasan; `?view=raw` harus `403`.
- Token Lapangan/Internal memperoleh data lengkap sesuai scope.
- Token access habis sesuai `ACCESS_TOKEN_TTL_SECONDS`; `POST /auth/refresh` menerbitkan pasangan token baru.
- Kirim `X-BMKG-Key` ke PVMBG atau Bearer token PVMBG ke BMKG; keduanya harus ditolak `401/403`.

## Bukti Problem 4 — container dan storage

Setiap service berada pada container sendiri. Restart satu consumer atau satu mock tidak menghentikan Aggregator, Client API, atau service lain:

```powershell
docker compose restart pvmbg-mock
docker compose ps
```

`attributes` disimpan sebagai PostgreSQL `JSONB`; langkah Problem 1 membuktikan `confidence_level` disimpan tanpa menambah kolom maupun menjalankan migrasi. Hanya Aggregator yang menggunakan `DATABASE_URL`; service lain mengambil data melalui API internal Aggregator.

## Bukti Problem 5 — fan-out event

RabbitMQ memakai exchange fanout `hazard_events_exchange`. Kedua consumer menerima event yang sama.

```powershell
docker compose logs dashboard-updater notifier
docker compose stop notifier
docker compose logs dashboard-updater
docker compose start notifier
```

Ketika notifier mati, producer dan dashboard-updater tidak terhenti. Setelah notifier hidup, queue durable menerima event yang tertunda. Untuk membuktikan consumer baru tidak perlu mengubah producer:

```powershell
Set-Location services/consumers/demo-logger
npm install
$env:RABBITMQ_URL = '<RABBITMQ_URL dari .env>'
npx tsx index.ts
```

## Test unit dan build

Jalankan per service dari foldernya:

```powershell
npm test
npm run build
```

Gunakan `npm test`, bukan `bun test`; command kedua menjalankan Bun test runner dan tidak menjalankan API kompatibilitas Vitest yang dipakai proyek.
