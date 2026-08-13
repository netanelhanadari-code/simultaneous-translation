# Babel Fish — Project Context

## What this is
Real-time multilingual IM app. Users join rooms, send voice or text messages, and every message is translated to all connected members' languages and read aloud via TTS.

## Stack
- **Backend:** Node.js + Express + WebSocket (`ws`) on Render.com
- **AI:** OpenAI Whisper (STT) + GPT-4o-mini (translation)
- **DB:** Supabase (direct REST fetch calls — no JS client)
- **Frontend:** Vanilla JS, Web Speech API for TTS

## Key files
- `server.js` — Express server, WebSocket hub, translation logic, Supabase REST calls
- `public/home.html` — Landing page: enter name/lang, create/join rooms, saved rooms list
- `public/room.html` — Main chat room: members bar, messages, text input, voice recording
- `public/settings.html` — User settings: name, emoji, language preference
- `public/broadcaster.html` — Live event one-way broadcast mode
- `public/listener.html` — Listener for live event broadcasts

## Database (Supabase)
Three tables, RLS disabled on all:
```sql
rooms (id text PK, name text, created_at)
messages (id uuid PK, room_id, sender_name, sender_emoji, sender_lang, original_text, translations jsonb, created_at)
room_members (room_id, name, emoji, lang, last_seen, PRIMARY KEY (room_id, name))
```

## Environment variables (on Render)
- `OPENAI_API_KEY` — never share in chat
- `SUPABASE_URL` — the raw project URL (strip trailing /rest/v1 in code)
- `SUPABASE_ANON_KEY`

## Critical patterns in server.js
```js
// Always normalize SB_URL to strip accidental /rest/v1 suffix
const SB_URL = (process.env.SUPABASE_URL || '').replace(/\/rest\/v1\/?$/, '');

// Translation: parallel — all room members' langs (from DB + WS) + detected lang
const memberLangs = new Set([detected_lang]);
if (roomWs?.members) roomWs.members.forEach(m => memberLangs.add(m.lang));
const dbMembers = await sbQuery('room_members', `room_id=eq.${id}&select=lang`).catch(() => []);
dbMembers.forEach(m => { if (m.lang) memberLangs.add(m.lang); });
await Promise.all([...memberLangs].filter(l => l !== detected_lang).map(async lang => {
  // GPT-4o-mini with temperature:0, max_tokens:250, frequency_penalty:1.5, presence_penalty:0.5
  // Sanity check: reject if translation.length > original.length * 4 + 200
}));

// Always insert to DB first (sbInsert), then broadcast via WS
```

## Critical pattern in room.html
```js
// Two maps: activeMembers (online, from WS) and allMembers (all known, from DB)
// renderMembers merges both → me first (order:-1 CSS) → online → offline
// .member-chip.me { order: -1 } — ensures own chip is always rightmost in RTL flexbox

// toggleOrig: must use btn.closest('.bubble') not .bubble-inner
function toggleOrig(btn) {
  btn.closest('.bubble')?.querySelector('.bubble-original')?.classList.toggle('visible');
}
```

## Known fixes applied
- SUPABASE_URL double `/rest/v1` path → normalize on startup
- Translation catch block must NOT set `translations[lang] = original_text` (causes wrong-language display)
- Chinese character hallucination → frequency_penalty:1.5 + presence_penalty:0.5 + sanity check
- Hover tooltips don't work on mobile → use click-based tooltips instead
- sender_emoji column: `alter table messages add column if not exists sender_emoji text default ''`
- autoGainControl: false on getUserMedia to prevent first-word cutoff

## User preferences / UX decisions
- RTL layout (Hebrew/Arabic first-class)
- Own chip always rightmost in members bar (order:-1 in RTL flex)
- Text input: Enter to send, Shift+Enter for newline
- Voice: hold button to record
- Show original text toggle (🌐) on each message bubble
- Emoji avatar: free text input (paste any emoji), stored in localStorage as `bf_emoji`
- localStorage keys: `bf_name`, `bf_lang`, `bf_emoji`, `bf_rooms`
- Saved rooms in home.html (max 10, stored in bf_rooms)

## Deployment
Git push to main → Render auto-deploys.
```
git add -A && git commit -m "..." && git push
```
