// ─────────────────────────────────────────────────────────────
//  Infeed backend
//    POST /api/auth/register   { email, password }            -> { token, user }
//    POST /api/auth/login      { email, password }            -> { token, user }
//    GET  /api/me              (auth)                          -> { user, trial }
//    GET  /api/cards           (auth) ?limit&exclude&prefer    -> { cards, tier, trial, caughtUp }  (402 if trial expired)
//    POST /api/cards/seen      (auth)  { id } | { ids: [...] }  -> { recorded }   (app confirms a card scrolled into view)
//    POST /api/cards/:id/save  (auth)                           -> { saved: true }
//    DELETE /api/cards/:id/save(auth)                           -> { saved: false }
//    GET  /api/saved           (auth)                           -> { cards }       (user's bookmarked cards)
//    POST /api/seed            (admin) card | { cards: [...] }  -> { inserted, skipped }
//    GET  /api/admin/cards     (admin)                          -> { total, cards }
//    DELETE /api/admin/cards/:id (admin)                        -> { deleted }
//    DELETE /api/admin/cards   (admin)                          -> { deleted }  (clear all)
// ─────────────────────────────────────────────────────────────

// --- tiny .env loader (no dependency) ---
const fs = require('fs');
const path = require('path');
(() => {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([\w.]+)\s*=\s*(.*)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    let val = m[2].trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(m[1] in process.env)) process.env[m[1]] = val;
  }
})();

const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { db, rowToCard } = require('./db');

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || 'localhost';
const TRIAL_DAYS = parseInt(process.env.TRIAL_DAYS || '14', 10);
const SEED_ADMIN_KEY = process.env.SEED_ADMIN_KEY || 'dev-admin-key-change-me';
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
if (JWT_SECRET === 'dev-secret-change-me') {
  console.warn('⚠  JWT_SECRET not set — using an insecure default. Set it in server/.env for production.');
}

const app = express();
app.use(express.json({ limit: '1mb' }));

// --- permissive CORS (the app runs from a capacitor:// / file:// origin) ---
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-admin-key');
  res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ── helpers ──
const DAY_MS = 24 * 60 * 60 * 1000;
const publicUser = (u) => ({ id: u.id, email: u.email, tier: u.tier, isAdmin: !!u.is_admin });

// Free users get a TRIAL_DAYS-day unlimited trial from their signup date.
// Any non-'free' tier is a paid subscriber: unlimited, never expires.
function trialStatus(user) {
  if (user.tier !== 'free') {
    return { tier: user.tier, onTrial: false, expired: false, daysLeft: null, trialEndsAt: null };
  }
  // created_at is stored as UTC 'YYYY-MM-DD HH:MM:SS'
  const start = Date.parse(user.created_at.replace(' ', 'T') + 'Z');
  const end = start + TRIAL_DAYS * DAY_MS;
  const msLeft = end - Date.now();
  return {
    tier: 'free',
    onTrial: true,
    expired: msLeft <= 0,
    daysLeft: Math.max(0, Math.ceil(msLeft / DAY_MS)),
    trialEndsAt: new Date(end).toISOString(),
  };
}

function signToken(user) {
  return jwt.sign({ uid: user.id }, JWT_SECRET, { expiresIn: '30d' });
}

// Auth middleware — verifies the Bearer JWT and loads the user.
function requireAuth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing auth token' });
  try {
    const { uid } = jwt.verify(token, JWT_SECRET);
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(uid);
    if (!user) return res.status(401).json({ error: 'User not found' });
    req.user = user;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// Admin middleware — accepts either the shared admin key header or an admin user's JWT.
function requireAdmin(req, res, next) {
  const key = req.headers['x-admin-key'];
  if (key && key === SEED_ADMIN_KEY) return next();
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (token) {
    try {
      const { uid } = jwt.verify(token, JWT_SECRET);
      const user = db.prepare('SELECT * FROM users WHERE id = ?').get(uid);
      if (user && user.is_admin) { req.user = user; return next(); }
    } catch { /* fall through */ }
  }
  return res.status(403).json({ error: 'Admin credentials required' });
}

// ── auth routes ──
app.post('/api/auth/register', (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'Invalid email' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (existing) return res.status(409).json({ error: 'Email already registered' });

  const hash = bcrypt.hashSync(password, 10);
  const info = db.prepare('INSERT INTO users (email, password_hash) VALUES (?, ?)').run(email, hash);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
  res.json({ token: signToken(user), user: publicUser(user) });
});

app.post('/api/auth/login', (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }
  res.json({ token: signToken(user), user: publicUser(user) });
});

app.get('/api/me', requireAuth, (req, res) => {
  res.json({ user: publicUser(req.user), trial: trialStatus(req.user) });
});

