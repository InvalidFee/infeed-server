// ─────────────────────────────────────────────────────────────
//  Database — built-in node:sqlite (no native build step needed)
// ─────────────────────────────────────────────────────────────
const { DatabaseSync } = require('node:sqlite');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'infeed.db');
const db = new DatabaseSync(DB_PATH);

db.exec(`
  PRAGMA journal_mode = WAL;

  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    email         TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    tier          TEXT NOT NULL DEFAULT 'free',
    is_admin      INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS cards (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    headline     TEXT UNIQUE NOT NULL,
    category     TEXT NOT NULL,
    subtopics    TEXT,                         -- JSON array
    read_seconds INTEGER NOT NULL DEFAULT 30,
    body         TEXT NOT NULL,
    key_fact     TEXT,
    stored_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Every card a user has been served, so we never serve it again.
  CREATE TABLE IF NOT EXISTS user_seen_cards (
    user_id INTEGER NOT NULL,
    card_id INTEGER NOT NULL,
    seen_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, card_id)
  );

  -- Cards a user has explicitly bookmarked.
  CREATE TABLE IF NOT EXISTS user_saved_cards (
    user_id  INTEGER NOT NULL,
    card_id  INTEGER NOT NULL,
    saved_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, card_id)
  );

  CREATE INDEX IF NOT EXISTS idx_cards_category ON cards(category);
  CREATE INDEX IF NOT EXISTS idx_seen_user ON user_seen_cards(user_id);
  CREATE INDEX IF NOT EXISTS idx_saved_user ON user_saved_cards(user_id);
`);

// Map a DB row to the shape the front-end expects (matches the original
// localStorage card schema so infeed.html / seed.html need minimal changes).
function rowToCard(r) {
  if (!r) return null;
  let subtopics = [];
  try { subtopics = r.subtopics ? JSON.parse(r.subtopics) : []; } catch { subtopics = []; }
  return {
    dbId: r.id,
    category: r.category,
    subtopics,
    readSeconds: r.read_seconds,
    headline: r.headline,
    body: r.body,
    keyFact: r.key_fact,
    storedAt: r.stored_at,
  };
}

module.exports = { db, rowToCard };
