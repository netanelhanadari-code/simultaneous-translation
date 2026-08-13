# Babel Fish — Project Context

## כלל עבודה
**לפני כל שינוי קוד** — לסכם מה הובן ומה צפוי לצאת, ולשאול "לבצע?" לפני כתיבת קוד.

---

## What this is
Real-time multilingual IM app. Users join rooms, send voice or text messages, and every message is translated to all connected members' languages and read aloud via TTS.

## Stack
- **Backend:** Node.js + Express + WebSocket (`ws`) on Render.com
- **AI:** OpenAI Whisper (STT) + GPT-4o-mini (translation)
- **DB:** Supabase (direct REST fetch calls — no JS client)
- **Frontend:** Vanilla JS, Web Speech API for TTS
- **Deploy:** `git add -A; git commit -m "..."; git push` → Render auto-deploys

## Key files
- `server.js` — Express server, WebSocket hub, translation logic, Supabase REST calls
- `public/home.html` — Landing page: enter name/lang, create/join rooms, saved rooms list
- `public/room.html` — Main chat room: members bar, messages, text input, voice recording
- `public/settings.html` — User settings: name, emoji, language preference, avatar upload
- `public/feedback.html` — Bilingual (he/ar) feedback form
- `public/broadcaster.html` — Live event one-way broadcast mode
- `public/listener.html` — Listener for live event broadcasts

## Database (Supabase)
RLS disabled on all tables.
```sql
rooms (id text PK, name text, created_at)
messages (id uuid PK, room_id, sender_name, sender_emoji, sender_lang, original_text, translations jsonb, created_at)
room_members (room_id, name, emoji, lang, last_seen, avatar text, PRIMARY KEY (room_id, name))
push_subscriptions (room_id, name, lang, subscription jsonb, created_at, PRIMARY KEY (room_id, name))
feedback (id uuid PK, name, room_id, device, severity, what_happened, expected, created_at)
```

### SQL migrations needed (run in Supabase if not done)
```sql
alter table room_members add column if not exists avatar text default '';
alter table messages add column if not exists sender_emoji text default '';

create table if not exists push_subscriptions (
  room_id text not null, name text not null, lang text default 'he',
  subscription jsonb not null, created_at timestamptz default now(),
  primary key (room_id, name)
);
alter table push_subscriptions enable row level security;
create policy "anon all" on push_subscriptions for all using (true) with check (true);

create table if not exists feedback (
  id uuid primary key default gen_random_uuid(),
  name text not null, room_id text, device text,
  severity text default 'low', what_happened text not null,
  expected text, created_at timestamptz default now()
);
```

## Environment variables (on Render)
- `OPENAI_API_KEY` — never share in chat
- `SUPABASE_URL` — the raw project URL (strip trailing /rest/v1 in code)
- `SUPABASE_ANON_KEY`
- `OPENAI_ADMIN_KEY` — restricted (usage-read-only) org admin key, only for `/api/admin/usage-report`. Never share in chat, never commit.
- `REPORT_SECRET` — arbitrary password required as `?secret=` on `/api/admin/usage-report` so it isn't publicly scrapeable

---

## Critical patterns in server.js

```js
// Always normalize SB_URL
const SB_URL = (process.env.SUPABASE_URL || '').replace(/\/rest\/v1\/?$/, '');

// Language detection — detects script from text, falls back to declared lang
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

// Translation: translate to all room members' languages (from DB + WS)
// No hardcoded languages — purely based on who's actually in the room
const memberLangs = new Set([detected_lang]);
if (roomWs?.members) roomWs.members.forEach(m => memberLangs.add(m.lang));
const dbMembers = await sbQuery('room_members', `room_id=eq.${id}&select=lang`).catch(() => []);
dbMembers.forEach(m => { if (m.lang) memberLangs.add(m.lang); });
await Promise.all([...memberLangs].filter(l => l !== detected_lang).map(async lang => {
  // GPT-4o-mini: temperature:0, max_tokens:250, frequency_penalty:1.5, presence_penalty:0.5
  // Sanity check: reject if translation.length > original.length * 4 + 200
}));

// Audio endpoint: after Whisper transcription, re-detect language from actual script
if (original_text) detected_lang = detectScriptLang(original_text, detected_lang);

// On-demand translation save endpoint
// PATCH /api/rooms/:id/messages/:msgId/translation { lang, text }
// → fetches current translations, merges, PATCHes back to Supabase

// Always: sbInsert first, then broadcast via WS
```

## Critical patterns in room.html

```js
// Two maps: activeMembers (online, from WS) and allMembers (all known, from DB)
// renderMembers: me first (order:-1 CSS) → online → offline
// .member-chip.me { order: -1 } — own chip always rightmost in RTL flexbox

// On-demand translation: when a message has no translation in myLang,
// fetch it via /api/translate, update DOM, then PATCH to save in DB
async function fetchMissingTranslation(msg, div) { ... }

// toggleOrig: must use btn.closest('.bubble') not .bubble-inner
function toggleOrig(btn) {
  btn.closest('.bubble')?.querySelector('.bubble-original')?.classList.toggle('visible');
}

// linkify: escape HTML first, then replace URLs with <a> tags (color:#7dd3fc)
function linkify(html) { ... }
```

