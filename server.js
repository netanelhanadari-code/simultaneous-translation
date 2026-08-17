const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const multer = require('multer');
const webpush = require('web-push');

// ── Web Push (VAPID) ─────────────────────────────────────────────────────────
const VAPID_PUBLIC  = process.env.VAPID_PUBLIC_KEY  || '';
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY || '';
const VAPID_EMAIL   = process.env.VAPID_EMAIL       || 'mailto:admin@example.com';
if (VAPID_PUBLIC && VAPID_PRIVATE) {
  webpush.setVapidDetails(VAPID_EMAIL, VAPID_PUBLIC, VAPID_PRIVATE);
}
// ── Twilio (SMS OTP) ─────────────────────────────────────────────────────────
const TWILIO_SID   = process.env.TWILIO_ACCOUNT_SID || '';
const TWILIO_TOKEN = process.env.TWILIO_AUTH_TOKEN  || '';
const TWILIO_FROM  = process.env.TWILIO_FROM        || '';
let twilioClient = null;
if (TWILIO_SID && TWILIO_TOKEN) {
  try { twilioClient = require('twilio')(TWILIO_SID, TWILIO_TOKEN); console.log('[twilio] initialized'); }
  catch(e) { console.warn('[twilio] not installed:', e.message); }
}
const otpStore = new Map(); // phone -> { code, expires, attempts, sendCount }
function generateOTP() { return String(Math.floor(100000 + Math.random() * 900000)); }

// ── Supabase REST helpers ────────────────────────────────────────────────────
const SB_RAW = process.env.SUPABASE_URL || '';
const SB_URL = SB_RAW.replace(/\/rest\/v1\/?$/, ''); // strip trailing /rest/v1 if user pasted full URL
const SB_KEY = process.env.SUPABASE_ANON_KEY;
const sbHeaders = () => ({
  'apikey': SB_KEY,
  'Authorization': 'Bearer ' + SB_KEY,
  'Content-Type': 'application/json'
});
async function sbInsert(table, data) {
  if (!SB_URL) return null;
  const url = `${SB_URL}/rest/v1/${table}`;
  console.log('[supabase] POST', url.replace(/\/\/[^.]+/, '//***'));
  const r = await fetch(url, {
    method: 'POST',
    headers: { ...sbHeaders(), 'Prefer': 'return=representation' },
    body: JSON.stringify(data)
  });
  const text = await r.text();
  if (!r.ok) { console.error(`[supabase] INSERT ${table}:`, text); return null; }
  try { const arr = JSON.parse(text); return arr[0] || null; } catch { return null; }
}
async function sbQuery(table, qs) {
  if (!SB_URL) return [];
  const r = await fetch(`${SB_URL}/rest/v1/${table}?${qs}`, { headers: sbHeaders() });
  if (!r.ok) return [];
  try { return await r.json(); } catch { return []; }
}

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
- תרגם לפי משמעות ולא מילה במילה — שמור על כוונת הדובר ועל הזרימה הטבעית בשפת היעד
- ביטויים דיבוריים וסלנג — תרגם לביטוי מקביל בשפת היעד, לא לפי הפירוש המילולי
- לא להוסיף מידע שלא נאמר, לא לקצר תוכן
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

app.get('/', (req, res) => res.redirect('/home.html'));
app.use(express.static(path.join(__dirname, 'public')));

// ── Persistent Rooms (IM mode) ────────────────────────────────────────────────

function makeRoomId() {
  return Math.random().toString(36).slice(2, 7).toUpperCase();
}

// Room names (translated) for a list of room IDs — used by home.html
app.get('/api/rooms/names', async (req, res) => {
  const ids = (req.query.ids || '').split(',').map(s => s.trim()).filter(Boolean).slice(0, 20);
  if (!ids.length || !SB_URL) return res.json({});
  const result = {};
  await Promise.all(ids.map(async id => {
    if (id.startsWith('D')) return; // skip DMs
    try {
      const rows = await sbQuery('rooms', `id=eq.${id}&select=id,name,names&limit=1`);
      const room = rows[0];
      if (!room) return;
      let names = room.names || {};
      if (!names.he || !names.ar || !names.en) {
        // backfill missing languages
        await Promise.all(['he', 'ar', 'en'].map(async lang => {
          if (!names[lang]) names[lang] = await translateRoomName(room.name, null, lang);
        }));
        fetch(`${SB_URL}/rest/v1/rooms?id=eq.${id}`, {
          method: 'PATCH',
          headers: { ...sbHeaders(), 'Prefer': 'return=minimal' },
          body: JSON.stringify({ names })
        }).catch(() => {});
      }
      result[id] = names;
    } catch(e) {}
  }));
  res.json(result);
});

// Latest message timestamp per room (for unread detection)
app.get('/api/rooms/latest', async (req, res) => {
  const ids = (req.query.ids || '').split(',').map(s => s.trim()).filter(Boolean).slice(0, 20);
  if (!ids.length || !SB_URL) return res.json({});
  const result = {};
  await Promise.all(ids.map(async id => {
    try {
      const msgs = await sbQuery('messages', `room_id=eq.${id}&order=created_at.desc&limit=1&select=created_at`);
      if (msgs[0]?.created_at) result[id] = msgs[0].created_at;
    } catch(e) {}
  }));
  res.json(result);
});

// DM room — deterministic ID for a pair of users (lazy: no DB creation until first message)
app.get('/api/dm', async (req, res) => {
  const { from, to } = req.query;
  if (!from || !to) return res.status(400).json({ error: 'Missing params' });
  const sorted = [from, to].sort();
  let hash = 0;
  const str = sorted.join('|');
  for (let i = 0; i < str.length; i++) hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  const id = 'D' + Math.abs(hash).toString(36).toUpperCase().slice(0, 5);
  res.json({ id });
});

// Translate a member's display name to another language.
// Handles transliteration + semantic meaning (e.g. "נתי המלך בצפון" → "Nati, King of the North")
async function translateMemberName(name, toLang) {
  if (!name || !process.env.OPENAI_API_KEY) return name;
  const toName = LANG_NAMES[toLang] || toLang;
  const systemPrompt = `You are a name translator. The input is a person's display name — it may be a plain name, a nickname, or a name with a title/description (e.g. "Nati King of the North" or "נתי המלך בצפון").
Translate or transliterate it to ${toName}:
- Transliterate the personal name phonetically
- Translate any titles, descriptions, or words that carry meaning
- Output ONLY the result, nothing else — no quotes, no explanations`;
  try {
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + process.env.OPENAI_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: name }],
        temperature: 0.2, max_tokens: 60
      })
    });
    const d = await r.json();
    return d.choices?.[0]?.message?.content?.trim() || name;
  } catch(e) { return name; }
}

// Upsert user_profiles — keeps name/lang/emoji fresh on every WS join
async function upsertUserProfile(phone, name, lang, emoji) {
  if (!phone || !SB_URL) return;
  try {
    const existing = await sbQuery('user_profiles', `phone=eq.${encodeURIComponent(phone)}&limit=1`);
    if (existing.length) {
      await fetch(`${SB_URL}/rest/v1/user_profiles?phone=eq.${encodeURIComponent(phone)}`, {
        method: 'PATCH', headers: { ...sbHeaders(), 'Prefer': 'return=minimal' },
        body: JSON.stringify({ name, lang, emoji, updated_at: new Date().toISOString() })
      });
    } else {
      await sbInsert('user_profiles', { phone, name, lang, emoji, name_translations: {} });
    }
  } catch(e) { console.error('[upsertUserProfile]', e.message); }
}

// Ensure a member has a name_translation for targetLang — translate and persist if missing
async function ensureNameTranslation(phone, name, targetLang) {
  if (!phone || !name || !SB_URL || !process.env.OPENAI_API_KEY) return;
  try {
    const profiles = await sbQuery('user_profiles', `phone=eq.${encodeURIComponent(phone)}&select=name_translations&limit=1`);
    const current = profiles[0]?.name_translations || {};
    if (current[targetLang]) return; // already cached
    const translated = await translateMemberName(name, targetLang);
    const updated = { ...current, [targetLang]: translated };
    await fetch(`${SB_URL}/rest/v1/user_profiles?phone=eq.${encodeURIComponent(phone)}`, {
      method: 'PATCH', headers: { ...sbHeaders(), 'Prefer': 'return=minimal' },
      body: JSON.stringify({ name_translations: updated })
    });
  } catch(e) { console.error('[ensureNameTranslation]', e.message); }
}

