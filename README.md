# Infeed

A TikTok-style knowledge feed, packaged as an Android app (Capacitor) backed by a
Node.js + SQLite API.

```
infeed/
├── app/                 Capacitor Android wrapper (bundle id: com.infeed.app)
│   ├── www/index.html   The feed UI (fetches cards from the backend)
│   ├── capacitor.config.json
│   └── android/         Generated native Android project
├── server/              Node.js backend (API, auth, SQLite, free trial)
│   ├── server.js
│   ├── db.js
│   └── .env.example
└── seed.html            Admin tool — generates cards with Claude and POSTs them to the backend
```

## 1. Backend

```powershell
cd server
Copy-Item .env.example .env      # then edit .env: set JWT_SECRET and SEED_ADMIN_KEY
npm install
npm start                        # listens on http://localhost:3000
```

SQLite lives in `server/infeed.db` (created automatically; uses Node's built-in
`node:sqlite`, so there is **no native build step**).

### API

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| POST | `/api/auth/register` | — | Create account `{email, password}` → `{token, user}` |
| POST | `/api/auth/login` | — | Log in → `{token, user}` |
| GET | `/api/me` | Bearer JWT | Current user + today's usage |
| GET | `/api/cards?limit&exclude&prefer` | Bearer JWT | Serve cards; blocked once the free trial expires |
| POST | `/api/cards/seen` | Bearer JWT | Mark cards seen — `{ id }` or `{ ids: [...] }` |
| POST | `/api/cards/:id/save` | Bearer JWT | Bookmark a card |
| DELETE | `/api/cards/:id/save` | Bearer JWT | Remove a bookmark |
| GET | `/api/saved` | Bearer JWT | List the user's bookmarked cards (newest first) |
| POST | `/api/seed` | admin | Insert one card or `{cards:[...]}` (dedupes by headline) |
| GET | `/api/admin/cards` | admin | List all cards |
| DELETE | `/api/admin/cards/:id` | admin | Delete one card |
| DELETE | `/api/admin/cards` | admin | Clear the library |

**Auth:** users send `Authorization: Bearer <jwt>`. Admin endpoints accept either the
shared `x-admin-key: <SEED_ADMIN_KEY>` header (used by `seed.html`) or a JWT belonging
to a user with `is_admin = 1`.

**Seen cards:** tracking is **view-based**. Serving a card does *not* mark it seen —
the app calls `POST /api/cards/seen { id }` when a card actually scrolls into view, and
only then is it recorded in `user_seen_cards`. `/api/cards` excludes a user's confirmed-
seen cards (plus the client's in-session `exclude` hint, which prevents re-serving cards
that were preloaded but not yet viewed). A card that's preloaded but never scrolled to
can therefore reappear in a later session — by design. When no cards remain available,
the response is `{ cards: [], caughtUp: true }` and the app shows a "You're all caught
up — check back tomorrow" screen. Clearing the library (admin) also resets everyone's
seen history so a re-seeded library is fresh.

**Saved cards:** the feed's Save button bookmarks a card server-side via
`POST/DELETE /api/cards/:id/save` (stored per user in `user_saved_cards`). The **Saved**
tab fetches `GET /api/saved` and lists them newest-first, where each can be removed.
Bookmarks are independent of seen-tracking, so a saved card stays accessible from the
Saved tab even after it leaves the feed.

**Free trial:** new `free`-tier users get an unlimited trial for `TRIAL_DAYS` days
(default 14), measured from their signup date. Once it expires, `/api/cards` returns
HTTP **402** with `{ trialExpired: true }` and the app shows a "subscribe" screen.
`/api/me` and `/api/cards` both report trial status: `{ onTrial, expired, daysLeft,
trialEndsAt }`. Set a user's `tier` to anything other than `'free'` (e.g. `'paid'`) to
mark them a subscriber — unlimited, never expires. Payment/subscription handling is not
yet wired up; expiry is only flagged.

## 2. Seeding cards (`seed.html`)

Open `seed.html` in a browser. Fill in:
- **Backend URL** — e.g. `http://localhost:3000`
- **Admin key** — must match `SEED_ADMIN_KEY` in `server/.env`
- **Anthropic API key** — used directly from the browser to generate cards (Claude + web search)

Generated cards are POSTed to `/api/seed`. The library view, delete, and clear all
operate against the backend.

## 3. Android app

The feed UI is `app/www/index.html`. It talks to the backend at:
- `http://10.0.2.2:3000` when running in the Android emulator (the host machine)
- `http://localhost:3000` in a desktop browser

Override for a real device or production:
```js
localStorage.setItem('infeedApiBase', 'https://api.yourdomain.com')
```

### Build / run

```powershell
cd app
npx cap sync android        # copy www/ into the native project after any UI change
npx cap open android        # opens Android Studio  (requires Android Studio + SDK)
```

Then Run ▶ from Android Studio, or from the CLI once the SDK is installed:
```powershell
cd app/android
./gradlew assembleDebug      # APK -> app/build/outputs/apk/debug/
```

> Building requires Android Studio (or the Android SDK + JDK 17) and a Gradle download.
> The web layer, backend, and `seed.html` all run without it.

### Cleartext note

`app/android/app/src/main/res/xml/network_security_config.xml` permits plain HTTP only
to `10.0.2.2` / `localhost` / `127.0.0.1` for local development. Production traffic must
be HTTPS. Point `infeedApiBase` at an `https://` URL for release builds.
