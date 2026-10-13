import { createServer } from 'node:http';
import { createHash } from 'node:crypto';

export async function startWebsiteFixture({ largeBytes = 9 * 1024 * 1024 } = {}) {
  const sockets = new Set(), wsSockets = new Set(), requests = [];
  const server = createServer((request, response) => {
    requests.push(request.url);
    if (request.url === '/quote') { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ price: 100, source: 'learning-fixture' })); return; }
    if (request.url === '/app.js') { response.writeHead(200, { 'content-type': 'application/javascript' }); response.end(`fetch('/quote').then(r=>r.json()).then(q=>document.querySelector('#http').textContent=q.price); const ws=new WebSocket('ws://'+location.host+'/prices?token=fixture-sensitive-value'); ws.onopen=()=>ws.send(JSON.stringify({method:'subscribe',code:'EXAMPLE'})); ws.onmessage=e=>document.querySelector('#stream').textContent=JSON.parse(e.data).price;`); return; }
    if (request.url === '/large.js') { response.writeHead(200, { 'content-type': 'application/javascript' }); response.end('/*' + 'x'.repeat(largeBytes) + '*/'); return; }
    if (request.url === '/never-load') return;
    if (request.url === '/challenge') { response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); response.end('<!doctype html><title>安全验证</title><p>安全验证：请输入验证码</p>'); return; }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><title>Learning quote fixture</title><h1>学习行情</h1><p id="http">loading</p><p id="stream">loading</p><img src="/never-load"><script src="/app.js"></script><script src="/large.js"></script>');
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  server.on('upgrade', (request, socket) => {
    const key = request.headers['sec-websocket-key'];
    if (!key || !request.url.startsWith('/prices')) return socket.destroy();
    wsSockets.add(socket); socket.on('error', () => {}); socket.on('close', () => wsSockets.delete(socket));
    const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const timer = setTimeout(() => { if (!socket.destroyed) { const text = Buffer.from(JSON.stringify({ price: 101, product: 'snapshot' })); socket.write(Buffer.concat([Buffer.from([0x81, text.length]), text])); } }, 100);
    socket.on('data', bytes => { if ((bytes[0] & 0x0f) === 8) { socket.write(Buffer.from([0x88, 0x00])); socket.end(); } });
    socket.on('close', () => clearTimeout(timer));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, requests, wsSockets,
    async close() { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); } };
}