// Check if a phone belongs to an admin of a room
async function isRoomAdmin(roomId, phone) {
  if (!phone || !SB_URL) return false;
  const rows = await sbQuery('room_members', `room_id=eq.${roomId}&phone=eq.${encodeURIComponent(phone)}&is_admin=eq.true&limit=1`).catch(() => []);
  return rows.length > 0;
}

// Translate a short name string (for room names only — lightweight prompt)
// fromLang is optional — if omitted, GPT auto-detects source language
async function translateRoomName(text, fromLang, toLang) {
  if (!text || !process.env.OPENAI_API_KEY) return text;
  if (fromLang && fromLang === toLang) return text;
  const toName = LANG_NAMES[toLang] || toLang;
  const systemPrompt = fromLang
    ? `תרגם את שם הקבוצה הבא מ${LANG_NAMES[fromLang]||fromLang} ל${toName}. החזר רק את התרגום, ללא הסברים.`
    : `תרגם את שם הקבוצה הבא ל${toName}. זהה את שפת המקור בעצמך. החזר רק את התרגום, ללא הסברים.`;
  try {
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + process.env.OPENAI_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: text }
        ],
        temperature: 0, max_tokens: 60
      })
    });
    const d = await r.json();
    return d.choices?.[0]?.message?.content?.trim() || text;
  } catch(e) { return text; }
}

// Create room
app.post('/api/rooms', express.json(), async (req, res) => {
  const { name, lang, creator_phone } = req.body;
  if (!name) return res.status(400).json({ error: 'Missing name' });
  const id = makeRoomId();
  const fromLang = lang || 'he';

  // Translate name to ar + en + he (whichever are missing) in parallel
  const names = { [fromLang]: name };
  const targets = ['he', 'ar', 'en'].filter(l => l !== fromLang);
  await Promise.all(targets.map(async toLang => {
    names[toLang] = await translateRoomName(name, fromLang, toLang);
  }));

  await sbInsert('rooms', { id, name, names, ...(creator_phone ? { creator_phone } : {}) });

  // Insert welcome messages
  const now = Date.now();
  const WELCOME = [
    {
      sender_name: 'Worf', sender_emoji: '🖖', sender_lang: 'tlh',
      original_text: 'nuqneH! *The Hitchhiker\'s Guide to the Galaxy* lut ghaj babel-ghotI\' — mach \'ej Hoch Hol Dayajmogh. naDev yIn — Babel Fish (babel-ghotI\'). Hoch mu\'tlhegh DaQoybogh, Hol laDlu\' qoj jatlhlu\'. Qapla\'!',
      translations: {
        he: 'בספר \'מדריך הטרמפיסט לגלקסיה\' מסופר על דג קטן ומדהים — שכאשר מכניסים אותו לאוזן, הוא מתרגם כל דבר ששומעים. ברוכים הבאים לבייבל פיש (דג בבל) — האפליקציה שמתרגמת כל הודעה בזמן אמת לשפה שלך.',
        ar: 'في كتاب \'دليل المسافر عبر المجرة\' تُحكى قصة سمكة صغيرة رائعة — عندما تُدخلها في أذنك تترجم كل ما تسمعه. مرحباً بكم في Babel Fish (سمكة بابل) — التطبيق الذي يترجم كل رسالة في الوقت الفعلي إلى لغتك.',
        en: 'In \'The Hitchhiker\'s Guide to the Galaxy\', there\'s a story about a small, amazing fish — put it in your ear and it translates everything you hear. Welcome to Babel Fish (the fish of Babel) — the app that translates every message in real time into your language.',
        ru: 'В книге \'Автостопом по галактике\' рассказывается о маленькой удивительной рыбке — вложи её в ухо, и она переводит всё, что слышишь. Добро пожаловать в Babel Fish (Вавилонская рыбка) — приложение, которое переводит каждое сообщение в реальном времени на твой язык.',
        am: 'በ\'The Hitchhiker\'s Guide to the Galaxy\' ውስጥ ስለ ትንሽ አስደናቂ ዓሣ ይነገራል — ወደ ጆሮዎ ካስገቡት ሁሉንም የሚሰሙትን ይተረጉምልዎታል። ወደ Babel Fish (የባቤል ዓሣ) እንኳን ደህና መጡ — እያንዳንዷን ቋንቋ ወዳዎ በቅጽበት የሚተረጉም መተግበሪያ።',
      },
      created_at: new Date(now).toISOString(),
    },
    {
      sender_name: 'יעל', sender_emoji: '👩🏽', sender_lang: 'he',
      original_text: 'לחצו על כפתור המיקרופון 🎤 לשליחת הודעה קולית · הקלידו ⌨️ כדי לכתוב הודעה',
      translations: {
        ar: 'اضغطوا على زر الميكروفون 🎤 لإرسال رسالة صوتية · اكتبوا ⌨️ لإرسال رسالة نصية',
        en: 'Tap the microphone button 🎤 to send a voice message · Type ⌨️ to write a message',
        ru: 'Нажмите кнопку микрофона 🎤 для голосового сообщения · Введите текст ⌨️ для написания',
        am: 'የድምፅ መልዕክት ለመላክ 🎤 누르ኑ · ⌨️ ፃፉ መልዕክት ለመፃፍ',
      },
      created_at: new Date(now + 1000).toISOString(),
    },
    {
      sender_name: 'ليلى', sender_emoji: '👩🏻‍🦱', sender_lang: 'ar',
      original_text: 'اضغطوا على 🔊 في أي رسالة لسماعها بلغتكم',
      translations: {
        he: 'לחצו על 🔊 בכל הודעה כדי לשמוע אותה בשפה שלכם',
        en: 'Tap 🔊 on any message to hear it in your language',
        ru: 'Нажмите 🔊 в любом сообщении, чтобы услышать его на своём языке',
        am: 'ማንኛውም መልዕክት በቋንቋዎ ለመስማት 🔊 누르ኑ',
      },
      created_at: new Date(now + 2000).toISOString(),
    },
    {
      sender_name: 'Alex', sender_emoji: '👨🏻', sender_lang: 'en',
      original_text: 'Tap 🌐 on any message to see the original language it was written in',
      translations: {
        he: 'לחצו על 🌐 בכל הודעה כדי לראות את השפה המקורית שבה היא נכתבה',
        ar: 'اضغطوا على 🌐 في أي رسالة لرؤية اللغة الأصلية التي كُتبت بها',
        ru: 'Нажмите 🌐 в любом сообщении, чтобы увидеть язык оригинала',
        am: 'ማንኛውም መልዕክት የተፃፈበትን ቋንቋ ለማየት 🌐 누르ኑ',
      },
      created_at: new Date(now + 3000).toISOString(),
    },
  ];
  await Promise.all(WELCOME.map(msg => sbInsert('messages', { room_id: id, ...msg }).catch(() => {})));

  res.json({ id, name, names, creator_phone: creator_phone || '' });
});

// Get room + history
app.get('/api/rooms/:id', async (req, res) => {
  const { id } = req.params;
  if (!SB_URL) return res.json({ id, name: id, messages: [] });
  try {
    const roomRows = await sbQuery('rooms', `id=eq.${id}&limit=1`);
    let room = roomRows[0];
    const messages = (await sbQuery('messages', `room_id=eq.${id}&order=created_at.desc&limit=500`)).reverse();
    const allMembers = await sbQuery('room_members', `room_id=eq.${id}&order=last_seen.desc`);

    // Enrich allMembers with name_translations from user_profiles
    const phones = (allMembers || []).map(m => m.phone).filter(Boolean);
    if (phones.length > 0 && SB_URL) {
      const profiles = await sbQuery('user_profiles',
        `phone=in.(${phones.map(p => encodeURIComponent(p)).join(',')})&select=phone,name_translations`
      ).catch(() => []);
      const profMap = {};
      profiles.forEach(p => { profMap[p.phone] = p.name_translations || {}; });
      allMembers.forEach(m => { m.name_translations = profMap[m.phone] || {}; });
    }

    // Lazy backfill: translate names for existing rooms that don't have them yet
    if (room && SB_URL && (!room.names || Object.keys(room.names).length === 0) && !id.startsWith('D')) {
      const names = {};
      await Promise.all(['he', 'ar', 'en'].map(async toLang => {
        names[toLang] = await translateRoomName(room.name, null, toLang);
      }));
      fetch(`${SB_URL}/rest/v1/rooms?id=eq.${id}`, {
        method: 'PATCH',
        headers: { ...sbHeaders(), 'Prefer': 'return=minimal' },
        body: JSON.stringify({ names })
      }).catch(() => {});
      room = { ...room, names };
    }

    res.json({ id, name: room?.name || id, ...room, messages: messages || [], allMembers: allMembers || [] });
  } catch(e) {
    console.error('getRoom error:', e.message);
    res.json({ id, name: id, messages: [] });
  }
});