// ── cards (auth + daily cap) ──
app.get('/api/cards', requireAuth, (req, res) => {
  const user = req.user;
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 2, 1), 10);

  // excluded headlines the client has already seen
  let exclude = [];
  if (req.query.exclude) {
    try { exclude = JSON.parse(req.query.exclude); }
    catch { exclude = String(req.query.exclude).split('|'); }
  }
  if (!Array.isArray(exclude)) exclude = [];
  // preferred categories (personalisation hint)
  let prefer = [];
  if (req.query.prefer) {
    try { prefer = JSON.parse(req.query.prefer); } catch { prefer = String(req.query.prefer).split(','); }
  }
  if (!Array.isArray(prefer)) prefer = [];

  // enforce the free trial (paid tiers are unlimited)
  const trial = trialStatus(user);
  if (trial.expired) {
    return res.status(402).json({
      error: 'Free trial expired', trialExpired: true, cards: [],
      tier: user.tier, trial,
    });
  }
  const wanted = limit;

  // build query: skip cards this user has already been served (tracked server-side),
  // also honour the client's optional exclude hint, bias toward preferred categories.
  const excl = exclude.filter(h => typeof h === 'string').slice(0, 500);
  const pref = prefer.filter(c => typeof c === 'string').slice(0, 10);
  const params = [];
  let where = 'id NOT IN (SELECT card_id FROM user_seen_cards WHERE user_id = ?)';
  params.push(user.id);
  if (excl.length) { where += ` AND headline NOT IN (${excl.map(() => '?').join(',')})`; params.push(...excl); }
  let orderBias = '';
  if (pref.length) {
    orderBias = `CASE WHEN category IN (${pref.map(() => '?').join(',')}) THEN 0 ELSE 1 END, `;
    params.push(...pref);
  }
  params.push(wanted);
  const rows = db.prepare(
    `SELECT * FROM cards WHERE ${where} ORDER BY ${orderBias} RANDOM() LIMIT ?`
  ).all(...params);

  // NB: cards are NOT marked seen here — the app confirms a view via
  // POST /api/cards/seen once a card actually scrolls onto the screen.

  const cards = rows.map(rowToCard);
  // "caught up" = the library has cards, but none are available for this user
  let caughtUp = false;
  if (cards.length === 0) {
    const total = db.prepare('SELECT COUNT(*) AS c FROM cards').get().c;
    caughtUp = total > 0;
  }

  res.json({ cards, tier: user.tier, trial, caughtUp });
});

// Mark cards as actually seen. The app calls this when a card scrolls into view,
// so we only remember cards the user really looked at (not ones merely preloaded).
app.post('/api/cards/seen', requireAuth, (req, res) => {
  let ids = Array.isArray(req.body.ids) ? req.body.ids
    : (req.body.id != null ? [req.body.id] : []);
  ids = ids.map(n => parseInt(n, 10)).filter(Number.isInteger);
  if (!ids.length) return res.json({ recorded: 0 });
  const remember = db.prepare('INSERT OR IGNORE INTO user_seen_cards (user_id, card_id) VALUES (?, ?)');
  let recorded = 0;
  for (const id of ids) recorded += remember.run(req.user.id, id).changes;
  res.json({ recorded });
});

// ── saved cards (bookmarks) ──
app.post('/api/cards/:id/save', requireAuth, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid card id' });
  const card = db.prepare('SELECT id FROM cards WHERE id = ?').get(id);
  if (!card) return res.status(404).json({ error: 'Card not found' });
  db.prepare('INSERT OR IGNORE INTO user_saved_cards (user_id, card_id) VALUES (?, ?)').run(req.user.id, id);
  res.json({ saved: true });
});

app.delete('/api/cards/:id/save', requireAuth, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid card id' });
  db.prepare('DELETE FROM user_saved_cards WHERE user_id = ? AND card_id = ?').run(req.user.id, id);
  res.json({ saved: false });
});

