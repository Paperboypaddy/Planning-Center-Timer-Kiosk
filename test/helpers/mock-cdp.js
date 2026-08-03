'use strict';

const http = require('http');
const { WebSocketServer } = require('ws');

// A minimal fake of Chromium's DevTools HTTP + WebSocket endpoints, enough to
// exercise the KioskDriver (CDP.List -> /json/list, CDP -> ws target) without a
// real browser.
function startMockCdp({ url, port = 0, empty = false } = {}) {
  const targets = [];
  const navigateLog = [];
  const commandLog = [];
  let nextId = 1;
  let nextFrameSession = 1;

  const server = http.createServer((req, res) => {
    if (req.url === '/json/list') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(targets));
      return;
    }
    if (req.url === '/json/version') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ Browser: 'MockBrowser/1.0', webSocketDebuggerUrl: 'ws://127.0.0.1:0/devtools/browser/bogus' }));
      return;
    }
    res.statusCode = 404;
    res.end('not found');
  });

  const wss = new WebSocketServer({ noServer: true });
  wss.on('connection', (ws) => {
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      let result = {};
      commandLog.push({ method: msg.method, params: msg.params || {} });
      if (msg.method === 'Page.navigate') {
        const target = targets.find((t) => t.id === ws.kioskTargetId);
        if (target) target.url = msg.params.url;
        navigateLog.push(msg.params.url);
      } else if (msg.method === 'Runtime.evaluate') {
        result = { result: { type: 'string', value: 'complete' } };
      }
      ws.send(JSON.stringify({ id: msg.id, result }));
    });
  });

  server.on('upgrade', (req, socket, head) => {
    const pathname = req.url.split('?')[0];
    const m = /\/devtools\/page\/([^/]+)/.exec(pathname);
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.kioskTargetId = m ? m[1] : null;
      wss.emit('connection', ws, req);
    });
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const bound = server.address().port;
      const state = {
        port: bound,
        server,
        wss,
        targets,
        navigateLog,
        commandLog,
        framesAcked: [],
        addTarget(tUrl = url || 'about:blank') {
          const id = `page-${nextId++}`;
          const target = {
            id,
            type: 'page',
            url: tUrl,
            title: 'kiosk',
            webSocketDebuggerUrl: `ws://127.0.0.1:${bound}/devtools/page/${id}`,
          };
          targets.push(target);
          return target;
        },
        // Push a Page.screencastFrame event to every connected client.
        pushFrame(params = {}) {
          const frame = {
            method: 'Page.screencastFrame',
            params: Object.assign({
              data: 'aGVsbG8=',
              metadata: { pageScaleFactor: 1, offsetX: 0, offsetY: 0, scrollOffsetX: 0, scrollOffsetY: 0 },
              sessionId: nextFrameSession++,
            }, params),
          };
          for (const c of wss.clients) c.send(JSON.stringify(frame));
        },
        setUrl(u) {
          const target = targets.find((t) => t.type === 'page');
          if (target) target.url = u;
        },
        close() {
          return new Promise((res) => {
            for (const c of wss.clients) c.terminate();
            wss.close();
            server.close(res);
          });
        },
        dropConnections() {
          for (const c of wss.clients) c.terminate();
        },
      };
      if (!empty) state.addTarget(url);
      resolve(state);
    });
  });
}

module.exports = { startMockCdp };
