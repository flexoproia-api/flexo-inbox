const WebSocket = require('ws');

let wss = null;
const watchers = new Map();

function init(server) {
  wss = new WebSocket.Server({ server, path: '/ws' });

  wss.on('connection', (ws) => {
    let watchingId = null;

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw);

        if (msg.type === 'watch') {
          if (watchingId && watchers.has(watchingId)) {
            watchers.get(watchingId).delete(ws);
          }
          watchingId = msg.convId;
          if (!watchers.has(watchingId)) watchers.set(watchingId, new Set());
          watchers.get(watchingId).add(ws);
          ws.send(JSON.stringify({ type: 'watching', convId: watchingId }));
        }

        if (msg.type === 'ping') {
          ws.send(JSON.stringify({ type: 'pong' }));
        }
      } catch {}
    });

    ws.on('close', () => {
      if (watchingId && watchers.has(watchingId)) {
        watchers.get(watchingId).delete(ws);
      }
    });

    ws.on('error', () => {});
  });

  setInterval(() => {
    wss.clients.forEach(ws => {
      if (ws.readyState === WebSocket.OPEN) ws.ping();
    });
  }, 30000);
}

function notifyConversation(convId, payload) {
  const clients = watchers.get(convId);
  if (!clients || clients.size === 0) return;
  const msg = JSON.stringify({ type: 'update', convId, ...payload });
  clients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  });
}

function broadcast(payload) {
  if (!wss) return;
  const msg = JSON.stringify(payload);
  wss.clients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  });
}

module.exports = { init, notifyConversation, broadcast };
