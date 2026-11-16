export interface RawFrame {
  id: string | null;
  event: string;
  data: string;
  // The frame exceeded the size cap and its data was dropped.
  oversized: boolean;
}

// Incremental Server-Sent Events parser: tolerates frames split across chunks, CRLF line ends and comment lines.
export class SseParser {
  private readonly decoder = new TextDecoder('utf-8');
  private buffer = '';
  private discarding = false;

  constructor(private readonly maxFrameChars = 262_144) {}

  push(chunk: Uint8Array): RawFrame[] {
    this.buffer += this.decoder.decode(chunk, { stream: true });
    const frames: RawFrame[] = [];
    for (;;) {
      const end = this.frameEnd();
      if (end === null) break;
      const block = this.buffer.slice(0, end.index);
      this.buffer = this.buffer.slice(end.index + end.length);
      if (this.discarding) {
        this.discarding = false;
        frames.push({ id: null, event: 'message', data: '', oversized: true });
      } else {
        const frame = parseBlock(block);
        if (frame) frames.push(frame);
      }
    }
    if (this.buffer.length > this.maxFrameChars) {
      this.buffer = '';
      this.discarding = true;
    }
    return frames;
  }

  private frameEnd(): { index: number; length: number } | null {
    const match = /\r?\n\r?\n/.exec(this.buffer);
    return match ? { index: match.index, length: match[0].length } : null;
  }
}

function parseBlock(block: string): RawFrame | null {
  let id: string | null = null;
  let event = 'message';
  const data: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (line === '' || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
    if (field === 'id') id = value;
    else if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
  }
  if (id === null && data.length === 0) return null;
  return { id, event, data: data.join('\n'), oversized: false };
}
