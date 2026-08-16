# Babel Fish — Project Context

## כללי עבודה (חובה)
1. **לפני כל שינוי קוד** — לסכם מה הובן ומה מתוכנן לשנות, ולשאול "לכתוב?" לפני כתיבת קוד. לא לבצע שינויים ביוזמה עצמית.
2. **שפה:** כאשר יש פקודות מעורבות — לכתוב הכל באנגלית. שיחה עקרונית בלבד — אפשר בעברית.
3. **PowerShell בלבד:** פקודות git ו-shell חייבות להיות תואמות PowerShell. אין `&&` — שימוש ב-`;` או שורות נפרדות. `Move-Item` במקום `mv`, `Remove-Item` במקום `rm`.
4. **אין Preview ואין הצגת קבצים:** לא לשלוח SendUserFile לשום קובץ (HTML, txt, או אחר) — לא להציג תוצר, לא "transfer only". לשמור ישירות ל-device ולתת פקודת push בלבד. אם רוצים UUID לצורך device_commit_files — להשתמש בשם קובץ שלא יגרום ל-render, אך גם אז לא לשלוח ל-user.
5. **פתיחת יום:** בתחילת כל סשן — לתת סקירה קצרה: מה פתוח (משימות), מה התווסף לפידבק מאז הסשן הקודם.

---

## What this is
Real-time multilingual IM app. Users join rooms, send voice or text messages, and every message is translated to all connected members' languages and read aloud via TTS.

## Stack
- **Backend:** Node.js + Express + WebSocket (`ws`) on Render.com
- **AI:** OpenAI Whisper (STT) + GPT-4o-mini (translation)
- **DB:** Supabase (direct REST fetch calls — no JS client)
- **Frontend:** Vanilla JS, Web Speech API for TTS
- **Deploy:** `git add -A; git commit -m "..."; git push` → Render auto-deploys
- **⚠️ בתחילת session חדש:** לוודא ש-`git status` נקי — יכול להיות שיש שינויים מקומיים מ-session קודם שעדיין לא נדחפו (אין לכלי גישת git ישירה לתיקייה, ההנחיה תמיד היתה שהמשתמש ידחוף ידנית)

## Key files
- `server.js` — Express server, WebSocket hub, translation logic, Supabase REST calls
- `public/home.html` — Landing page: enter name/lang, create/join rooms, saved rooms list
- `public/room.html` — Main chat room: members bar, messages, text input, voice recording
- `public/settings.html` — User settings: name, emoji, language preference, avatar upload
- `public/feedback.html` — Bilingual (he/ar) feedback form
- `public/admin.html` — Password-gated admin dashboard (enter REPORT_SECRET once): flagged messages + delete, API cost report, feedback list. Not linked from anywhere in the app nav — direct URL only
- `public/broadcaster.html` — Live event one-way broadcast mode
- `public/listener.html` — Listener for live event broadcasts
- `תסריט וידאו - Babel Fish.md` — script for a 2:30-3:00 explainer video (Hebrew), aimed at עומדים ביחד members, for a landing page. Not yet produced.

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

alter table messages add column if not exists flagged boolean default false;
alter table messages add column if not exists flagged_reason text;
alter table messages add column if not exists edited boolean default false;
alter table messages add column if not exists edited_at timestamptz;
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

### Admin dashboard (`public/admin.html`)
- Password-gated (REPORT_SECRET entered once, kept in memory only — not stored)
- Tabs: 🚩 flagged messages (list + delete button), 💰 API cost report (7/30/90 days, via `/api/admin/usage-report`), 📝 feedback list
- Not linked anywhere in app nav — direct URL only

### API cost report
- `GET /api/admin/usage-report?secret=REPORT_SECRET&days=N` — calls OpenAI's org Costs API with `OPENAI_ADMIN_KEY` (must be a restricted, usage-read-only admin key), returns total + per-day breakdown
- Sum uses `parseFloat()` on each `amount.value` before adding — without it JS string-concatenates instead of summing and `total_usd` comes back `null`

### Rename a user across all their rooms
- `POST /api/rename-member { phone, oldName, newName }` — identity anchored by phone (the only stable ID we have, since `name` is the room_members PK and messages.sender_name is plain text)
- Reattributes all past messages (`sender_name`) + merges the room_members row into the new name, per room the phone+oldName combo is found in
- Wired into settings.html's `save()`: if the name changed and both old name + phone existed, calls this before redirecting
- Broadcasts `member_renamed` via WS so open room.html tabs update live (member list + already-rendered bubble sender names)

### Whisper silence hallucination fix (voice messages)
- Whisper hallucinates boilerplate ("thank you", "subscribe") on silent/near-silent audio
- Server: `response_format: verbose_json` → average `no_speech_prob` across segments; if >0.6, message is dropped regardless of transcribed text. Hallucination blacklist changed from exact-match to substring `includes()`, list expanded
- Client: Web Audio API measures RMS volume during recording (every 150ms); if the whole recording never exceeded a silence threshold, it's never even uploaded to Whisper (saves the API call too)