// Rename room — update names JSONB
app.patch('/api/rooms/:id/name', express.json(), async (req, res) => {
  const { id } = req.params;
  const { names } = req.body; // { he, ar, en }
  if (!names || typeof names !== 'object') return res.status(400).json({ error: 'Missing names' });
  if (!SB_URL) return res.status(503).json({ error: 'No DB' });
  await fetch(`${SB_URL}/rest/v1/rooms?id=eq.${id}`, {
    method: 'PATCH',
    headers: { ...sbHeaders(), 'Prefer': 'return=minimal' },
    body: JSON.stringify({ names })
  });
  // Broadcast so all connected clients update the header
  const payload = JSON.stringify({ type: 'room_renamed', names });
  rooms.get(id)?.members?.forEach((m, ws) => { if (ws.readyState === WebSocket.OPEN) ws.send(payload); });
  res.json({ ok: true });
});

// Update room description (admin only)
app.patch('/api/rooms/:id/description', express.json(), async (req, res) => {
  const { id } = req.params;
  const { phone, description } = req.body;
  if (!phone) return res.status(400).json({ error: 'Missing phone' });
  if (!SB_URL) return res.status(503).json({ error: 'No DB' });
  if (!(await isRoomAdmin(id, phone))) return res.status(403).json({ error: 'Not an admin' });
  await fetch(`${SB_URL}/rest/v1/rooms?id=eq.${id}`, {
    method: 'PATCH',
    headers: { ...sbHeaders(), 'Prefer': 'return=minimal' },
    body: JSON.stringify({ description })
  }).catch(e => console.error('[desc-update]', e.message));
  const payload = JSON.stringify({ type: 'room_description', description });
  rooms.get(id)?.members?.forEach((m, ws) => { if (ws.readyState === WebSocket.OPEN) ws.send(payload); });
  res.json({ ok: true });
});

// Toggle admin status for a member (admin only, cannot demote self if last admin)
app.patch('/api/rooms/:id/members/:memberPhone/admin', express.json(), async (req, res) => {
  const { id, memberPhone } = req.params;
  const { phone, is_admin } = req.body; // phone = requester, is_admin = desired state for target
  if (!phone) return res.status(400).json({ error: 'Missing phone' });
  if (!SB_URL) return res.status(503).json({ error: 'No DB' });
  if (!(await isRoomAdmin(id, phone))) return res.status(403).json({ error: 'Not an admin' });
  // Prevent removing self if last admin
  if (!is_admin && memberPhone === phone) {
    const admins = await sbQuery('room_members', `room_id=eq.${id}&is_admin=eq.true&select=phone`).catch(() => []);
    if (admins.length <= 1) return res.status(400).json({ error: 'Last admin' });
  }
  await fetch(`${SB_URL}/rest/v1/room_members?room_id=eq.${id}&phone=eq.${encodeURIComponent(memberPhone)}`, {
    method: 'PATCH',
    headers: { ...sbHeaders(), 'Prefer': 'return=minimal' },
    body: JSON.stringify({ is_admin: !!is_admin })
  }).catch(e => console.error('[admin-toggle]', e.message));
  const payload = JSON.stringify({ type: 'member_admin_changed', phone: memberPhone, is_admin: !!is_admin });
  rooms.get(id)?.members?.forEach((m, ws) => { if (ws.readyState === WebSocket.OPEN) ws.send(payload); });
  res.json({ ok: true });
});

// Kick a member (admin only)
app.delete('/api/rooms/:id/members/:memberPhone', express.json(), async (req, res) => {
  const { id, memberPhone } = req.params;
  const { phone } = req.body; // requester's phone
  if (!phone) return res.status(400).json({ error: 'Missing phone' });
  if (!SB_URL) return res.status(503).json({ error: 'No DB' });
  if (!(await isRoomAdmin(id, phone))) return res.status(403).json({ error: 'Not an admin' });
  if (memberPhone === phone) return res.status(400).json({ error: 'Cannot kick yourself' });
  await fetch(`${SB_URL}/rest/v1/room_members?room_id=eq.${id}&phone=eq.${encodeURIComponent(memberPhone)}`, {
    method: 'DELETE',
    headers: { ...sbHeaders(), 'Prefer': 'return=minimal' }
  }).catch(e => console.error('[kick-member]', e.message));
  const payload = JSON.stringify({ type: 'member_kicked', phone: memberPhone });
  rooms.get(id)?.members?.forEach((m, ws) => { if (ws.readyState === WebSocket.OPEN) ws.send(payload); });
  res.json({ ok: true });
});

// Emoji reaction — toggle on/off
app.post('/api/rooms/:id/messages/:msgId/react', express.json(), async (req, res) => {
  const { id, msgId } = req.params;
  const { emoji, name } = req.body;
  if (!emoji || !name) return res.status(400).json({ error: 'Missing params' });

  const msgs = await sbQuery('messages', `id=eq.${msgId}&select=reactions&limit=1`);
  if (!msgs[0]) return res.status(404).json({ error: 'Not found' });

  const reactions = msgs[0].reactions || {};
  const users = reactions[emoji] || [];
  if (users.includes(name)) {
    reactions[emoji] = users.filter(u => u !== name);
    if (!reactions[emoji].length) delete reactions[emoji];
  } else {
    reactions[emoji] = [...users, name];
  }

  if (SB_URL) {
    await fetch(`${SB_URL}/rest/v1/messages?id=eq.${msgId}`, {
      method: 'PATCH',
      headers: { ...sbHeaders(), 'Prefer': 'return=minimal' },
      body: JSON.stringify({ reactions })
    }).catch(e => console.error('[reaction]', e.message));
  }

  const payload = JSON.stringify({ type: 'reaction_update', msg_id: msgId, reactions });
  const roomWs = rooms.get(id);
  if (roomWs?.members) roomWs.members.forEach((m, ws) => { if (ws.readyState === WebSocket.OPEN) ws.send(payload); });

  res.json({ ok: true, reactions });
});

// Delete a message — sender can delete own; admin can delete any
app.delete('/api/rooms/:id/messages/:msgId', express.json(), async (req, res) => {
  const { id, msgId } = req.params;
  const { name, phone } = req.body;
  if (!name) return res.status(400).json({ error: 'Missing name' });

  const msgs = await sbQuery('messages', `id=eq.${msgId}&select=sender_name&limit=1`);
  if (!msgs[0]) return res.status(404).json({ error: 'Not found' });
  const isSender = msgs[0].sender_name === name;
  const adminOk  = phone ? await isRoomAdmin(id, phone) : false;
  if (!isSender && !adminOk) return res.status(403).json({ error: 'Not allowed' });

  if (SB_URL) {
    await fetch(`${SB_URL}/rest/v1/messages?id=eq.${msgId}`, {
      method: 'DELETE',
      headers: { ...sbHeaders(), 'Prefer': 'return=minimal' }
    }).catch(e => console.error('[delete-message]', e.message));
  }

  const payload = JSON.stringify({ type: 'message_deleted', msg_id: msgId });
  const roomWs = rooms.get(id);
  if (roomWs?.members) roomWs.members.forEach((m, ws) => { if (ws.readyState === WebSocket.OPEN) ws.send(payload); });

  res.json({ ok: true });
});

// Edit a message — only the original sender may edit their own message.
// Re-detects language, re-runs moderation, and re-translates to every
// language currently in the room, since the text itself changed.
app.patch('/api/rooms/:id/messages/:msgId', express.json(), async (req, res) => {
  const { id, msgId } = req.params;
  const { name, text } = req.body;
  if (!name || !text?.trim()) return res.status(400).json({ error: 'Missing name or text' });
  const original_text = text.trim();

  const msgs = await sbQuery('messages', `id=eq.${msgId}&select=sender_name&limit=1`);
  if (!msgs[0]) return res.status(404).json({ error: 'Not found' });
  if (msgs[0].sender_name !== name) return res.status(403).json({ error: 'Not your message' });

  const detected_lang = detectScriptLang(original_text, 'he');
  const translations = await translateForRoom(id, detected_lang, original_text);
  const { flagged, reason: flagged_reason } = await moderateText(original_text);
  const edited_at = new Date().toISOString();

  if (SB_URL) {
    await fetch(`${SB_URL}/rest/v1/messages?id=eq.${msgId}`, {
      method: 'PATCH',
      headers: { ...sbHeaders(), 'Prefer': 'return=minimal' },
      body: JSON.stringify({ original_text, sender_lang: detected_lang, translations, flagged, flagged_reason, edited: true, edited_at })
    }).catch(e => console.error('[edit-message]', e.message));
  }

  const payload = JSON.stringify({
    type: 'message_edited', id: msgId, sender_name: name,
    original_text, sender_lang: detected_lang, translations, edited: true, edited_at
  });
  const roomWs = rooms.get(id);
  if (roomWs?.members) roomWs.members.forEach((m, ws) => { if (ws.readyState === WebSocket.OPEN) ws.send(payload); });

  res.json({ ok: true });
});

