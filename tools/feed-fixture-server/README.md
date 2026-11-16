# feed-fixture-server

Replays the captured satellite feed (`fixtures/*.jsonl.gz`, offsets 11900..14899, 3 000 real frames) with the real feed's rules: shared gap-free offsets, `from=N` inclusive, `Last-Event-ID: N` exclusive, one connection at a time (2nd gets 429), `/v1/session`.

```bash
node tools/feed-fixture-server/server.mjs      # PORT, FRAMES_PER_SECOND, DISCONNECT_EVERY_N, CLOSE_AFTER_MS, FIXTURE_TOKEN
curl -X POST localhost:8099/admin/disconnect   # drop the live connection
curl -X POST localhost:8099/admin/config -d '{"disconnectEveryN":250}'
curl localhost:8099/admin/stats                # connections, frames sent, start offsets
```