### Android WebView/TWA viewport height instability
- `100dvh` alone is unreliable right after a fresh page load (before browser chrome finishes settling) — caused the record button to hide behind the Android nav bar on refresh, and home.html's footer to render too short right after refresh (but fine on in-app navigation)
- Fix in both room.html and home.html: JS computes `--vh` from `window.innerHeight`/`visualViewport.height`, updates on resize/orientationchange, used as `calc(var(--vh, 1vh) * 100)` instead of trusting `100dvh` alone
- Also removed `will-change: scroll-position` from `#messages` (suspected compositing jank contributor)

### Scroll-fights-user bug (fixed)
- The `scroll` listener on `#messages` called `dismissUnread()` (which force-set `scrollTop = scrollHeight`) any time within 60px of the bottom — so a slow drag away from the last message got yanked back on every scroll event; only a fast flick had enough velocity to escape
- Fixed by splitting into `clearUnreadState()` (badge-hiding only, used by the passive scroll listener) vs `dismissUnread()` (badge-hiding + scroll-to-bottom, only for the explicit "new messages" badge tap)

### Home screen splash
- Only replays on first load of the session or an explicit refresh (`performance.getEntriesByType('navigation')[0].type === 'reload'`) — not on back-navigation from a room, via a sessionStorage flag

### UX
- RTL layout, own chip rightmost (order:-1)
- Enter to send, Shift+Enter newline
- Voice: tap to start recording (▶ icon), tap again to stop+send
- Long-press own message bubble → action menu (✏️ ערוך / 🗑️ מחק), extensible for future actions
  - Edit: PATCH /api/rooms/:id/messages/:msgId {name, text} — sender-only, re-detects language, re-runs moderation, re-translates to all room languages, sets edited/edited_at, broadcasts message_edited via WS
  - Delete: DELETE /api/rooms/:id/messages/:msgId, sender-only, broadcasts message_deleted via WS
- Admin moderation delete: `DELETE /api/admin/rooms/:id/messages/:msgId?secret=REPORT_SECRET` — deletes any message regardless of sender (for handling complaints), reuses the same message_deleted WS broadcast
- Auto content moderation: every text/voice message is checked against OpenAI's Moderation API (`omni-moderation-latest`) on save. Never blocks sending — only sets `flagged`/`flagged_reason` on the row. Review via `GET /api/admin/flagged-messages?secret=REPORT_SECRET`, delete via the admin delete endpoint above
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
- [x] **שם כפול אחרי שינוי שם** — נבנה `/api/rename-member`, מחובר ל-settings.html; מעביר הודעות + ממזג את room_members לפי טלפון
- [x] **לחיצה על שם קבוצה** — המשתמש אישר שזה כבר טופל (ללא שינוי קוד נדרש בפועל — הפיך אם יעלה שוב)
- [x] **סינון הזיות Whisper בשקט** — no_speech_prob + בדיקת ווליום בלקוח + הרחבת רשימת ביטויים
- [x] **גלילה רועדת בטלפון** — תוקן (ראו "Scroll-fights-user bug" למעלה)
- [x] **כפתור הקלטה מתחבא מאחורי שורת ניווט אנדרואיד** — תוקן (ראו "Android WebView/TWA viewport height instability" למעלה)
- [x] **עריכת הודעה** — נבנה, לחיצה ארוכה → תפריט (✏️ ערוך / 🗑️ מחק)
- [x] **דיווח הוצאות API + בקרת תוכן פוגעני** — נבנה admin.html + moderation אוטומטי
- [x] **פידבק RTL באנדרואיד** — תוקן: הוסרה `direction:rtl` מה-`body`, הועברה ל-`.wrap` בלבד
- [x] **user-select:none** — נוסף לכל הדפים (room.html, admin.html, feedback.html) למניעת popup גוגל בלחיצה ארוכה
- [x] **Admin dashboard** — נוסף טאב דשבורד ראשי עם 4 כרטיסים: מסומנות / עלות API / סטורג' / פידבק
- [x] **Feedback checkboxes** — נוספו checkboxes לטאב הפידבק בadmin, מתמידים ב-localStorage
- [ ] **Image upload** — קוד מוכן ב-server.js ו-room.html, **אך צריך:**
  - צור bucket בשם `images` ב-Supabase (Public, allow anon upload)
  - הרץ migration: `alter table messages add column if not exists image_url text;`
- [x] **Bug: feedback checkboxes מתאפסים** — תוקן: הוסף `input[type="checkbox"]` לרשימת user-select:text; key אוחד ל-`f.created_at || f.id || ''`
- [x] **feedback.html** — נכתב מחדש לגמרי (FROM SCRATCH): עיצוב חדש, RTL נקי ללא `dir="rtl"` על html, splash screen זהה ל-home.html (שני לוגואים: logo.png + babel-fish.png), שדות מדויקים לפי DB
- [ ] **הודעות ברוכים הבאים** בחאן אל-אחמר — לבדוק אם נכתבו מחדש אחרי מחיקת הגרבאג'
- [ ] **וידאו הדגמה** — תסריט מוכן (`תסריט וידאו - Babel Fish.md`), עדיין לא צולם/הופק

### תשתית
- [x] **SQL migrations** — הורצו ב-Supabase (flagged/edited/avatar/push_subscriptions/feedback)
- [x] **worf.png** — קיים ב-`public/worf.png`
- [ ] **assetlinks.json** — אם רוצים TWA מלא עם Push ב-APK