// Save a single translation that was fetched on-demand by a client
app.patch('/api/rooms/:id/messages/:msgId/translation', express.json(), async (req, res) => {
  const { msgId } = req.params;
  const { lang, text } = req.body;
  if (!lang || !text) return res.status(400).json({ error: 'Missing lang or text' });
  if (!SB_URL) return res.json({ ok: true }); // no-op if no DB
  // Merge into existing translations JSONB using Supabase's || operator via RPC isn't available in REST,
  // so we fetch current translations, merge, and PATCH back.
  const msgs = await sbQuery('messages', `id=eq.${msgId}&select=translations&limit=1`);
  if (!msgs[0]) return res.status(404).json({ error: 'Not found' });
  const translations = { ...(msgs[0].translations || {}), [lang]: text };
  await fetch(`${SB_URL}/rest/v1/messages?id=eq.${msgId}`, {
    method: 'PATCH',
    headers: { ...sbHeaders(), 'Prefer': 'return=minimal' },
    body: JSON.stringify({ translations })
  }).catch(e => console.error('[translation-save]', e.message));
  res.json({ ok: true });
});

// Send text message
app.post('/api/rooms/:id/text', express.json(), async (req, res) => {
  const { id } = req.params;
  const { sender_name, sender_emoji, sender_lang, text, reply_to } = req.body;
  if (!text?.trim()) return res.status(400).json({ error: 'No text' });
  const original_text = text.trim();
  // Use actual script in text for translation — overrides declared lang if user typed in different script
  const detected_lang = detectScriptLang(original_text, sender_lang || 'he');

  const roomWs = rooms.get(id);
  const memberLangs = new Set([detected_lang]);
  if (roomWs?.members) roomWs.members.forEach(m => memberLangs.add(m.lang));
  const dbMembers = await sbQuery('room_members', `room_id=eq.${id}&select=lang`).catch(() => []);
  dbMembers.forEach(m => { if (m.lang) memberLangs.add(m.lang); });

  const translations = { [detected_lang]: original_text };
  const targetLangs = [...memberLangs].filter(l => l !== detected_lang);
  await Promise.all(targetLangs.map(async lang => {
    const fromName = LANG_NAMES[detected_lang] || detected_lang;
    const toName   = LANG_NAMES[lang] || lang;
    const systemPrompt = `תרגם מ${fromName} ל${toName} בלבד. הפלט חייב להיות ב${toName} בלבד.\n\n` + TRANSLATION_SYSTEM_PROMPT;
    try {
      const r = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + process.env.OPENAI_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: `[${fromName}→${toName}]\n<text>\n${original_text}\n</text>` }],
          temperature: 0, max_tokens: 250, frequency_penalty: 1.5, presence_penalty: 0.5
        })
      });
      const d = await r.json();
      let t = d.choices?.[0]?.message?.content?.trim()?.replace(/<\/?text>/gi, '').trim();
      if (t && lang === 'he') t = t.replace(/[؀-ۿ]/g, '');
      if (t && lang === 'ar') t = t.replace(/[א-ת]/g, '');
      if (t && t.length > 0 && t.length <= original_text.length * 4 + 200) translations[lang] = t;
    } catch(e) {}
  }));

  // Lazy-create room in DB if first message (e.g. DM)
  if (SB_URL) {
    const existing = await sbQuery('rooms', `id=eq.${id}&limit=1`).catch(() => []);
    if (!existing.length) await sbInsert('rooms', { id, name: id }).catch(() => {});
  }
  // Save to DB first so history is ready if client reconnects
  const { flagged, reason: flagged_reason } = await moderateText(original_text);
  const saved = await sbInsert('messages', { room_id: id, sender_name, sender_emoji, sender_lang: detected_lang, original_text, translations, flagged, flagged_reason, ...(reply_to ? { reply_to } : {}) })
    .catch(e => { console.error('[db] save failed:', e.message); return null; });
  const msgId = saved?.id || Date.now().toString();
  const msgCreatedAt = saved?.created_at || new Date().toISOString();

  const payload = JSON.stringify({
    type: 'room_message', id: msgId, sender_name, sender_emoji,
    sender_lang: detected_lang, original_text, translations, created_at: msgCreatedAt,
    ...(reply_to ? { reply_to } : {})
  });
  if (roomWs?.members) {
    roomWs.members.forEach((m, ws) => { if (ws.readyState === WebSocket.OPEN) ws.send(payload); });
  }
  sendPushToRoom(id, roomWs, sender_name, { sender_name, sender_emoji, translations, original_text }).catch(() => {});
  res.json({ ok: true, id: msgId });
});

// ── Image upload endpoint ─────────────────────────────────────────────────────
// Client compresses on canvas (max 800px, JPEG q=0.7) before sending,
// so files arriving here are typically 80–150 KB.
app.post('/api/rooms/:id/image', upload.single('image'), async (req, res) => {
  const { id } = req.params;
  const { sender_name, sender_emoji } = req.body;
  if (!req.file) return res.status(400).json({ error: 'No image' });

  const ALLOWED_MIME = ['image/jpeg', 'image/png', 'image/webp'];
  if (!ALLOWED_MIME.includes(req.file.mimetype)) {
    return res.status(400).json({ error: 'Invalid image type' });
  }
  if (!SB_URL || !SB_KEY) return res.status(503).json({ error: 'No storage configured' });

  const timestamp = Date.now();
  const rand = Math.random().toString(36).slice(2, 8);
  const filename = `${id}/${timestamp}-${rand}.jpg`;

  // Upload to Supabase Storage bucket "images"
  const uploadUrl = `${SB_URL}/storage/v1/object/images/${filename}`;
  const uploadResp = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      'apikey': SB_KEY,
      'Authorization': 'Bearer ' + SB_KEY,
      'Content-Type': req.file.mimetype,
      'x-upsert': 'false',
    },
    body: req.file.buffer
  }).catch(e => null);

  if (!uploadResp || !uploadResp.ok) {
    const err = uploadResp ? await uploadResp.text() : 'fetch failed';
    console.error('[image-upload] Storage error:', err);
    return res.status(500).json({ error: 'Storage upload failed' });
  }

  const image_url = `${SB_URL}/storage/v1/object/public/images/${filename}`;

  // Save as a message row (text = placeholder; image_url carries the media)
  const saved = await sbInsert('messages', {
    room_id: id,
    sender_name,
    sender_emoji: sender_emoji || '',
    sender_lang: 'he',
    original_text: '📷',
    translations: { he: '📷', ar: '📷', en: '📷' },
    image_url,
    flagged: false,
    flagged_reason: null
  }).catch(e => { console.error('[db] image save failed:', e.message); return null; });

  const msgId = saved?.id || Date.now().toString();
  const msgCreatedAt = saved?.created_at || new Date().toISOString();

  const payload = JSON.stringify({
    type: 'room_message', id: msgId, sender_name, sender_emoji: sender_emoji || '',
    sender_lang: 'he', original_text: '📷',
    translations: { he: '📷', ar: '📷', en: '📷' },
    image_url, created_at: msgCreatedAt
  });

  const roomWs = rooms.get(id);
  if (roomWs?.members) {
    roomWs.members.forEach((m, ws) => { if (ws.readyState === WebSocket.OPEN) ws.send(payload); });
  }
  res.json({ ok: true, id: msgId, image_url });
});

