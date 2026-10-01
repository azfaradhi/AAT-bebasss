# AAT-bebasss

> Overview, Prerequisites, Quick Start, and Configuration sections are still to be written. The demos below assume `docker compose up -d --build` has already been run from a checkout with `.env` copied from `.env.example`.

## Problem 3 Demo

Auth Service issues short-TTL (`ACCESS_TOKEN_TTL_SECONDS`, default 60s) JWTs to three pre-provisioned client identities, with server-enforced RBAC on `GET /hazard-events`.

1. Get a token for `scope: media`:
   ```bash
   curl -s -X POST localhost:8091/auth/token -H 'content-type: application/json' \
     -d '{"client_id":"media-client","client_secret":"media-secret"}'
   ```
2. `GET /hazard-events?view=raw` with that token → `403 FORBIDDEN_FIELD_ACCESS`:
   ```bash
   curl -s -w ' [%{http_code}]\n' "localhost:8080/hazard-events?view=raw" -H "Authorization: Bearer $ACCESS_TOKEN"
   ```
3. `GET /hazard-events` (no `view`) with the same token → `200`, response has only Ringkasan fields (`hazard_id`, `source`, `hazard_type`, `severity`, `area_name`, `occurred_at`, `ingested_at` — no `source_ref_id`/`latitude`/`longitude`/`attributes`):
   ```bash
   curl -s localhost:8080/hazard-events -H "Authorization: Bearer $ACCESS_TOKEN"
   ```
4. Get a token for `scope: lapangan`, wait 60+ seconds without using it, then use it → `401` (expired):
   ```bash
   curl -s -X POST localhost:8091/auth/token -H 'content-type: application/json' \
     -d '{"client_id":"lapangan-client","client_secret":"lapangan-secret"}'
   sleep 65
   curl -s -w ' [%{http_code}]\n' localhost:8080/hazard-events -H "Authorization: Bearer $ACCESS_TOKEN"
   ```
5. `POST /auth/refresh` with that token's refresh token → new access token issued without resubmitting `client_id`/`client_secret`; the old access token stays rejected on retry:
   ```bash
   curl -s -X POST localhost:8091/auth/refresh -H 'content-type: application/json' \
     -d "{\"refresh_token\":\"$REFRESH_TOKEN\"}"
   ```
6. Cross-domain credential rejection — BMKG's key against PVMBG, and PVMBG's token against BMKG, both `403`:
   ```bash
   curl -s -w ' [%{http_code}]\n' -H "Authorization: Bearer $BMKG_API_KEY" localhost:8082/volcanic-reports
   curl -s -w ' [%{http_code}]\n' -H "X-BMKG-Key: $(node scripts/mint-pvmbg-token.js)" localhost:8081/seismic-events
   ```

## Problem 5 Demo

The Aggregator publishes `HazardEvent`s to the `hazard_events_exchange` fanout exchange (RabbitMQ, management UI at `localhost:15672`, `guest`/`guest`) without knowing or caring who is listening.

1. Start `dashboard-updater` and `notifier`, publish a `HazardEvent`, confirm both receive it:
   ```bash
   cd services/aggregator
   RABBITMQ_URL="amqp://guest:guest@localhost:5672" npx tsx scripts/publish-fake-events.ts 1
   cd ../..
   docker compose logs dashboard-updater notifier | grep "hazard event processed"
   ```
2. Stop `notifier` only, publish 2–3 more events, confirm `dashboard-updater` is unaffected and the publisher doesn't block:
   ```bash
   docker compose stop notifier
   cd services/aggregator && RABBITMQ_URL="amqp://guest:guest@localhost:5672" npx tsx scripts/publish-fake-events.ts 3 && cd ../..
   docker compose logs dashboard-updater | grep "hazard event processed"
   ```
3. Restart `notifier`, confirm the missed events arrive (durable queue redelivery, not lost):
   ```bash
   docker compose start notifier
   sleep 5
   docker compose logs notifier | grep "hazard event processed"
   ```
4. Add a third throwaway consumer bound to the same exchange, confirm it receives new events, without touching `eventPublisher.ts` (`services/consumers/demo-logger/`, run manually — not in `docker-compose.yml`):
   ```bash
   cd services/consumers/demo-logger
   npm install
   RABBITMQ_URL="amqp://guest:guest@localhost:5672" npx tsx index.ts
   # in another terminal: publish more events and watch this one log them too
   ```