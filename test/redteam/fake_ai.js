// Stand-in for the Anthropic API that answers after a delay, so overlapping analyses really overlap.
const http = require('http'); const D = Number(process.env.FAKE_DELAY_MS || 1500);
http.createServer((q, r) => { const c = []; q.on('data', d => c.push(d)); q.on('end', () => setTimeout(() => { r.writeHead(200, { 'content-type': 'application/json' }); r.end(JSON.stringify({ content: [{ type: 'text', text: 'ok' }] })); }, D)); }).listen(Number(process.env.FAKE_AI_PORT || 4010), () => console.log('fake ai up'));