// Send voice message
app.post('/api/rooms/:id/message', upload.single('audio'), async (req, res) => {
  const { id } = req.params;
  const { sender_name, sender_emoji, sender_lang, reply_to: reply_to_raw } = req.body;
  const reply_to = reply_to_raw ? JSON.parse(reply_to_raw) : null;
  if (!req.file) return res.status(400).json({ error: 'No audio' });
  if (!process.env.OPENAI_API_KEY) return res.status(500).json({ error: 'No API key' });

  // 1. Transcribe
  const blob = new Blob([req.file.buffer], { type: req.file.mimetype || 'audio/webm' });
  const form = new FormData();
  form.append('file', blob, 'audio.webm');
  form.append('model', 'whisper-1');
  form.append('temperature', '0');
  form.append('response_format', 'verbose_json'); // needed for no_speech_prob per segment
  if (sender_lang) form.append('language', sender_lang.split('-')[0]);
  let original_text = '', detected_lang = sender_lang || 'ar', noSpeechProb = 0;
  try {
    const wResp = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + process.env.OPENAI_API_KEY },
      body: form
    });
    const wData = await wResp.json();
    original_text = (wData.text || '').trim();
    detected_lang = sender_lang || 'ar';
    const segments = wData.segments || [];
    if (segments.length) {
      noSpeechProb = segments.reduce((s, seg) => s + (seg.no_speech_prob || 0), 0) / segments.length;
    }
  } catch(e) { console.error('Whisper error:', e.message); }
  // Re-detect from actual script — catches cases where user speaks a different language than declared
  if (original_text) detected_lang = detectScriptLang(original_text, detected_lang);
  // Strip punctuation + Arabic diacritics, then check against known hallucinations
  const normalizeHallucination = t => t.trim().toLowerCase()
    .replace(/[ً-ٰٟ]/g, '') // Arabic diacritics
    .replace(/[.,!?؟،]/g, '').trim();
  const WHISPER_HALLUCINATIONS = [
    'תודה רבה','תודה','שוקראן','شكرا جزيلا','شكرا','شكراً','شكرًا',
    'thank you for watching','thanks for watching','thank you','thanks','subscribe',
    'اشتركوا في القناة','اشترك في القناة','شكراً للمشاهدة',
  ];
  const normalized = normalizeHallucination(original_text);
  const looksLikeHallucination = !normalized || WHISPER_HALLUCINATIONS.some(h => normalized.includes(h));
  if (!original_text || noSpeechProb > 0.6 || looksLikeHallucination)
    return res.json({ ok: true, text: '' });

  // 2. Translate to languages of all room members (from DB + currently connected)
  const roomWs = rooms.get(id);
  const memberLangs = new Set([detected_lang]);
  if (roomWs?.members) roomWs.members.forEach(m => memberLangs.add(m.lang));
  const dbMembers = await sbQuery('room_members', `room_id=eq.${id}&select=lang`).catch(() => []);
  dbMembers.forEach(m => { if (m.lang) memberLangs.add(m.lang); });

  // 3. Translate to each language — in parallel
  const translations = { [detected_lang]: original_text };
  const targetLangs = [...memberLangs].filter(l => l !== detected_lang);
  await Promise.all(targetLangs.map(async lang => {
    const fromName = LANG_NAMES[detected_lang] || detected_lang;
    const toName   = LANG_NAMES[lang] || lang;
    const systemPrompt =
      `תרגם מ${fromName} ל${toName} בלבד. הפלט חייב להיות ב${toName} בלבד.\n\n` + TRANSLATION_SYSTEM_PROMPT;
    try {
      const r = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + process.env.OPENAI_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: `[${fromName}→${toName}]\n<text>\n${original_text}\n</text>` }
          ],
          temperature: 0, max_tokens: 250, frequency_penalty: 1.5, presence_penalty: 0.5
        })
      });
      const d = await r.json();
      let t = d.choices?.[0]?.message?.content?.trim()?.replace(/<\/?text>/gi, '').trim();
      if (t && lang === 'he') t = t.replace(/[؀-ۿ]/g, '');
      if (t && lang === 'ar') t = t.replace(/[א-ת]/g, '');
      // sanity check: reject if suspiciously long (hallucination) or empty
      if (t && t.length > 0 && t.length <= original_text.length * 4 + 200) {
        translations[lang] = t;
      } else if (t) {
        console.warn(`[translate] ${detected_lang}→${lang}: rejected (len=${t.length})`);
      }
    } catch(e) { console.error(`[translate] ${detected_lang}→${lang}:`, e.message); }
  }));

  console.log(`[translate] ${detected_lang} → ${JSON.stringify(Object.fromEntries(Object.entries(translations).map(([k,v])=>[k,v?.slice(0,30)])))}`);

  // 4. Lazy-create room in DB if first message (e.g. DM), then save
  if (SB_URL) {
    const existing = await sbQuery('rooms', `id=eq.${id}&limit=1`).catch(() => []);
    if (!existing.length) await sbInsert('rooms', { id, name: id }).catch(() => {});
  }
  const { flagged, reason: flagged_reason } = await moderateText(original_text);
  const saved = await sbInsert('messages', {
    room_id: id, sender_name, sender_emoji, sender_lang: detected_lang, original_text, translations,
    flagged, flagged_reason, ...(reply_to ? { reply_to } : {})
  }).catch(e => { console.error('[db] save failed:', e.message); return null; });
  const msgId = saved?.id || Date.now().toString();
  const msgCreatedAt = saved?.created_at || new Date().toISOString();

  // 5. Broadcast
  const payload = JSON.stringify({
    type: 'room_message', id: msgId, sender_name, sender_emoji,
    sender_lang: detected_lang, original_text, translations, created_at: msgCreatedAt,
    ...(reply_to ? { reply_to } : {})
  });
  if (roomWs?.members) {
    roomWs.members.forEach((m, ws) => { if (ws.readyState === WebSocket.OPEN) ws.send(payload); });
  }
  sendPushToRoom(id, roomWs, sender_name, { sender_name, sender_emoji, translations, original_text }).catch(() => {});
  res.json({ ok: true, id: msgId, translations });
});

// ── Page content cache (translations) ────────────────────────────────────────
// SQL: create table if not exists page_content (key text, lang text, text text, primary key (key, lang));

app.get('/api/page-content', async (req, res) => {
  const { lang } = req.query;
  if (!lang || !SB_URL) return res.json({});
  try {
    const r = await fetch(`${SB_URL}/rest/v1/page_content?lang=eq.${encodeURIComponent(lang)}&select=key,text`, { headers: sbHeaders() });
    if (!r.ok) return res.json({});
    const rows = await r.json();
    const map = {};
    rows.forEach(row => { map[row.key] = row.text; });
    res.json(map);
  } catch { res.json({}); }
});

app.post('/api/page-content/translate', express.json(), async (req, res) => {
  const { lang, texts, pretranslated } = req.body;
  if (!lang || !texts || typeof texts !== 'object') return res.status(400).json({ error: 'missing' });
  const entries = Object.entries(texts);
  if (!entries.length) return res.json({});

  // Pre-translated (vetted) content — just store, skip GPT
  if (pretranslated) {
    const translated = Object.fromEntries(entries);
    if (SB_URL) {
      const rows = entries.filter(([, text]) => text !== '').map(([key, text]) => ({ key, lang, text }));
      if (rows.length) await fetch(`${SB_URL}/rest/v1/page_content`, {
        method: 'POST',
        headers: { ...sbHeaders(), 'Prefer': 'resolution=merge-duplicates' },
        body: JSON.stringify(rows)
      }).catch(() => {});
    }
    return res.json(translated);
  }
  const translated = {};
  await Promise.all(entries.map(async ([key, src]) => {
    try {
      const r = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-4o-mini', temperature: 0, max_tokens: 300,
          messages: [
            { role: 'system', content: `Translate the following UI label/text to ${lang}. Return ONLY the translated text, nothing else.` },
            { role: 'user', content: src }
          ]
        })
      });
      const data = await r.json();
      translated[key] = data.choices?.[0]?.message?.content?.trim() || src;
    } catch { translated[key] = src; }
  }));
  if (SB_URL) {
    const rows = Object.entries(translated).map(([key, text]) => ({ key, lang, text }));
    await fetch(`${SB_URL}/rest/v1/page_content`, {
      method: 'POST',
      headers: { ...sbHeaders(), 'Prefer': 'resolution=merge-duplicates' },
      body: JSON.stringify(rows)
    }).catch(() => {});
  }
  res.json(translated);
});

// ── Feedback ─────────────────────────────────────────────────────────────────
app.post('/api/feedback', express.json(), async (req, res) => {
  const { name, room_id, device, severity, what_happened, expected } = req.body;
  if (!name || !what_happened) return res.status(400).json({ error: 'missing fields' });
  if (!SB_URL) return res.json({ ok: true });
  const r = await fetch(`${SB_URL}/rest/v1/feedback`, {
    method: 'POST',
    headers: { ...sbHeaders(), 'Prefer': 'return=minimal' },
    body: JSON.stringify({ name, room_id: room_id || null, device: device || null, severity: severity || 'low', what_happened, expected: expected || null })
  });
  if (!r.ok) return res.status(500).json({ error: 'db error' });
  res.json({ ok: true });
});

