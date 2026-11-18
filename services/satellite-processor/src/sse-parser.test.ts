import { describe, expect, it } from 'vitest';
import { SseParser } from './sse-parser';

const bytes = (s: string) => new TextEncoder().encode(s);

describe('SseParser', () => {
  it('parses a frame split across chunks, with CRLF and comments', () => {
    const p = new SseParser();
    expect(p.push(bytes(': keepalive\r\nid: 7\r\nevent: det'))).toEqual([]);
    const frames = p.push(bytes('ection\r\ndata: {"a":1}\r\n\r\nid: 8\nevent: heartbeat\ndata: {}\n\n'));
    expect(frames.map((f) => [f.id, f.event, f.data])).toEqual([['7', 'detection', '{"a":1}'], ['8', 'heartbeat', '{}']]);
  });

  it('joins multi-line data and does not split a multi-byte character', () => {
    const p = new SseParser();
    const full = bytes('id: 1\ndata: a\ndata: €\n\n');
    expect(p.push(full.subarray(0, 17))).toEqual([]);
    expect(p.push(full.subarray(17))[0].data).toBe('a\n€');
  });

  it('flags an oversized frame without growing the buffer forever', () => {
    const p = new SseParser(100);
    expect(p.push(bytes(`id: 1\ndata: ${'x'.repeat(500)}`))).toEqual([]);
    const frames = p.push(bytes('\n\nid: 2\ndata: {}\n\n'));
    expect(frames[0]).toMatchObject({ oversized: true });
    expect(frames[1]).toMatchObject({ id: '2', oversized: false });
  });
});
