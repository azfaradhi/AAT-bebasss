import { createServer } from 'node:http';

// OpenAI-compatible stand-in for the LLM: switch its behaviour at runtime to show how the advisor copes.
// modes: normal | slow | dead | error | garbage | hallucinate | markup
export function startFakeLlm(opts = {}) {
  let mode = opts.mode ?? 'normal';
  const stats = { requests: 0, byMode: {} };
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/admin/mode' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => { mode = JSON.parse(body || '{}').mode ?? mode; res.end(JSON.stringify({ mode })); });
      return;
    }
    if (url.pathname === '/admin/stats') return res.end(JSON.stringify({ mode, ...stats }));
    if (!url.pathname.endsWith('/chat/completions')) { res.statusCode = 404; return res.end('{}'); }
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      stats.requests++;
      stats.byMode[mode] = (stats.byMode[mode] ?? 0) + 1;
      if (mode === 'dead') return req.socket.destroy();
      const facts = JSON.parse(JSON.parse(body).messages.at(-1).content);
      const reply = (text, delay = 0) => setTimeout(() => {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: text } }] }));
      }, delay);
      if (mode === 'error') { res.statusCode = 503; return res.end('{"error":"overloaded"}'); }
      if (mode === 'slow') return reply('terlalu lambat', 10_000);
      if (mode === 'garbage') { res.setHeader('content-type', 'application/json'); return res.end('{"choices": [ {"message": '); }
      if (mode === 'hallucinate') return reply(`Kebakaran besar di ${facts.provinsi} menewaskan 250 orang dan membakar 1200 hektar.`);
      if (mode === 'markup') return reply(`**${facts.provinsi}** lihat https://contoh.example`);
      return reply(`Terdapat ${facts.titik_panas} titik panas di ${facts.provinsi} dengan total FRP ${facts.total_frp_mw} MW (tingkat ${facts.tingkat}), terpantau oleh satelit ${facts.satelit.join(', ')}.`);
    });
  });
  return new Promise((resolve) => server.listen(opts.port ?? 0, '127.0.0.1', () => resolve({
    url: `http://127.0.0.1:${server.address().port}`, port: server.address().port, stats,
    setMode: (m) => { mode = m; }, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }),
  })));
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const s = await startFakeLlm({ port: Number(process.env.PORT ?? 8199), mode: process.env.MODE ?? 'normal' });
  console.log(`fake-llm on ${s.url} (POST /admin/mode {"mode": "normal|slow|dead|error|garbage|hallucinate|markup"})`);
}
