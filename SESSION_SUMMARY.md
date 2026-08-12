# Babel Fish — סיכום סשן (להמשך מחר)

## מה נעשה בסשן זה

### תמונת פרופיל (Avatar)
- **settings.html**: העלאת תמונה (canvas 40×40 JPEG 0.75), מחליפה אימוג'י — כשיש תמונה קטע האימוג'י מוסתר
- **room.html**: תמונה מוצגת בצ'יפ (22px), בשורת פאנל (28px), וליד בועות הודעה (20px)
- **server.js**: `set_avatar` מעדכן DB (`room_members.avatar`) → תמונה גלויה גם כשמשתמש לא מחובר
- **SQL נדרש** (אם עוד לא הורץ):
  ```sql
  alter table room_members add column if not exists avatar text default '';
  ```

### push_subscriptions
- **SQL נדרש** (אם עוד לא הורץ):
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
- **Badge צף סגול** `↓ 3 הודעות חדשות` מופיע כשמגיעות הודעות והמשתמש לא בתחתית
- לחיצה על הbadge → קופץ לתחתית ומוחק ספירה
- גלילה ידנית לתחתית → badge נעלם
- **קו מפריד** `.unread-sep` בתוך הצ'אט כשחוזרים לטאב אחרי היעדרות
- **כותרת טאב** `(3) Babel Fish — שם החדר` בעת היעדרות

### תצוגת הודעות
- **הודעות שלי**: תמיד מוצגות כפי שנכתבו (לא מתורגמות לשפת הממשק שלי)
- כפתור 🌐 "הצג מקור" מוסתר בהודעות של עצמך

### זיהוי שפה לתרגום
- **לקוח**: שולח תמיד `sender_lang: myLang` (פשוט, ללא auto-detect)
- **שרת**: `detectScriptLang()` מזהה ערבית/עברית/רוסית מהטקסט בפועל, משתמש בזה לתרגום — פותר את הבעיה שמשתמש אנגלי כותב עברית ותרגום לא מגיע

### ממשק
- **Splash screen**: קוצר מ-2200ms ל-1200ms בכל הדפים (home, broadcaster, listener)
- **כותרות**: כל הדפים עם `| עומדים ביחד | نقف معاً`
- **manifest.json**: שם עודכן לכלול `نقف معاً`
- **listener.html**: קוד המפגש (roomId) מוצג בבירור בראש הדף עם badge סגול
- **listener.html**: בחירת שפה חובה לפני התחלת האזנה (אחרת פוקוס קופץ ל-select)
- **listener.html**: ברירת מחדל עברית אם הגיעה הודעה ו-langSelect ריק
- **TTS על צ'יפ**: זיהוי שפה לפי תווים (ערבית/עברית/לטינית) במקום שפת התקשורת

### iOS Push
- לא מנסה auto-subscribe על iOS שאינו standalone (מונע שגיאות)

---

## מצב קבצים נוכחי

| קובץ | שינויים עיקריים |
|------|----------------|
| `public/room.html` | avatar, unread badge, הודעות עצמי, detectScriptLang לקוח הוסר |
| `public/settings.html` | avatar upload 40×40, emoji מוסתר כשיש avatar |
| `public/listener.html` | roomId badge, שפה חובה, ברירת מחדל עברית |
| `public/home.html` | splash 1200ms |
| `public/broadcaster.html` | splash 1200ms |
| `public/manifest.json` | שם עם نقف معاً |
| `server.js` | detectScriptLang(), avatar ל-DB, push improvements |

---

## מה עוד לא נעשה / כדאי לבדוק

1. **SQL migrations** — לוודא שהרצת שניהם ב-Supabase:
   - `alter table room_members add column if not exists avatar text default '';`
   - יצירת טבלת `push_subscriptions`

2. **בדיקת DM** — הקוד נראה שלם אבל לא נבדק בפועל מקצה לקצה

3. **תמונה נשמרת ב-DB** — רק אחרי שמשתמש נכנס לחדר ושולח `set_avatar`. משתמשים שהעלו תמונה לפני המיגרציה — יצטרכו להיכנס פעם אחת לחדר כדי לסנכרן

4. **iOS PWA** — Push עובד רק ב-Safari 16.4+ עם הוספה למסך הבית. הבאנר קיים ומציג הנחיות

5. **broadcaster/listener** — לבדוק שהתרגום מאנגלית עובד (תוקן ב-listener: ברירת מחדל עברית)

---

## Stack תזכורת
- Backend: Node.js + Express + WebSocket על Render.com
- AI: OpenAI Whisper (STT) + GPT-4o-mini (תרגום)
- DB: Supabase (REST fetch ישיר)
- Frontend: Vanilla JS, RTL עברית/ערבית, LTR אנגלית
- Deploy: `git add -A && git commit -m "..." && git push`
