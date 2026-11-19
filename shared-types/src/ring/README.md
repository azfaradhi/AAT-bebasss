# Ring storage client (M2 P1)

Real `StorageClient` implementations behind the contract in `../m2/types.ts` (the contract itself is unchanged).

| Piece | File | Who uses it |
|---|---|---|
| Consistent-hash ring, RF replicas on distinct units | `ring.ts` | `HttpStorageClient` |
| Ring client: replication, partial results, tombstones, anti-entropy `repair()` | `http-storage-client.ts` | **Aggregator only** (the store NetworkPolicy lets nothing else reach `role=store`) |
| Gateway client: same interface, calls the Aggregator's `POST /internal/storage/:op` | `gateway-client.ts` | satellite-processor, field-report-processor, advisor, client-api |
| Env based factory + repair loop | `factory.ts` | all of the above |

## Environment variables

| Variable | Read by | Meaning |
|---|---|---|
| `STORAGE_UNITS_DNS` | Aggregator | Headless Service name of the storage-unit DaemonSet (one A record per pod). Units are identified by asking each for `/u/identity`. |
| `STORAGE_UNITS` | Aggregator, demos | Comma separated unit URLs, alternative to the DNS name. |
| `STORAGE_UNIT_PORT` | factory, storage-unit | Default 8100. |
| `STORAGE_RF` | factory | Replication factor, default 2. |
| `STORAGE_STATE_TTL_MS` | factory | How long a unit state observation is reused (default 1000). |
| `STORAGE_REPAIR_INTERVAL_MS` | Aggregator | Anti-entropy interval (default 5000). |
| `STORAGE_GATEWAY_URL` | everything except the Aggregator | `http://aggregator:8090`; needs `INTERNAL_SERVICE_KEY`. |
| `STORAGE_DATA_DIR`, `STORAGE_UNIT_ID`, `NODE_NAME` | storage-unit | Local log directory, unit id (defaults to the node name), node name for `locate`. |

When none of the storage variables is set, processors fall back to the in-memory fake (single process, no persistence).

## Behaviour worth knowing

- Unit states: a fresh unit starts `JOINING`, a unit restarting with a log starts `RECOVERING`. Neither is read as authoritative until `repair()` copies the keys it owns from healthy peers and marks it `STABLE` (cold start: all reachable units are merged).
- `partial` is true only when some ring arc has every replica unreadable, so one unit down is never partial at RF=2.
- Writes go to every replica that is not `DOWN` and succeed with at least one ack (`replicas_acked` is reported). A unit that missed writes catches up through `repair()`.
- Documents written without `version` get a time-ordered version at the unit so replicas converge; deletes are tombstones so a replica that missed one cannot resurrect it.
- Adding a unit changes ownership of about 1/N of the keys; restart clients with the new unit list and run `repair()` (it copies what the new unit now owns).
- Known limits: the log is append-only without compaction; `aggregate`/`checksum` stream every row of the source from each readable unit; `HazardEvent` listing for the public API scans up to 50 000 events per request (cached 1 s).
