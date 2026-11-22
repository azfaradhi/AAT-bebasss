# Ingest & Lag dashboard: panel queries for the components of Member 1

For Member 3's provisioned dashboard "Ingest & Lag". All metric names are the contract `METRICS` names; every query below works on the `/metrics` output verified in `2026-11-16_metrics-and-log-fields.txt`.

| Panel | Query | What it answers |
|---|---|---|
| Satellite offset lag | `bnpb_sat_offset_lag` | how far behind the feed head the committed offset is (P4-K4 "catches up in <= 60 s") |
| Event-to-store p95 | `histogram_quantile(0.95, sum(rate(bnpb_sat_event_to_store_seconds_bucket[1m])) by (le))` | data-in to stored latency (P4-K4) |
| Late detections applied vs beyond bound | `rate(bnpb_sat_late_applied_total[5m])` and `rate(bnpb_sat_late_beyond_bound_total[5m])` | P4-K2 lateness handling |
| Satellite reconnects | `rate(bnpb_sat_reconnects_total[5m])` | stream restarts (normal every ~43 s) |
| Ingest outcomes by source | `sum by (source, outcome) (rate(bnpb_ingest_events_total[5m]))` | mapped / parked / response_rejected per source |
| Parked messages by reason | `sum by (status, reason_code) (bnpb_parked_messages)` | what is waiting in the parking lot and why (P3-K2) |
| Field reports | `sum by (outcome) (bnpb_field_reports_total)` | accepted / duplicate / rejected / unavailable / processed (P3-K6) |
| Mock request rate and latency | `sum by (service, status_class) (rate(bnpb_http_server_request_duration_seconds_count{service=~"bmkg-mock|pvmbg-mock"}[1m]))` | what the mocks serve; the request log (`/admin/request-log`) gives the per-instance proof for P2-K2 |
| "What's wrong?" row | `bnpb_sat_offset_lag > 1000`, `increase(bnpb_parked_messages[5m]) > 0`, `rate(bnpb_http_server_request_duration_seconds_count{status_class="5xx"}[1m]) > 0` | quick explanation for P5-K7 |
| Advisor (bonus) outcomes | `sum by (outcome) (rate(bnpb_advisory_total[5m]))` | flagged / llm / template / timeout / llm_error / rejected / breaker_open / dropped |
| Advisor breaker | `bnpb_advisory_breaker_state` | 0 closed, 1 half-open, 2 open (the LLM is unhealthy; alerts are unaffected) |
