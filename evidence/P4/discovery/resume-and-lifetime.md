# Resume + stream-lifetime observations (practice profile, speed 60, captured 2026-11-13 ~12:25-12:31 local)
| Test | Command (token from .env.local, never printed) | Observed |
|---|---|---|
| Backlog drain `from=0` | `capture-feed.mjs stream burst0.jsonl 100 0` | 108 618 frames, ids 0..108617 contiguous (0 gaps, 0 dup ids), server closed the stream at 38.7 s (client timeout was 100 s) |
| Live tail `from=108600` (no 2nd connection) | `... live1.jsonl 75 108600` | 1 683 frames, closed by server at 46.8 s (client timeout 75 s) |
| `Last-Event-ID: 110282`, no `from` | `... live2.jsonl 90 - 110282` | first id = **110283** (exclusive), 405 frames contiguous, closed by server at 43.3 s |
| `from=110300` | `... resume_from.jsonl 5 110300` | first id = **110300** (inclusive) |
| 2nd concurrent connection | see `second-connection.json` | HTTP 429 `too_many_connections` |
Raw captures are in the author's scratchpad (39 MB, not committed); regenerate with `capture-feed.mjs`. A committable slice is `feed-slice-offsets-11900-14899.jsonl.gz`.
