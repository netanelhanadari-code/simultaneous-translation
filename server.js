const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const multer = require('multer');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/ws' });
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// ── Whisper transcription endpoint ────────────────────────────────────────────
app.post('/api/transcribe', upload.single('audio'), async (req, res) => {
  const { room, lang } = req.query;
  if (!req.file) return res.status(400).json({ error: 'No audio' });
  if (!process.env.OPENAI_API_KEY) return res.status(500).json({ error: 'No API key' });

  // Skip Whisper if no listeners — saves API cost
  const roomCheck = rooms.get(room);
  if (!roomCheck || roomCheck.listeners.size === 0) return res.json({ text: '' });

  try {
    const blob = new Blob([req.file.buffer], { type: req.file.mimetype || 'audio/webm' });
    const form = new FormData();
    form.append('file', blob, 'audio.webm');
    form.append('model', 'whisper-1');
    if (lang) form.append('language', lang.split('-')[0]);
    form.append('temperature', '0');
    form.append('prompt', 'محادثة عربية حية');

    const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + process.env.OPENAI_API_KEY },
      body: form
    });

    const data = await response.json();
    const text = (data.text || '').trim();
    if (!text) return res.json({ text: '' });

    // Filter known Whisper hallucinations
    const HALLUCINATIONS = ['اشتركوا في القناة', 'اشترك في القناة', 'subscribe to the channel', 'شكراً للمشاهدة', 'الحلقة القادمة'];
    if (HALLUCINATIONS.some(h => text.toLowerCase().includes(h.toLowerCase()))) {
      console.log('[whisper] hallucination filtered:', text);
      return res.json({ text: '' });
    }

    // Broadcast transcript to listeners in this room
    const roomData = rooms.get(room);
    if (roomData) {
      const msg = JSON.stringify({ type: 'original', text, sourceLang: lang ? lang.split('-')[0] : 'ar' });
      roomData.listeners.forEach(l => { if (l.readyState === WebSocket.OPEN) l.send(msg); });
    }

    res.json({ text });
  } catch (err) {
    console.error('Whisper error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Translation endpoint ──────────────────────────────────────────────────────
const TRANSLATION_SYSTEM_PROMPT = `אתה מתורגמן סימולטני של עומדים ביחד / نقف معاً, תנועה יהודית-ערבית משותפת בישראל.

כללים:
- תרגם נאמנה ומדויק — לא להוסיף, לא להחסיר, לא לרכך
- שמור על טון המדבר — אם נרגש, תרגם נרגש; אם קז'ואל, תרגם קז'ואל
- ערבית→עברית: הדובר מדבר בניב פלסטיני/בדווי — תרגם לעברית טבעית וברורה
- עברית→ערבית: השתמש בערבית ספרותית מודרנית (فصحى معاصرة)
- למונחים רגישים פוליטית — בחר את התרגום הנייטרלי ביותר
- החזר רק את הטקסט המתורגם, ללא הסברים

גלוסרי — השתמש תמיד בתרגומים הבאים:
עומדים ביחד = نقف معاً
תנועה = حراك
מאבק = نضال
הפגנה = مظاهرة
מחאה = احتجاج
סולידריות = تضامن
קמפיין = حملة
צדק חברתי = عدالة اجتماعية
שוויון = مساواة
שלום = سلام
שותפות יהודית-ערבית = شراكة يهودية-عربية
חיים משותפים = حياة مشتركة
בית סגול = البيت الليلكي
פעילים/ות = ناشطين/ناشطات
אסיפה ארצית = اجتماع قطري
התארגנות = تنظيم
מפגש = لقاء`;

app.get('/api/translate', async (req, res) => {
  const { text, from, to } = req.query;
  if (!text || !from || !to) return res.status(400).json({ error: 'Missing params' });
  if (from === to) return res.json({ text });
  console.log('[translate]', from, '->', to, '|', text.slice(0, 50));
  try {
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + process.env.OPENAI_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: TRANSLATION_SYSTEM_PROMPT },
          { role: 'user', content: text }
        ],
        temperature: 0,
        max_tokens: 500
      })
    });
    const d = await r.json();
    const translated = d.choices?.[0]?.message?.content?.trim();
    if (translated) { console.log('[translate] ok:', translated.slice(0, 50)); return res.json({ text: translated }); }
    console.log('[translate] gpt empty:', JSON.stringify(d));
  } catch(e) { console.log('[translate] gpt fail:', e.message); }
  res.json({ text });
});

