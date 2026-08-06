const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/ws' });

app.use(express.static(path.join(__dirname, 'public')));

// ── State ──────────────────────────────────────────────────────────────────
let broadcaster = null;
const listeners = new Set();
let initChunk = null;   // First webm chunk — contains the stream header
let mimeType = null;    // Codec reported by broadcaster

// ── Helpers ────────────────────────────────────────────────────────────────
function send(ws, obj) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function notifyBroadcaster() {
  if (broadcaster) send(broadcaster, { type: 'count', count: listeners.size });
}

function notifyAllListeners(obj) {
  listeners.forEach(ws => send(ws, obj));
}

// ── WebSocket handler ──────────────────────────────────────────────────────
wss.on('connection', (ws, req) => {
  const params = new URL(req.url, 'http://x').searchParams;
  const role = params.get('role');

  // ── BROADCASTER ──────────────────────────────────────────────────────────
  if (role === 'broadcaster') {
    // Replace any existing broadcaster
    if (broadcaster?.readyState === WebSocket.OPEN) {
      broadcaster.close(1000, 'Replaced by new broadcaster');
    }
    broadcaster = ws;
    initChunk = null;
    mimeType = null;
    console.log('[+] Broadcaster connected');

    ws.on('message', (data, isBinary) => {
      if (!isBinary) {
        // Text message: metadata or AI translation
        try {
          const msg = JSON.parse(data.toString());
          if (msg.type === 'meta') {
            mimeType = msg.mimeType;
          } else if (msg.type === 'translation') {
            // Relay translated text to all listeners
            const raw = data.toString();
            listeners.forEach(listener => {
              if (listener.readyState === WebSocket.OPEN) listener.send(raw);
            });
          }
        } catch (_) {}
        return;
      }

      // First binary chunk = webm init segment (header + first cluster)
      if (!initChunk) {
        initChunk = Buffer.from(data);
      }

      // Relay audio to all listeners
      listeners.forEach(listener => {
        if (listener.readyState === WebSocket.OPEN) {
          listener.send(data, { binary: true });
        }
      });
    });

    ws.on('close', () => {
      if (broadcaster === ws) {
        broadcaster = null;
        initChunk = null;
        mimeType = null;
        console.log('[-] Broadcaster disconnected');
        notifyAllListeners({ type: 'ended' });
      }
    });

    ws.on('error', err => console.error('Broadcaster error:', err.message));

    // Confirm ready
    send(ws, { type: 'ready', count: listeners.size });

  // ── LISTENER ─────────────────────────────────────────────────────────────
  } else {
    listeners.add(ws);
    console.log(`[+] Listener connected  (total: ${listeners.size})`);
    notifyBroadcaster();

    const isBroadcasting = broadcaster?.readyState === WebSocket.OPEN;
    send(ws, { type: 'status', broadcasting: isBroadcasting, mimeType });

    // Send init chunk so late-joining listener can decode the stream
    if (isBroadcasting && initChunk) {
      ws.send(initChunk, { binary: true });
    }

    ws.on('close', () => {
      listeners.delete(ws);
      console.log(`[-] Listener disconnected (total: ${listeners.size})`);
      notifyBroadcaster();
    });

    ws.on('error', err => console.error('Listener error:', err.message));
  }
});

// ── Start ──────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🎙️  Simultaneous Translation Server`);
  console.log(`   http://localhost:${PORT}\n`);
  console.log(`   Broadcaster → http://localhost:${PORT}/broadcaster.html`);
  console.log(`   Listener    → http://localhost:${PORT}/listener.html\n`);
});
