// Stand-in for the Anthropic API that answers after a delay, so overlapping analyses really overlap.
// Plain requests get one JSON answer. Requests with stream:true get Anthropic-style server-sent events, one piece at a time.
// Prompt markers choose a failure: FAIL_BEFORE_TEXT answers 529 before any text; DIE_MID sends one piece and then cuts the connection.
const http = require('http'); const D = Number(process.env.FAKE_DELAY_MS || 1500);
const sse = (r, type, data) => r.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
http.createServer((q, r) => {
  const c = []; q.on('data', d => c.push(d));
  q.on('end', () => {
    let body = {}; try { body = JSON.parse(Buffer.concat(c).toString()); } catch (_) {}
    const prompt = String(body.messages?.[0]?.content || '');
    if (!body.stream) return setTimeout(() => { r.writeHead(200, { 'content-type': 'application/json' }); r.end(JSON.stringify({ content: [{ type: 'text', text: 'ok' }] })); }, D);
    if (prompt.includes('FAIL_BEFORE_TEXT')) { r.writeHead(529, { 'content-type': 'application/json' }); return r.end(JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } })); }
    r.writeHead(200, { 'content-type': 'text/event-stream' });
    sse(r, 'message_start', { message: { id: 'm1' } });
    const pieces = ['VERDICT: OVER\n', 'FULL ANALYSIS: streamed ', 'text.'];
    let i = 0;
    const next = () => {
      if (i >= pieces.length) { sse(r, 'message_stop', {}); return r.end(); }
      sse(r, 'content_block_delta', { index: 0, delta: { type: 'text_delta', text: pieces[i++] } });
      if (prompt.includes('DIE_MID')) return setTimeout(() => r.destroy(), 100);
      setTimeout(next, Math.max(150, D / 5));
    };
    setTimeout(next, 100);
  });
}).listen(Number(process.env.FAKE_AI_PORT || 4010), () => console.log('fake ai up'));
