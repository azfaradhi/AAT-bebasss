export const FUZZ_CASES = [
  'truncated_json', 'deep_nesting', 'invalid_utf8', 'huge_body', 'empty_body',
  'wrong_content_type', 'bom', 'nul_bytes', 'mixed_batch',
] as const;
export type FuzzCase = (typeof FUZZ_CASES)[number];

export interface FuzzResponse { contentType: string; body: Buffer }

const JSON_TYPE = 'application/json';
const good = (id: string) => ({
  report_id: id, volcano_id: 'v-merapi', alert_level: 'Siaga', eruption_count_24h: 2,
  ash_column_height_m: 1200, reported_at: '2026-10-04T00:00:00.000Z',
});

// Hostile or odd responses for the volcanic-reports endpoint, used to prove the aggregator survives them.
export function buildFuzzResponse(name: FuzzCase): FuzzResponse {
  switch (name) {
    case 'truncated_json':
      return { contentType: JSON_TYPE, body: Buffer.from('{"data":[{"report_id":"r-1","volcano_id":"v-mer') };
    case 'deep_nesting':
      return { contentType: JSON_TYPE, body: Buffer.from('['.repeat(10_000) + ']'.repeat(10_000)) };
    case 'invalid_utf8':
      return { contentType: JSON_TYPE, body: Buffer.from([0x7b, 0x22, 0x64, 0x61, 0x74, 0x61, 0x22, 0x3a, 0xc3, 0x28, 0x7d]) };
    case 'huge_body':
      return { contentType: JSON_TYPE, body: Buffer.from(`{"data":["${'x'.repeat(50 * 1024 * 1024)}"]}`) };
    case 'empty_body':
      return { contentType: JSON_TYPE, body: Buffer.alloc(0) };
    case 'wrong_content_type':
      return { contentType: 'text/html', body: Buffer.from('<html><body>maintenance</body></html>') };
    case 'bom':
      return { contentType: JSON_TYPE, body: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(JSON.stringify({ data: [good('bom-1')] }))]) };
    case 'nul_bytes':
      return { contentType: JSON_TYPE, body: Buffer.from('{"data":[],\u0000"x":1}') };
    case 'mixed_batch':
      return {
        contentType: JSON_TYPE,
        body: Buffer.from(JSON.stringify({
          data: [
            good('mix-1'),
            { ...good('mix-2'), volcano_id: undefined, volcano_code: 'v-merapi' },
            { ...good('mix-3'), alert_level: 'Siaga-II' },
            null,
            good('mix-5'),
            { ...good('mix-6'), eruption_count_24h: '2' },
          ],
        })),
      };
  }
}