app.get('/api/feedback', async (req, res) => {
  if (!SB_URL) return res.json([]);
  const r = await fetch(`${SB_URL}/rest/v1/feedback?order=created_at.desc&limit=100`, { headers: sbHeaders() });
  if (!r.ok) return res.status(500).json({ error: 'db error' });
  res.json(await r.json());
});

app.patch('/api/feedback/:id', express.json(), async (req, res) => {
  const secret = req.query.secret || req.body.secret;
  if (!secret || secret !== process.env.REPORT_SECRET) return res.status(403).json({ error: 'forbidden' });
  const { resolved } = req.body;
  if (typeof resolved !== 'boolean') return res.status(400).json({ error: 'resolved must be boolean' });
  if (!SB_URL) return res.json({ ok: true });
  const r = await fetch(`${SB_URL}/rest/v1/feedback?id=eq.${encodeURIComponent(req.params.id)}`, {
    method: 'PATCH',
    headers: { ...sbHeaders(), 'Prefer': 'return=minimal' },
    body: JSON.stringify({ resolved })
  });
  if (!r.ok) return res.status(500).json({ error: 'db error' });
  res.json({ ok: true });
});

// ── OpenAI usage/cost report (admin, read-only key) ──────────────────────────
// Protected by REPORT_SECRET env var (separate from the OpenAI key) so the
// endpoint isn't publicly scrapeable. OPENAI_ADMIN_KEY must be a restricted
// (usage-read-only) admin key — set both as env vars on Render, never in git.
app.get('/api/admin/usage-report', async (req, res) => {
  if (!process.env.OPENAI_ADMIN_KEY) return res.status(500).json({ error: 'No admin key configured' });
  if (!process.env.REPORT_SECRET || req.query.secret !== process.env.REPORT_SECRET) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const days = Math.min(parseInt(req.query.days) || 7, 90);
  const startTime = Math.floor(Date.now() / 1000) - days * 86400;
  try {
    const r = await fetch(`https://api.openai.com/v1/organization/costs?start_time=${startTime}&limit=${days}`, {
      headers: { 'Authorization': 'Bearer ' + process.env.OPENAI_ADMIN_KEY }
    });
    if (!r.ok) return res.status(r.status).json({ error: 'OpenAI API error', detail: await r.text() });
    const data = await r.json();
    let total = 0;
    const byDay = [];
    (data.data || []).forEach(bucket => {
      const dayTotal = (bucket.results || []).reduce((sum, x) => sum + parseFloat(x.amount?.value || 0), 0);
      total += dayTotal;
      byDay.push({ start: bucket.start_time, end: bucket.end_time, amount_usd: Math.round(dayTotal * 100) / 100 });
    });
    res.json({ days, total_usd: Math.round(total * 100) / 100, by_day: byDay });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Admin: delete any single message (moderation) ──────────────────────────────
// For when a complaint comes in about a specific offensive message — unlike
// DELETE /api/rooms/:id/messages/:msgId, this doesn't require being the
// sender. Protected by REPORT_SECRET (?secret= query param). Reuses the same
// 'message_deleted' WS broadcast, so the client-side removal logic already
// built for sender-deletes handles this automatically — no client changes needed.
app.delete('/api/admin/rooms/:id/messages/:msgId', async (req, res) => {
  const { id, msgId } = req.params;
  if (!process.env.REPORT_SECRET || req.query.secret !== process.env.REPORT_SECRET) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  if (!SB_URL) return res.status(503).json({ error: 'No DB' });

  const r = await fetch(`${SB_URL}/rest/v1/messages?id=eq.${msgId}`, {
    method: 'DELETE', headers: { ...sbHeaders(), 'Prefer': 'return=minimal' }
  });
  if (!r.ok) return res.status(500).json({ error: 'db error', detail: await r.text() });

  const payload = JSON.stringify({ type: 'message_deleted', msg_id: msgId });
  const roomWs = rooms.get(id);
  if (roomWs?.members) roomWs.members.forEach((m, ws) => { if (ws.readyState === WebSocket.OPEN) ws.send(payload); });

  res.json({ ok: true });
});

// ── Admin: list flagged messages for review ────────────────────────────────────
// Protected by REPORT_SECRET. Shows anything the Moderation API flagged, most
// recent first, so an admin can review and delete via the endpoint above.
app.get('/api/admin/flagged-messages', async (req, res) => {
  if (!process.env.REPORT_SECRET || req.query.secret !== process.env.REPORT_SECRET) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  if (!SB_URL) return res.json([]);
  const rows = await sbQuery('messages', `flagged=eq.true&order=created_at.desc&limit=50&select=id,room_id,sender_name,original_text,flagged_reason,created_at`);
  res.json(rows);
});

// ── Admin: storage usage ──────────────────────────────────────────────────────
// Returns count of active (non-expired) image messages and estimated MB used.
app.get('/api/admin/storage-usage', async (req, res) => {
  if (!process.env.REPORT_SECRET || req.query.secret !== process.env.REPORT_SECRET) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  if (!SB_URL) return res.json({ count: 0, size_estimate_mb: 0 });
  try {
    const r = await fetch(
      `${SB_URL}/rest/v1/messages?image_url=not.is.null&select=id`,
      { headers: { ...sbHeaders(), 'Prefer': 'count=exact', 'Range-Unit': 'items', 'Range': '0-0' } }
    );
    const contentRange = r.headers.get('content-range') || '';
    const total = parseInt((contentRange.split('/')[1] || '0'), 10) || 0;
    const size_estimate_mb = Math.round(total * 0.12 * 10) / 10; // ~120 KB avg after compression
    res.json({ count: total, size_estimate_mb });
  } catch(e) {
    console.error('[storage-usage]', e.message);
    res.json({ count: 0, size_estimate_mb: 0, error: e.message });
  }
});

// ── User profile endpoints ────────────────────────────────────────────────────
// ── OTP endpoints ─────────────────────────────────────────────────────────────
app.post('/api/send-otp', express.json(), async (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ error: 'phone required' });
  if (!twilioClient) return res.status(503).json({ error: 'SMS not configured' });

  const existing = otpStore.get(phone);
  if (existing && existing.expires > Date.now() && (existing.sendCount || 0) >= 3) {
    return res.status(429).json({ error: 'too many requests' });
  }

  const code = generateOTP();
  const expires = Date.now() + 5 * 60 * 1000;
  otpStore.set(phone, { code, expires, attempts: 0, sendCount: (existing?.sendCount || 0) + 1 });

  console.log(`[otp] sending to ${phone.slice(0, 4)}***`);
  try {
    await twilioClient.messages.create({
      body: `קוד האימות שלך ל-Babel Fish: ${code}`,
      from: TWILIO_FROM,
      to: phone
    });
    res.json({ ok: true });
  } catch(e) {
    console.error('[twilio] send error:', e.message);
    otpStore.delete(phone);
    res.status(500).json({ error: 'failed to send SMS' });
  }
});

app.post('/api/verify-otp', express.json(), (req, res) => {
  const { phone, code } = req.body;
  if (!phone || !code) return res.status(400).json({ error: 'phone and code required' });

  const record = otpStore.get(phone);
  if (!record) return res.status(400).json({ error: 'no_otp' });
  if (Date.now() > record.expires) { otpStore.delete(phone); return res.status(400).json({ error: 'expired' }); }

  record.attempts++;
  if (record.attempts > 3) { otpStore.delete(phone); return res.status(429).json({ error: 'too_many' }); }
  if (record.code !== String(code).trim()) {
    return res.status(400).json({ error: 'invalid', attemptsLeft: 3 - record.attempts });
  }

  otpStore.delete(phone);
  res.json({ ok: true });
});

app.get('/api/profile', async (req, res) => {
  const { phone } = req.query;
  if (!phone || !SB_URL) return res.json({});
  const profiles = await sbQuery('user_profiles', `phone=eq.${encodeURIComponent(phone)}&limit=1`).catch(() => []);
  res.json(profiles[0] || {});
});

// Translate a name to he/ar/en from any source language (used by settings on save)
app.post('/api/profile/translate-name', express.json(), async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'Missing name' });
  if (!process.env.OPENAI_API_KEY) return res.json({ he: name, ar: name, en: name });
  try {
    const [he, ar, en] = await Promise.all([
      translateMemberName(name, 'he'),
      translateMemberName(name, 'ar'),
      translateMemberName(name, 'en'),
    ]);
    res.json({ he, ar, en });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Patch name_translations — client sends corrected English; server re-translates to he/ar
app.patch('/api/profile/name-translations', express.json(), async (req, res) => {
  const { phone, name_translations } = req.body;
  if (!phone || !name_translations) return res.status(400).json({ error: 'Missing params' });
  if (!SB_URL) return res.json({ ok: true, name_translations });

  const result = { ...name_translations };
  const en = result.en;
  if (en && process.env.OPENAI_API_KEY) {
    // Re-translate from the corrected English to he + ar
    const [he, ar] = await Promise.all([
      translateMemberName(en, 'he'),
      translateMemberName(en, 'ar'),
    ]);
    result.he = he;
    result.ar = ar;
  }

  await fetch(`${SB_URL}/rest/v1/user_profiles?phone=eq.${encodeURIComponent(phone)}`, {
    method: 'PATCH', headers: { ...sbHeaders(), 'Prefer': 'return=minimal' },
    body: JSON.stringify({ name_translations: result })
  }).catch(e => console.error('[profile/name-translations]', e.message));

  res.json({ ok: true, name_translations: result });
});

// ── Rename a user across every room they're in ────────────────────────────────
// Identity is anchored by phone (collected at registration), since `name` is
// the room_members primary key and messages.sender_name is just plain text.
// Renaming without this endpoint leaves a stale "ghost" member (old name) and
// all past messages permanently attributed to the old name.
app.post('/api/rename-member', express.json(), async (req, res) => {
  const { phone, oldName, newName } = req.body;
  if (!phone || !oldName || !newName) return res.status(400).json({ error: 'Missing params' });
  if (oldName === newName) return res.json({ ok: true, rooms: [] });
  if (!SB_URL) return res.json({ ok: true, rooms: [] });

  // Only rename rooms where this phone actually owns the old name — proves ownership
  const memberships = await sbQuery('room_members', `phone=eq.${encodeURIComponent(phone)}&name=eq.${encodeURIComponent(oldName)}&select=room_id`);
  const roomIds = [...new Set(memberships.map(m => m.room_id))];
  if (!roomIds.length) return res.status(404).json({ error: 'No matching membership found' });

  for (const roomId of roomIds) {
    // 1. Reattribute past messages to the new name
    await fetch(`${SB_URL}/rest/v1/messages?room_id=eq.${roomId}&sender_name=eq.${encodeURIComponent(oldName)}`, {
      method: 'PATCH',
      headers: { ...sbHeaders(), 'Prefer': 'return=minimal' },
      body: JSON.stringify({ sender_name: newName })
    }).catch(e => console.error('[rename] messages:', e.message));

    // 2. Merge the room_members row — if a "new name" ghost already exists
    // (created when they reconnected with the new name before this endpoint
    // existed), drop it and keep the old row's history, just renamed.
    await fetch(`${SB_URL}/rest/v1/room_members?room_id=eq.${roomId}&name=eq.${encodeURIComponent(newName)}`, {
      method: 'DELETE',
      headers: { ...sbHeaders(), 'Prefer': 'return=minimal' }
    }).catch(() => {});
    await fetch(`${SB_URL}/rest/v1/room_members?room_id=eq.${roomId}&name=eq.${encodeURIComponent(oldName)}`, {
      method: 'PATCH',
      headers: { ...sbHeaders(), 'Prefer': 'return=minimal' },
      body: JSON.stringify({ name: newName })
    }).catch(e => console.error('[rename] room_members:', e.message));

    // 3. Notify anyone currently connected to that room
    const payload = JSON.stringify({ type: 'member_renamed', old_name: oldName, new_name: newName });
    const roomWs = rooms.get(roomId);
    if (roomWs?.members) roomWs.members.forEach((m, ws) => { if (ws.readyState === WebSocket.OPEN) ws.send(payload); });
  }

  // Also update global profile with new name (reset translations — they'll be rebuilt lazily)
  if (SB_URL) {
    await fetch(`${SB_URL}/rest/v1/user_profiles?phone=eq.${encodeURIComponent(phone)}`, {
      method: 'PATCH', headers: { ...sbHeaders(), 'Prefer': 'return=minimal' },
      body: JSON.stringify({ name: newName, name_translations: {}, updated_at: new Date().toISOString() })
    }).catch(() => {});
  }

  res.json({ ok: true, rooms: roomIds });
});

// ── Push notifications ───────────────────────────────────────────────────────
app.get('/api/vapid-public-key', (req, res) => {
  res.json({ key: VAPID_PUBLIC });
});

app.post('/api/push-subscribe', express.json(), async (req, res) => {
  const { room_id, name, lang, subscription } = req.body;
  if (!room_id || !name || !subscription) return res.status(400).json({ error: 'missing fields' });
  if (!SB_URL) return res.json({ ok: true });
  await fetch(`${SB_URL}/rest/v1/push_subscriptions`, {
    method: 'POST',
    headers: { ...sbHeaders(), 'Prefer': 'resolution=merge-duplicates' },
    body: JSON.stringify({ room_id, name, lang: lang || 'he', subscription })
  }).catch(e => console.error('[push] subscribe:', e.message));
  res.json({ ok: true });
});

app.delete('/api/push-subscribe', express.json(), async (req, res) => {
  const { room_id, name } = req.body;
  if (!SB_URL || !room_id || !name) return res.json({ ok: true });
  await fetch(`${SB_URL}/rest/v1/push_subscriptions?room_id=eq.${room_id}&name=eq.${encodeURIComponent(name)}`, {
    method: 'DELETE', headers: sbHeaders()
  }).catch(() => {});
  res.json({ ok: true });
});

// Send push to all room subscribers not currently connected via WS
async function sendPushToRoom(roomId, roomWs, senderName, msgData) {
  if (!VAPID_PUBLIC || !VAPID_PRIVATE || !SB_URL) return;
  // Get connected WS member names
  const connectedNames = new Set();
  roomWs?.members?.forEach((m, ws) => { if (ws.readyState === WebSocket.OPEN) connectedNames.add(m.name); });

  try {
    const r = await fetch(`${SB_URL}/rest/v1/push_subscriptions?room_id=eq.${roomId}`, { headers: sbHeaders() });
    if (!r.ok) return;
    const subs = await r.json();
    await Promise.all(subs.map(async sub => {
      if (sub.name === senderName) return; // don't push to self
      if (connectedNames.has(sub.name)) return; // already getting WS
      const lang = sub.lang || 'he';
      const body = msgData.translations?.[lang] || msgData.original_text;
      try {
        await webpush.sendNotification(sub.subscription, JSON.stringify({
          title: `${msgData.sender_emoji || '💬'} ${msgData.sender_name}`,
          body,
          roomId,
          url: `/room.html?room=${roomId}`
        }));
      } catch(e) {
        // Subscription expired → remove it
        if (e.statusCode === 410 || e.statusCode === 404) {
          fetch(`${SB_URL}/rest/v1/push_subscriptions?room_id=eq.${roomId}&name=eq.${encodeURIComponent(sub.name)}`, {
            method: 'DELETE', headers: sbHeaders()
          }).catch(() => {});
        }
      }
    }));
  } catch(e) { console.error('[push] sendPushToRoom:', e.message); }
}

const rooms = new Map();

// Check text against OpenAI's Moderation API — flags but never blocks, since
// automatic censorship on a false positive would be worse than a human
// reviewing a flagged message later via /api/admin/flagged-messages.
async function moderateText(text) {
  if (!text || !process.env.OPENAI_API_KEY) return { flagged: false, reason: null };
  try {
    const r = await fetch('https://api.openai.com/v1/moderations', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + process.env.OPENAI_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'omni-moderation-latest', input: text })
    });
    const data = await r.json();
    const result = data.results?.[0];
    if (!result?.flagged) return { flagged: false, reason: null };
    const reason = Object.entries(result.categories || {}).filter(([, v]) => v).map(([k]) => k).join(', ');
    return { flagged: true, reason };
  } catch (e) {
    console.error('[moderation]', e.message);
    return { flagged: false, reason: null }; // fail open — never block a message because moderation itself errored
  }
}

