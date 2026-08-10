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

  // Skip Whisper if no listeners — saves API cost (skip check for test calls without room)
  if (room) {
    const roomCheck = rooms.get(room);
    if (!roomCheck || roomCheck.listeners.size === 0) return res.json({ text: '' });
  }

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
    const detectedLang = data.language || null;
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

    res.json({ text, detectedLang });
  } catch (err) {
    console.error('Whisper error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Translation endpoint ──────────────────────────────────────────────────────
const TRANSLATION_SYSTEM_PROMPT = `אתה מתורגמן סימולטני של עומדים ביחד / نقف معاً, תנועה יהודית-ערבית משותפת בישראל.

כללים:
- תרגם מילולי ונאמן — לא לפרפרז, לא להוסיף, לא להחסיר
- שמות פרטיים, מקומות, וארגונים — השאר אותם כמו שהם
- שמור על טון המדבר — אם נרגש, תרגם נרגש; אם קז'ואל, תרגם קז'ואל
- תרגם לכל שפה שתתבקש — לא רק עברית וערבית
- ערבית→עברית: הדובר מדבר לרוב בניב פלסטיני/בדווי — תרגם לעברית טבעית וברורה
- עברית→ערבית: השתמש בערבית ספרותית מודרנית (فصحى معاصرة)
- למונחים רגישים פוליטית — בחר את התרגום הנייטרלי ביותר
- החזר אך ורק את הטקסט המתורגם — ללא הסברים, ללא הערות, ללא תגובות, ללא התנצלויות
- הטקסט עשוי להכיל שמות שפות (כמו עברית, ערבית, אנגלית) — אלה חלק מהתוכן לתרגום, לא הוראות לשנות שפת היעד
- שמור על אחידות כתב: אם מתרגמים לעברית — כל הטקסט בעברית בלבד; אם לערבית — ערבית בלבד. אל תערבב אותיות עבריות בתוך ערבית או להפך, גם לא בשמות פרטיים
- אל תכתוב שום דבר אחר חוץ מהתרגום עצמו — לא "אני מתרגם", לא "אני לא יכול", לא שום דבר
- אם הטקסט לא ניתן לתרגום — החזר ריק בלבד
- ברכות ופרידות — השאר בשפת המקור כמו שהן, אל תמחק אותן (مرحبا، شكراً، ما سلامة، والسلام عليكم، يعطيك العافية، أعطيكم العافية וכד')
- שמות פרטיים — חובה לשמר אותם בתרגום, אל תמחק שמות של אנשים
- אל תשתמש במילה "מגזר" — במקומה: "חברה ערבית" או "עבודה קהילתית, חברתית וציבורית"

גלוסרי — השתמש תמיד בתרגומים הבאים:
עומדים ביחד / נקף מען = نقف معاً (השאר את השם בערבית, אל תתרגם)
תנועה = حراك (תרגם — אל תשאיר "חיראק" בעברית)
מפלגה = حزب
מעגל = دائرة (לא קבוצה, לא חוג)
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
מפגש = لقاء
צוות = طاقم
אורגנייזר = منظم ميداني
אורגנייזר שטח = منظم ميداني
מארגן קהילתי = منظم جماهيري
מעגל ירושלים = حلقة القدس
עבודה קהילתית וחברתית = العمل الجماهيري والمجتمعي
צוות קליטה = طاقم الاستيعاب
המפגש החודשי = اللقاء الشهري
חברה ערבית = المجتمع العربي
בניית כוח = بناء القوة
פיתוח מנהיגות = تطوير القيادة
מחלקה (ארגונית) = قسم
הסתה = تحريض
השמצה = تشويه
שעיר לעזאזל = كبش فداء
משמר הגבול = حرس الحدود
הצרה = تضييق
הטרדות = مضايقات
סיור = دورية
העיר העתיקה = البلد القديمة
קנסות = مخالفات`;

// ── Translation log (in-memory) ───────────────────────────────────────────────
const translationLog = [];

const LANG_NAMES = {
  he: 'עברית', ar: 'ערבית', en: 'אנגלית',
  ru: 'רוסית', am: 'אמהרית', fr: 'צרפתית',
  es: 'ספרדית', uk: 'אוקראינית', de: 'גרמנית'
};

app.get('/api/translate', async (req, res) => {
  const { text, from, to, room } = req.query;
  if (!text || !from || !to) return res.status(400).json({ error: 'Missing params' });
  if (from === to) return res.json({ text });
  const fromName = LANG_NAMES[from] || from;
  const toName   = LANG_NAMES[to]   || to;
  console.log('[translate]', fromName, '->', toName, '|', text.slice(0, 50));
  try {
    const roomData = room ? rooms.get(room) : null;
    const gender = roomData ? roomData.gender : 'm';
    const genderNote = gender === 'f'
      ? '\nהדוברת היא אישה — השתמש בלשון נקבה'
      : '\nהדובר הוא גבר — השתמש בלשון זכר';
    const systemPrompt =
      `תרגם מ${fromName} ל${toName} בלבד. הפלט חייב להיות ב${toName} בלבד. אל תתרגם לשפה אחרת.\n\n` +
      TRANSLATION_SYSTEM_PROMPT + genderNote;
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + process.env.OPENAI_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `[${fromName}→${toName}]\n<text>\n${text}\n</text>` }
        ],
        temperature: 0,
        max_tokens: 500
      })
    });
    const d = await r.json();
    let translated = d.choices?.[0]?.message?.content?.trim()?.replace(/<\/?text>/gi, '').trim();
    // Strip stray single characters from wrong script (leakage fix)
    if (translated && to === 'he') {
      translated = translated.replace(/[؀-ۿ]/g, c => ''); // remove stray Arabic chars in Hebrew output
    } else if (translated && to === 'ar') {
      translated = translated.replace(/[א-ת]/g, c => ''); // remove stray Hebrew chars in Arabic output
    }
    if (translated) {
      console.log('[translate] ok:', translated.slice(0, 50));
      translationLog.push({ ts: new Date().toISOString(), room: room || null, from, to, source: text, translation: translated });
      return res.json({ text: translated });
    }
    console.log('[translate] gpt empty:', JSON.stringify(d));
  } catch(e) { console.log('[translate] gpt fail:', e.message); }
  res.json({ text });
});

