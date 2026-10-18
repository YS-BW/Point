import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';

export async function browserFixture() {
  const saves = [];
  const cookie = `point-test-${randomUUID()}`;
  const visits = [];
  const server = createServer(async (request, response) => {
    if (request.url === '/save' && request.method === 'POST') {
      let body = ''; for await (const chunk of request) body += chunk;
      saves.push(body); response.writeHead(200, { 'content-type': 'text/plain' }); response.end('Saved: ' + body); return;
    }
    visits.push({ path: request.url, cookie: request.headers.cookie ?? '' });
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'set-cookie': `point_fixture=${cookie}; Path=/; Max-Age=3600` });
    response.end(`<!doctype html><html><head><title>Point Steel acceptance</title></head><body>
      <h1>${request.url === '/next' ? 'Browser next page' : 'Browser acceptance'}</h1><label>Note <input name="note"></label><button id="save">Save note</button>
      <label>Password <input name="password" type="password" value="do-not-return-this-password"></label>
      <p id="result">Not saved</p><p id="storage"></p><a href="/next">Next page</a>
      <div id="video-marker" style="position:fixed;right:10px;top:10px;width:40px;height:40px;background:${request.url === '/next' ? 'rgb(0,0,255)' : 'rgb(255,0,0)'}" aria-hidden="true"></div>
      <script>if(!localStorage.getItem('point-marker'))localStorage.setItem('point-marker','stored-'+Math.random());
      document.querySelector('#storage').textContent='Storage: '+localStorage.getItem('point-marker');
      document.querySelector('#save').onclick=async()=>{const r=await fetch('/save',{method:'POST',body:document.querySelector('[name=note]').value});document.querySelector('#result').textContent=await r.text();document.querySelector('#video-marker').style.background='rgb(0,255,0)'};
      </script></body></html>`);
  });
  server.listen(0, '0.0.0.0'); await once(server, 'listening');
  const port = server.address().port;
  return { url: `http://host.docker.internal:${port}/`, saves, cookie, visits,
    close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }) };
}