// Translate text to every language currently in the room — extracted so the
// edit endpoint can re-run the same logic used when a message is first sent.
async function translateForRoom(roomId, detectedLang, originalText) {
  const roomWs = rooms.get(roomId);
  const memberLangs = new Set([detectedLang]);
  if (roomWs?.members) roomWs.members.forEach(m => memberLangs.add(m.lang));
  const dbMembers = await sbQuery('room_members', `room_id=eq.${roomId}&select=lang`).catch(() => []);
  dbMembers.forEach(m => { if (m.lang) memberLangs.add(m.lang); });

  const translations = { [detectedLang]: originalText };
  const targetLangs = [...memberLangs].filter(l => l !== detectedLang);
  await Promise.all(targetLangs.map(async lang => {
    const fromName = LANG_NAMES[detectedLang] || detectedLang;
    const toName   = LANG_NAMES[lang] || lang;
    const systemPrompt = `תרגם מ${fromName} ל${toName} בלבד. הפלט חייב להיות ב${toName} בלבד.\n\n` + TRANSLATION_SYSTEM_PROMPT;
    try {
      const r = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + process.env.OPENAI_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: `[${fromName}→${toName}]\n<text>\n${originalText}\n</text>` }],
          temperature: 0, max_tokens: 250, frequency_penalty: 1.5, presence_penalty: 0.5
        })
      });
      const d = await r.json();
      let t = d.choices?.[0]?.message?.content?.trim()?.replace(/<\/?text>/gi, '').trim();
      if (t && lang === 'he') t = t.replace(/[؀-ۿ]/g, '');
      if (t && lang === 'ar') t = t.replace(/[א-ת]/g, '');
      if (t && t.length > 0 && t.length <= originalText.length * 4 + 200) translations[lang] = t;
    } catch(e) {}
  }));
  return translations;
}

