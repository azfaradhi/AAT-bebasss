import type { FireFacts, Flag } from './facts';

export interface LlmOptions { baseUrl: string; model: string; apiKey: string; timeoutMs: number; reasoningEffort?: string | null; fetchImpl?: typeof fetch }

export class LlmError extends Error {
  constructor(readonly kind: 'timeout' | 'http' | 'network' | 'shape', message: string) { super(message); }
}

const SYSTEM = [
  'Anda penyusun ringkasan situasi bencana untuk BNPB.',
  'Tulis TEPAT satu kalimat Bahasa Indonesia, faktual, maksimal 280 karakter.',
  'Gunakan hanya fakta pada data yang diberikan, sebut nama provinsi, jangan menambah angka, lokasi, atau penyebab lain.',
  'Jangan memakai tanda markdown, daftar, atau tautan. Balas dengan kalimatnya saja.',
].join(' ');

// OpenAI-compatible chat completion (Groq's free tier speaks it). Returns the raw text; the caller validates it.
export class LlmClient {
  constructor(private readonly o: LlmOptions) {}

  async summarize(f: FireFacts, flag: Flag): Promise<string> {
    const body = {
      model: this.o.model, temperature: 0.2, max_tokens: 400, // room for a reasoning model's hidden tokens
      ...(this.o.reasoningEffort ? { reasoning_effort: this.o.reasoningEffort } : {}),
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: JSON.stringify({ provinsi: f.province, titik_panas: f.count, satelit: f.satellites, total_frp_mw: f.frp, tingkat: f.severity, deteksi_pertama: f.earliest, pertumbuhan: flag.growth, alasan_penanda: flag.reasons }) },
      ],
    };
    let res: Response;
    try {
      res = await (this.o.fetchImpl ?? fetch)(`${this.o.baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.o.apiKey}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.o.timeoutMs),
      });
    } catch (err) {
      const name = (err as { name?: string }).name;
      throw new LlmError(name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network', name ?? 'network error');
    }
    if (!res.ok) throw new LlmError('http', `HTTP ${res.status}`);
    let json: unknown;
    try { json = await res.json(); } catch { throw new LlmError('shape', 'response is not JSON'); }
    const text = (json as { choices?: Array<{ message?: { content?: unknown } }> })?.choices?.[0]?.message?.content;
    if (typeof text !== 'string') throw new LlmError('shape', 'no message content');
    return text;
  }
}