app.use(express.static(path.join(__dirname, 'public')));

const rooms = new Map();

function getRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, { broadcaster: null, listeners: new Set(), initChunk: null, mimeType: null });
  }
  return rooms.get(roomId);
}

function cleanRoom(roomId) {
  const room = rooms.get(roomId);
  if (room && !room.broadcaster && room.listeners.size === 0) {
    rooms.delete(roomId);
    console.log('[~] Room ' + roomId + ' removed (empty)');
  }
}

function send(ws, obj) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function notifyBroadcaster(room) {
  if (room.broadcaster) send(room.broadcaster, { type: 'count', count: room.listeners.size });
}

function notifyAllListeners(room, obj) {
  room.listeners.forEach(ws => send(ws, obj));
}

wss.on('connection', (ws, req) => {
  const params = new URL(req.url, 'http://x').searchParams;
  const role   = params.get('role');
  const roomId = params.get('room');

  if (!roomId) { ws.close(1008, 'Missing room'); return; }

  const room = getRoom(roomId);

  if (role === 'broadcaster') {
    if (room.broadcaster && room.broadcaster.readyState === WebSocket.OPEN) {
      room.broadcaster.close(1000, 'Replaced by new broadcaster');
    }
    room.broadcaster = ws;
    room.initChunk   = null;
    room.mimeType    = null;
    console.log('[+] Broadcaster  room=' + roomId);

    ws.on('message', (data, isBinary) => {
      if (!isBinary) {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.type === 'meta') {
            room.mimeType = msg.mimeType;
          } else if (msg.type === 'original') {
            const raw = data.toString();
            room.listeners.forEach(l => {
              if (l.readyState === WebSocket.OPEN) l.send(raw);
            });
          }
        } catch (_) {}
        return;
      }
      if (!room.initChunk) room.initChunk = Buffer.from(data);
      room.listeners.forEach(l => {
        if (l.readyState === WebSocket.OPEN) l.send(data, { binary: true });
      });
    });

    ws.on('close', () => {
      if (room.broadcaster === ws) {
        room.broadcaster = null;
        room.initChunk   = null;
        room.mimeType    = null;
        console.log('[-] Broadcaster  room=' + roomId);
        notifyAllListeners(room, { type: 'ended' });
        cleanRoom(roomId);
      }
    });

    ws.on('error', err => console.error('Broadcaster error room=' + roomId + ':', err.message));
    send(ws, { type: 'ready', count: room.listeners.size });

  } else {
    room.listeners.add(ws);
    console.log('[+] Listener     room=' + roomId + '  total=' + room.listeners.size);
    notifyBroadcaster(room);

    const isBroadcasting = room.broadcaster && room.broadcaster.readyState === WebSocket.OPEN;
    send(ws, { type: 'status', broadcasting: isBroadcasting, mimeType: room.mimeType });

    if (isBroadcasting && room.initChunk) {
      ws.send(room.initChunk, { binary: true });
    }

    ws.on('close', () => {
      room.listeners.delete(ws);
      console.log('[-] Listener     room=' + roomId + '  total=' + room.listeners.size);
      notifyBroadcaster(room);
      cleanRoom(roomId);
    });

    ws.on('error', err => console.error('Listener error room=' + roomId + ':', err.message));
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('Simultaneous Translation Server running on port ' + PORT);
});