---

## Features implemented

### Welcome messages (4 messages on room creation)
- **Worf** 🖖 (worf.png avatar) — speaks actual Klingon (`sender_lang:'tlh'`), intro to Babel Fish
- **יעל** 👩🏽 (Hebrew) — mic button instructions
- **ليلى** 👩🏻‍🦱 (Arabic) — speaker button instructions
- **Alex** 👨🏻 (English) — globe button instructions
- All 4 have translations in he/ar/en/ru/am

### Translation pipeline
- `detectScriptLang()` detects Arabic/Hebrew/Cyrillic/Latin script
- Latin → `'en'`, no hardcoded target languages — uses room_members from DB
- On-demand: missing translations fetched client-side, persisted to DB
- New endpoint: `PATCH /api/rooms/:id/messages/:msgId/translation`

### Avatar
- settings.html: canvas 40×40 JPEG 0.75 upload
- Displayed in chip (22px), member panel (28px), message bubble (20px)
- Stored in `room_members.avatar` via `set_avatar` WS message

### Push notifications
- SW (`sw.js`) handles push + fetch (network-first)
- TARDIS sound (OGG) on new message, 1.5s
- 🔔/🔕 toggle (bf_mute_notify), 🔊/🔇 TTS toggle (bf_mute_tts)

### PWA / APK
- manifest.json with id, prefer_related_applications:false
- APK via PWA Builder → "Other Android"

### Feedback form
- `/feedback.html` — bilingual he/ar
- `POST /api/feedback`, `GET /api/feedback`

### UX
- RTL layout, own chip rightmost (order:-1)
- Enter to send, Shift+Enter newline
- Voice: tap to start recording (▶ icon), tap again to stop+send
- Long-press own message bubble → confirm → delete (DELETE /api/rooms/:id/messages/:msgId, sender-only, broadcasts message_deleted via WS)
- Admin moderation delete: `DELETE /api/admin/rooms/:id/messages/:msgId?secret=REPORT_SECRET` — deletes any message regardless of sender (for handling complaints), reuses the same message_deleted WS broadcast
- 🌐 toggle shows original, 🔊 speaks in user's lang
- Clickable links (#7dd3fc blue)
- user-select:none on body, text only on .bubble-text/.bubble-original
- Language selector: 5 main languages + "Other..." → 35 languages search
- viewport-fit=cover + env(safe-area-inset-bottom) for Android nav bar
- localStorage: bf_name, bf_lang, bf_emoji, bf_rooms, bf_mute_tts, bf_mute_notify

---

## Known fixes applied
- SUPABASE_URL double `/rest/v1` → normalize on startup
- Translation catch block must NOT set `translations[lang] = original_text`
- Chinese hallucination → frequency_penalty:1.5 + presence_penalty:0.5 + sanity check
- Hover tooltips → click-based on mobile
- autoGainControl:false → prevent first-word cutoff
- Latin text from Hebrew speaker → detectScriptLang returns 'en', translates correctly
- Worf avatar: special-case `msg.sender_name === 'Worf'` → `<img src="/worf.png">`

---

## משימות פתוחות

### מהבטה-טסטינג (עדיפות גבוהה)
- [x] **כפתור הקלטה** — tap להתחיל (▶ SEND icon), tap לעצור+לשלוח
- [x] **מחיקת הודעה ע"י הכותב** — לחיצה ארוכה על הודעה משלך → אישור → מחיקה (DELETE /api/rooms/:id/messages/:msgId)
- [x] **גלילה בטלפון** — תוקן: מאזין ה-scroll כבר לא מאלץ scrollBottom() ליד ההודעה האחרונה
- [x] **כניסה לחדר ללא הרשמה** — חסום (room.html דורש bf_name + bf_phone)
- [x] **הודעות גרבאג' בחאן אל-אחמר** — נמחקו
- [ ] **שם כפול אחרי שינוי שם** — username ישן נשאר בחדר, נוצרים שני entries
- [ ] **פידבק RTL באנדרואיד** — feedback.html מיושר שמאל באנדרואיד
- [ ] **לחיצה על שם קבוצה** — פותחת חיפוש/תרגום גוגל בטעות (feedback חדש)
- [ ] **הודעות ברוכים הבאים** בחאן אל-אחמר — לבדוק אם נכתבו מחדש אחרי מחיקת הגרבאג'

### תשתית
- [ ] **SQL migrations** — לוודא שהורצו ב-Supabase (ראה למעלה)
- [ ] **worf.png** — לוודא שהקובץ קיים ב-`public/worf.png` ונדחף ל-git
- [ ] **assetlinks.json** — אם רוצים TWA מלא עם Push ב-APK
