# AIS Middle Grades - Boys · Behaviour Management System — Netlify deployment

Al-Rowad International Schools · 100-point weekly retention system, 4C Skills Recognition, reports, hallway display.

## What's in this folder

| Path | What it is |
|---|---|
| `public/index.html` | The app: Class Deck, Home, Reports (Student Flags, Flags Summary, Weekly Summary + parent letters), Student Database (+ Master Scoresheet), Staff, Settings, Hallway Display (5 themes). |
| `public/db-adapter.js` | Connects the app to the server below. |
| `netlify/functions/db.mjs` | The server: sign-in (`/api/login`) and data (`/api/db`), stored in **Netlify Blobs** (built into Netlify). |
| `data/seed-data.json` | Your data exported on 30 Sep 2026: 237 students, 49 staff, all points, notes, 4C skills recognitions and Settings. Loaded automatically the **first time** the site runs. Keep a copy as a backup. |
| `netlify.toml`, `package.json` | Netlify build settings. |

## How sign-in works

- Staff open the site and sign in with **school email + E-number**. That's it: no access-key box.
- The server checks the details, so staff passwords are never sent to browsers, and the page source contains no passwords.
- A sign-in lasts **30 days** on that device, or until the person presses Sign out.
- Without signing in, the server returns no student data at all.
- Teachers can log behaviour and skills, and view everything. Only admins can change students, staff or Settings
  (enforced by the server, not just hidden in the page).

## One required setting: `ACCESS_KEY`

`ACCESS_KEY` is now a **hidden server secret** that nobody types in. The server uses it to sign everyone's sign-in pass.

- Netlify → your site → **Environment variables** → `ACCESS_KEY` = any long random text (keep the one you already set).
- Changing it later signs every device out (useful if a phone is lost). Redeploy after changing it.

## Deploy

Netlify **Drop (drag-and-drop) will not work**: the server part has to be built. Use either:

**GitHub (no terminal):** upload the *contents* of this folder to a private GitHub repo → in Netlify, Project
configuration → Build & deploy → Link repository → pick the repo, leave the build command empty → set
`ACCESS_KEY` (above) → Deploys → Trigger deploy.

**Command line (needs Node.js):**
```
npm install
npx netlify-cli login
npx netlify-cli link            (choose your existing site, e.g. aisbms-mg)
npx netlify-cli env:set ACCESS_KEY "a-long-random-secret"
npx netlify-cli deploy --build --prod
```

Your data from `data/seed-data.json` loads the first time the new version runs. If a working deploy has already
stored data, that data is kept: the seed file only ever fills an empty store, so redeploying never overwrites records.

## Built-in accounts

- Admin: `admin2627` / `2627` · Test teacher: `testteacher2627` / `2627`.
- **Change them before going live** with environment variables (then redeploy):
  `MASTER_ADMIN_USER`, `MASTER_ADMIN_PASSWORD`, `TEST_TEACHER_USER`, `TEST_TEACHER_PASSWORD`.
  To switch the test teacher off completely, set `TEST_TEACHER_USER` to `off`.

## Parent recognition letters (admin)

Reports → **Weekly Summary** → **Print student recognition letters**. A preview opens with one page per student
(Top 5 placing and every 4C skill with its subjects, in one letter), then **Download PDF** saves them all in one file.

## Resetting a student to all green (admin)

Admin → **Student Database** → **Master Scoresheet** → pick the week → **Reset** next to the student. This clears that week's deductions
(all Behaviour Conduct buttons turn green again) and restores 100 points. Skills recognitions stay. The removed
deductions are kept in an audit log on the student's record (who reset it, when, and what was removed), and they
no longer count in Reports or the Excel file.

## Good to know

- Staff E-numbers act as passwords. Anyone who knows a colleague's email and E-number can sign in as them.
- Other teachers' changes appear within ~15 seconds (instantly for your own). Simultaneous saves are merged safely.
- The claude.ai version is separate and does not sync. Once this site is live, move everyone to it.
- Backups: download the Excel report weekly (Reports → Download Excel report). Live data is in Netlify Blobs,
  store `g8-discipline-tracker`.
- Each open device checks for updates every 15 s while visible. Keep an eye on Usage in Netlify if you run
  hallway screens all day.