// Detect actual script language from text (server-side, for translation accuracy)
function detectScriptLang(text, fallback) {
  const ar    = (text.match(/[؀-ۿ]/g) || []).length;
  const he    = (text.match(/[֐-׿]/g) || []).length;
  const cy    = (text.match(/[Ѐ-ӿ]/g) || []).length;
  const latin = (text.match(/[a-zA-Z]/g) || []).length;
  const max = Math.max(ar, he, cy, latin);
  if (max === 0) return fallback;
  if (ar >= he && ar >= cy && ar >= latin) return 'ar';
  if (he >= ar && he >= cy && he >= latin) return 'he';
  if (cy >= ar && cy >= he && cy >= latin) return 'ru';
  return 'en'; // Latin script dominates
}

function getRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, { broadcaster: null, listeners: new Set(), initChunk: null, mimeType: null, gender: 'm' });
  }
  return rooms.get(roomId);
}

function cleanRoom(roomId) {
  const room = rooms.get(roomId);
  const memberCount = room?.members?.size ?? 0;
  if (room && !room.broadcaster && room.listeners.size === 0 && memberCount === 0) {
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

  } else if (role === 'member') {
    const name  = params.get('name')  || 'אנונימי';
    const lang  = params.get('lang')  || 'he';
    const emoji = params.get('emoji') || '';
    const phone = params.get('phone') || '';
    if (!room.members) room.members = new Map();
    room.members.set(ws, { name, lang, emoji, phone, avatar: '' });
    console.log('[+] Member   room=' + roomId + ' name=' + name + ' lang=' + lang);

    // Persist member in DB — detect if creator to grant admin
    sbQuery('room_members', `room_id=eq.${roomId}&name=eq.${encodeURIComponent(name)}&limit=1`).then(async rows => {
      const roomRows = phone ? await sbQuery('rooms', `id=eq.${roomId}&select=creator_phone&limit=1`).catch(() => []) : [];
      const isCreator = !!(phone && roomRows[0]?.creator_phone && roomRows[0].creator_phone === phone);
      if (rows.length) {
        const patch = { emoji, lang, phone, last_seen: new Date().toISOString() };
        if (isCreator) patch.is_admin = true;
        fetch(`${SB_URL}/rest/v1/room_members?room_id=eq.${roomId}&name=eq.${encodeURIComponent(name)}`, {
          method: 'PATCH', headers: { ...sbHeaders(), 'Prefer': 'return=minimal' },
          body: JSON.stringify(patch)
        }).catch(() => {});
      } else {
        sbInsert('room_members', { room_id: roomId, name, emoji, lang, phone, is_admin: isCreator }).catch(() => {});
      }
    }).catch(() => {});

    // Auto-add to WLCM welcome room (every user who joins any room gets added silently)
    if (roomId !== 'WLCM') {
      sbQuery('room_members', `room_id=eq.WLCM&name=eq.${encodeURIComponent(name)}&limit=1`).then(rows => {
        if (!rows.length) {
          sbInsert('room_members', { room_id: 'WLCM', name, emoji, lang, phone, last_seen: new Date().toISOString() }).catch(() => {});
        }
      }).catch(() => {});
    }

    // Upsert global profile + lazy-translate other members' names to this member's language
    if (phone) {
      (async () => {
        await upsertUserProfile(phone, name, lang, emoji);
        // Translate every other member's name to the newcomer's language (if missing)
        const dbMembers = await sbQuery('room_members', `room_id=eq.${roomId}&select=phone,name`).catch(() => []);
        await Promise.all(
          dbMembers
            .filter(m => m.phone && m.name !== name)
            .map(m => ensureNameTranslation(m.phone, m.name, lang))
        );
      })().catch(e => console.error('[profile/lazy-translate]', e.message));
    }

    // Send current member list to newcomer (online only, from WS)
    const memberList = [...room.members.values()].map(m => ({ name: m.name, lang: m.lang, emoji: m.emoji, phone: m.phone || '', avatar: m.avatar || '', online: true }));
    send(ws, { type: 'joined', room: roomId, members: memberList });

    // Notify others that someone joined
    room.members.forEach((m, w) => {
      if (w !== ws) send(w, { type: 'member_joined', name, lang, emoji, phone, avatar: '' });
    });

    // Handle messages from member (e.g. avatar updates)
    ws.on('message', data => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'set_avatar') {
          const member = room.members.get(ws);
          if (member) {
            member.avatar = msg.avatar || '';
            // Broadcast avatar to all other members
            room.members.forEach((m, w) => {
              if (w !== ws && w.readyState === WebSocket.OPEN) {
                send(w, { type: 'member_avatar', name: member.name, avatar: member.avatar });
              }
            });
            // Persist avatar to DB so offline members also show it
            fetch(`${SB_URL}/rest/v1/room_members?room_id=eq.${roomId}&name=eq.${encodeURIComponent(member.name)}`, {
              method: 'PATCH', headers: { ...sbHeaders(), 'Prefer': 'return=minimal' },
              body: JSON.stringify({ avatar: member.avatar })
            }).catch(() => {});
          }
        }
      } catch(_) {}
    });

    ws.on('close', () => {
      if (room.members) room.members.delete(ws);
      console.log('[-] Member   room=' + roomId + ' name=' + name);
      // update last_seen
      fetch(`${SB_URL}/rest/v1/room_members?room_id=eq.${roomId}&name=eq.${encodeURIComponent(name)}`, {
        method: 'PATCH', headers: { ...sbHeaders(), 'Prefer': 'return=minimal' },
        body: JSON.stringify({ last_seen: new Date().toISOString() })
      }).catch(() => {});
      if (room.members) {
        room.members.forEach((m, w) => send(w, { type: 'member_left', name }));
      }
      cleanRoom(roomId);
    });
    ws.on('error', err => console.error('Member error room=' + roomId + ':', err.message));

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

// ── Daily image cleanup (30-day TTL) ─────────────────────────────────────────
// Deletes images from Supabase Storage and nulls out image_url in DB for
// messages older than 30 days, keeping storage usage near zero over time.
async function cleanupOldImages() {
  if (!SB_URL || !SB_KEY) return;
  console.log('[cleanup] image TTL pass...');
  try {
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const old = await sbQuery(
      'messages',
      `image_url=not.is.null&created_at=lt.${cutoff}&select=id,image_url&limit=200`
    );
    if (!old.length) { console.log('[cleanup] no old images'); return; }
    for (const msg of old) {
      const match = (msg.image_url || '').match(/\/storage\/v1\/object\/public\/images\/(.+)$/);
      if (match) {
        const filePath = match[1];
        await fetch(`${SB_URL}/storage/v1/object/images/${filePath}`, {
          method: 'DELETE',
          headers: { 'apikey': SB_KEY, 'Authorization': 'Bearer ' + SB_KEY }
        }).catch(e => console.warn('[cleanup] delete storage fail:', e.message));
      }
      await fetch(`${SB_URL}/rest/v1/messages?id=eq.${msg.id}`, {
        method: 'PATCH',
        headers: { ...sbHeaders(), 'Prefer': 'return=minimal' },
        body: JSON.stringify({ image_url: null })
      }).catch(e => console.warn('[cleanup] null image_url fail:', e.message));
    }
    console.log(`[cleanup] purged ${old.length} old images`);
  } catch(e) {
    console.error('[cleanup] error:', e.message);
  }
}
// First pass: 2 minutes after startup (so server is stable). Then every 24 h.
setTimeout(cleanupOldImages, 2 * 60 * 1000);
setInterval(cleanupOldImages, 24 * 60 * 60 * 1000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('Simultaneous Translation Server running on port ' + PORT);
});