app.get('/api/saved', requireAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT c.*, s.saved_at FROM user_saved_cards s
    JOIN cards c ON c.id = s.card_id
    WHERE s.user_id = ?
    ORDER BY s.saved_at DESC
  `).all(req.user.id);
  const cards = rows.map(r => ({ ...rowToCard(r), savedAt: r.saved_at }));
  res.json({ cards });
});

// ── admin: seed cards ──
const insertCard = db.prepare(`
  INSERT INTO cards (headline, category, subtopics, read_seconds, body, key_fact)
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(headline) DO NOTHING
`);

function coerceCard(c) {
  if (!c || !c.headline || !c.body || !c.category) return null;
  return [
    String(c.headline),
    String(c.category),
    JSON.stringify(Array.isArray(c.subtopics) ? c.subtopics : []),
    parseInt(c.readSeconds, 10) || 30,
    String(c.body),
    c.keyFact != null ? String(c.keyFact) : '',
  ];
}

app.post('/api/seed', requireAdmin, (req, res) => {
  const incoming = Array.isArray(req.body) ? req.body
    : Array.isArray(req.body.cards) ? req.body.cards
    : [req.body];
  let inserted = 0, skipped = 0;
  const failures = [];
  for (const c of incoming) {
    const args = coerceCard(c);
    if (!args) { skipped++; failures.push(c && c.headline); continue; }
    const info = insertCard.run(...args);
    if (info.changes > 0) inserted++; else skipped++;
  }
  res.json({ inserted, skipped, failures: failures.filter(Boolean) });
});

// ── admin: library management ──
app.get('/api/admin/cards', requireAdmin, (req, res) => {
  const rows = db.prepare('SELECT * FROM cards ORDER BY id DESC').all();
  res.json({ total: rows.length, cards: rows.map(rowToCard) });
});

// ── admin: find suspected duplicate cards by keyFact similarity ──
// Headlines are unique (DB constraint), but two cards can restate the same fact
// with different headlines. We reduce each keyFact to its distinctive subject
// keywords and flag pairs that overlap heavily, for manual review.
const DEDUP_STOPWORDS = new Set(['the','a','an','of','to','in','on','and','or','but','for','with','that','this','these','those','is','are','was','were','be','been','being','it','its','as','at','by','from','than','then','them','they','their','there','can','could','would','should','will','about','into','over','under','more','most','less','least','one','two','first','only','also','because','which','who','whom','whose','what','when','where','why','how','not','does','did','has','have','had','your','our','out','off','per','via','each','every','some','any','many','much','very','just','even','still','yet','while','during','between','among','across','after','before','make','made','onto','upon']);

// Reduce a keyFact to a Set of distinctive subject keywords.
function keyFactSubject(keyFact) {
  if (!keyFact) return new Set();
  const words = keyFact
    .replace(/^[—–\-]+\s*/, '')              // drop leading em-dash / en-dash / hyphen
    .replace(/<[^>]+>/g, ' ')                  // strip any HTML
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')              // strip punctuation
    .split(/\s+/)
    .map(w => w.replace(/(ies)$/, 'y').replace(/(es|s)$/, '')) // crude singularise
    .filter(w => w.length > 3 && !DEDUP_STOPWORDS.has(w));
  return new Set(words);
}

app.get('/api/admin/deduplicate', requireAdmin, (req, res) => {
  // Tunable via query string: ?threshold=0.5&minShared=2
  const threshold = Math.min(Math.max(parseFloat(req.query.threshold) || 0.5, 0), 1);
  const minShared = Math.max(parseInt(req.query.minShared, 10) || 2, 1);

  const rows = db.prepare('SELECT id, headline, key_fact FROM cards ORDER BY id').all();
  const cards = rows.map(r => ({
    id: r.id, headline: r.headline, keyFact: r.key_fact || '',
    subject: keyFactSubject(r.key_fact),
  }));

  const duplicates = [];
  for (let i = 0; i < cards.length; i++) {
    for (let j = i + 1; j < cards.length; j++) {
      const a = cards[i], b = cards[j];
      if (a.subject.size === 0 || b.subject.size === 0) continue;
      const shared = [...a.subject].filter(w => b.subject.has(w));
      // Overlap relative to the smaller subject — two cards about the same narrow
      // topic share most of their distinctive keywords.
      const similarity = shared.length / Math.min(a.subject.size, b.subject.size);
      if (shared.length >= minShared && similarity >= threshold) {
        duplicates.push({
          similarity: Math.round(similarity * 100) / 100,
          shared,
          cards: [
            { id: a.id, headline: a.headline, keyFact: a.keyFact },
            { id: b.id, headline: b.headline, keyFact: b.keyFact },
          ],
        });
      }
    }
  }
  duplicates.sort((x, y) => y.similarity - x.similarity);
  res.json({ scanned: rows.length, suspected: duplicates.length, threshold, minShared, duplicates });
});

app.delete('/api/admin/cards/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  db.prepare('DELETE FROM user_seen_cards WHERE card_id = ?').run(id);
  db.prepare('DELETE FROM user_saved_cards WHERE card_id = ?').run(id);
  const info = db.prepare('DELETE FROM cards WHERE id = ?').run(id);
  res.json({ deleted: info.changes });
});

app.delete('/api/admin/cards', requireAdmin, (req, res) => {
  // clearing the library also resets everyone's seen history and bookmarks, so a
  // re-seeded library is fresh for all users
  db.prepare('DELETE FROM user_seen_cards').run();
  db.prepare('DELETE FROM user_saved_cards').run();
  const info = db.prepare('DELETE FROM cards').run();
  res.json({ deleted: info.changes });
});

// ── health ──
app.get('/api/health', (req, res) => {
  const { count } = db.prepare('SELECT COUNT(*) AS count FROM cards').get();
  res.json({ ok: true, cards: count });
});

app.listen(PORT, HOST, () => {
  console.log(`Infeed backend listening on http://${HOST}:${PORT}`);
  console.log(`  free trial length: ${TRIAL_DAYS} days`);
});
