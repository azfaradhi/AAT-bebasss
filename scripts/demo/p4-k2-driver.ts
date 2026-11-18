import { FeedClient } from '../../services/satellite-processor/src/feed-client';
import { detection, type DetOpts } from '../../services/satellite-processor/src/fire/fixtures';
import { FireSink } from '../../services/satellite-processor/src/fire/fire-sink';
import type { SatFrame } from '../../services/satellite-processor/src/sink';
import { InMemoryStorage } from '../../services/satellite-processor/test-support/contract-fakes/fakes/in-memory-storage';

const near = (time: number, lat: number, sat: string): DetOpts => ({ lat, lon: 110.0, sat, time });
const clock = (time: number): DetOpts => ({ lat: 5.0, lon: 100.0, time, sat: 'N21' });

// [label, detection]; allowed lateness 360 min, so watermark = max detection time - 6 h
const SCRIPT: Array<[string, DetOpts]> = [
  ['A 12:00 (N)', near(1200, -2.0, 'N')],
  ['B 12:05 (N20)', near(1205, -1.996, 'N20')],
  ['clock 18:00 (far away, advances event time)', clock(1800)],
  ['C 12:00 in bound (t == watermark 12:00)', near(1200, -1.992, 'N21')],
  ['D 11:59 BEYOND bound (watermark 12:00)', near(1159, -1.988, 'N')],
  ['clock 20:00 (watermark -> 14:00)', clock(2000)],
  ['E 13:59 BEYOND bound (watermark 14:00)', near(1359, -1.984, 'N20')],
  ['F 14:00 in bound (t == watermark 14:00)', near(1400, -1.986, 'N')],
];

const toFrames = () => SCRIPT.map(([, d], i) => ({ id: i + 1, event: 'detection', data: { offset: i + 1, detection: detection(d) } }));

(async () => {
  if (process.argv[2] === 'gen') {
    process.stdout.write(toFrames().map((f) => JSON.stringify(f)).join('\n') + '\n');
    return;
  }
  const feed = process.env.FEED_URL ?? 'http://127.0.0.1:18098';
  const client = new FeedClient({ baseUrl: feed, token: 'x', idleTimeoutMs: 10_000 });
  const storage = new InMemoryStorage();
  const sink = new FireSink(storage);
  const ctx = { fence: 1, signal: new AbortController().signal };
  const snapshot = async () => {
    const [e] = (await storage.listEvents({ source: 'SATELIT', limit: 10 })).items;
    return e ? `${e.attributes.detection_count} detections, severity ${e.severity}, satellites ${JSON.stringify(e.attributes.satellites)}` : 'no fire';
  };

  console.log('step                                         | wm applied beyond | fire after this frame');
  let before = '';
  let n = 0;
  for await (const raw of client.stream(0, new AbortController().signal)) {
    const frame: SatFrame = { offset: Number(raw.id), kind: 'detection', data: JSON.parse(raw.data) };
    await sink.apply([frame], ctx);
    const s = sink.engine.stats();
    const label = SCRIPT[n++][0];
    if (n === 2) before = await snapshot();
    console.log(`${label.padEnd(44)} | ${String(s.watermark?.slice(11, 16) ?? '-').padEnd(5)} ${String(s.lateApplied).padEnd(7)} ${String(s.lateBeyond).padEnd(6)} | ${await snapshot()}`);
  }
  const c = sink.engine.counters;
  const after = await snapshot();
  const checks: Array<[string, boolean]> = [
    ['fire before the late data: 2 detections', before.startsWith('2 detections')],
    ['in-bound late detections applied (C, F)', c.lateApplied === 2],
    ['beyond-bound detections counted, not merged (D, E)', c.lateBeyond === 2],
    ['fire after: 4 detections (A, B, C, F)', after.startsWith('4 detections')],
    ['beyond-bound detections reported in the log', sink.engine.lateLog.length === 2],
  ];
  console.log(`\nbefore: ${before}\nafter : ${after}\ncounters: ${JSON.stringify(c)}`);
  for (const [name, ok] of checks) console.log(`${name.padEnd(56)} ${ok ? 'PASS' : 'FAIL'}`);
  const failed = checks.filter((x) => !x[1]).length;
  console.log(failed === 0 ? '\nPASS: lateness handled on both sides of the bound' : `\nFAIL: ${failed}`);
  process.exit(failed === 0 ? 0 : 1);
})();
