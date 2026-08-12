# Babel Fish — סיכום סשן (להמשך)

## כללי עבודה
- **לפני כל שינוי קוד** — לסכם מה הובן ומה יצא, ולחכות לאישור מנתי.

---

## מה נעשה בסשן הקודם

### תמונת פרופיל (Avatar)
- **settings.html**: העלאת תמונה (canvas 40×40 JPEG 0.75), מחליפה אימוג'י
- **room.html**: תמונה מוצגת בצ'יפ (22px), בשורת פאנל (28px), וליד בועות הודעה (20px)
- **server.js**: `set_avatar` מעדכן DB (`room_members.avatar`)
- **SQL נדרש**: `alter table room_members add column if not exists avatar text default '';`

### push_subscriptions
- **SQL נדרש**:
  ```sql
  create table if not exists push_subscriptions (
    room_id text not null, name text not null, lang text default 'he',
    subscription jsonb not null, created_at timestamptz default now(),
    primary key (room_id, name)
  );
  alter table push_subscriptions enable row level security;
  create policy "anon all" on push_subscriptions for all using (true) with check (true);
  ```

### הודעות שלא נקראו
- Badge צף סגול + קו מפריד + כותרת טאב

### זיהוי שפה לתרגום
- `detectScriptLang()` בשרת מזהה ערבית/עברית/רוסית מהטקסט

---

## מה נעשה בסשן הנוכחי

### כפתורי שתיקה
- **🔊/🔇 TTS** — כפתור toggle, נשמר ב-`bf_mute_tts`, אייקון משתנה
- **🔔/🔕 התרעות** — כפתור toggle, נשמר ב-`bf_mute_notify`
- **צליל התרעה** — קובץ OGG (HHG2G), מנגן 1.5 שניות, נמצא ב-`public/`
- לחיצה על 🔔 בהפעלה → מנגן דמו קצר
- כשמגיעה הודעה מאחר: TARDIS → TTS (עצמאיים)

### PWA / Android APK
- `home.html` רשום כ-start_url ו-`/` מפנה אליו
- SW רשום גם מ-`home.html`
- `manifest.json`: נוסף `id`, `prefer_related_applications:false`, icons מתוקנים
- `sw.js`: נוסף fetch handler (network-first)
- נוצר APK דרך PWA Builder → "Other Android"

### טופס פידבק
- `/feedback.html` — טופס דו-לשוני עברית/ערבית, שני שפות זו לצד זו
- **SQL נדרש**:
  ```sql
  create table if not exists feedback (
    id uuid primary key default gen_random_uuid(),
    name text not null, room_id text, device text,
    severity text default 'low', what_happened text not null,
    expected text, created_at timestamptz default now()
  );
  ```
- `POST /api/feedback` + `GET /api/feedback` ב-server.js
- קישור: `https://simultaneous-translation.onrender.com/feedback.html`

### תיקון Android text selection
- `user-select: none` על `body` ב-room.html
- `user-select: text` רק על `.bubble-text` ו-`.bubble-original`

### בחירת שפה — settings.html
- Dropdown עם 5 שפות מרכזיות: עברית, ערבית, English, Русский, አማርኛ
- אפשרות "אחר / Other..." → פותח חיפוש חופשי עם 35 שפות
- `LANG_BCP47` ב-room.html הורחב ל-35 שפות

---

## מצב קבצים נוכחי

| קובץ | שינויים עיקריים |
|------|----------------|
| `public/room.html` | TTS+notify toggles, user-select fix, LANG_BCP47 מורחב |
| `public/settings.html` | language selector עם dropdown + חיפוש חופשי |
| `public/home.html` | SW registration, splash 1200ms |
| `public/feedback.html` | טופס דו-לשוני חדש |
| `public/sw.js` | push handler + fetch handler |
| `public/manifest.json` | id, prefer_related_applications, icons מתוקנים |
| `server.js` | /api/feedback endpoints, redirect / → home.html |

---

## מה עוד לא נעשה / כדאי לבדוק

1. **SQL migrations** — לוודא שהרצת ב-Supabase:
   - `avatar` column ב-room_members
   - טבלת `push_subscriptions`
   - טבלת `feedback`

2. **דיווחי פידבק פתוחים** (מה שהגיע בטופס):
   - ~~לחיצה על טקסט → Google search~~ ✓ תוקן
   - ~~פורטוגזית/שפות נוספות~~ ✓ תוקן
   - הודעות גרבאג' בחאן אל-אחמר — למחוק + לכתוב ברוכים הבאים בכמה שפות
   - כניסה לחדר ללא הרשמה — לבדוק אם רוצה לחסום

3. **APK** — להפיץ לבודקים (הורד מ-PWA Builder)

4. **assetlinks.json** — אם רוצים TWA מלא עם Push ב-APK

---

## Stack תזכורת
- Backend: Node.js + Express + WebSocket על Render.com
- AI: OpenAI Whisper (STT) + GPT-4o-mini (תרגום)
- DB: Supabase (REST fetch ישיר)
- Frontend: Vanilla JS, RTL עברית/ערבית
- Deploy: `git add -A; git commit -m "..."; git push`