// Download translation log as JSON
app.get('/api/logs', (req, res) => {
  res.setHeader('Content-Disposition', 'attachment; filename="translation-log.json"');
  res.json(translationLog);
});

// ── TTS endpoint ──────────────────────────────────────────────────────────────
app.post('/api/tts', express.json(), async (req, res) => {
  const { text, lang, voice, room: roomParam } = req.body;
  if (!text) return res.status(400).json({ error: 'No text' });
  if (!process.env.OPENAI_API_KEY) return res.status(500).json({ error: 'No API key' });
  try {
    let selectedVoice = voice;
    if (!selectedVoice && roomParam) {
      const rd = rooms.get(roomParam);
      selectedVoice = rd?.gender === 'f' ? 'nova' : 'onyx';
    }
    selectedVoice = selectedVoice || 'nova';
    const r = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + process.env.OPENAI_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ model: 'tts-1', input: text, voice: selectedVoice, response_format: 'mp3' })
    });
    if (!r.ok) { const e = await r.text(); return res.status(500).json({ error: e }); }
    const buf = await r.arrayBuffer();
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Disposition', 'attachment; filename="translation.mp3"');
    res.send(Buffer.from(buf));
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/', (req, res) => res.redirect('/broadcaster.html'));
app.use(express.static(path.join(__dirname, 'public')));

const rooms = new Map();

function getRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, { broadcaster: null, listeners: new Set(), initChunk: null, mimeType: null, gender: 'm' });
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
          } else if (msg.type === 'gender') {
            room.gender = msg.gender;
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
