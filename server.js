import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

const PORT = process.env.PORT || 3000;
const SECRET = process.env.JWT_SECRET;
if (!SECRET || SECRET.length < 16) {
  console.error('Set JWT_SECRET (16+ characters) in .env');
  process.exit(1);
}

// ---------- database ----------
const db = new Database(process.env.DB_FILE || 'yozora.db');
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    username TEXT UNIQUE NOT NULL COLLATE NOCASE,
    hash TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS watchlist (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    anime_id INTEGER NOT NULL,
    status TEXT NOT NULL,
    anime TEXT NOT NULL,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, anime_id)
  );
`);

// ---------- AniList proxy with cache ----------
const FIELDS = `id title{romaji english} seasonYear averageScore episodes genres
  description(asHtml:false) coverImage{large color}`;
const cache = new Map();
const TTL = 10 * 60 * 1000;

async function anilist(query, variables) {
  const key = JSON.stringify([query, variables]);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < TTL) return hit.v;
  const r = await fetch('https://graphql.anilist.co', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  if (!r.ok) throw new Error(`AniList responded ${r.status}`);
  const j = await r.json();
  if (j.errors) throw new Error(j.errors[0].message);
  cache.set(key, { t: Date.now(), v: j.data });
  if (cache.size > 500) cache.delete(cache.keys().next().value);
  return j.data;
}

const norm = (m) => ({
  id: m.id,
  t: m.title.english || m.title.romaji,
  y: m.seasonYear || '',
  s: (m.averageScore || 0) / 10,
  e: m.episodes || '?',
  g: m.genres || [],
  gl: (m.title.romaji || '?')[0],
  c1: m.coverImage?.color || '#5b4b9a',
  c2: '#241c40',
  d: (m.description || '').replace(/<[^>]+>/g, '').slice(0, 400),
  img: m.coverImage?.large,
});

// ---------- app ----------
const app = express();
app.set('trust proxy', 1);
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      'script-src': ["'self'", "'unsafe-inline'"],
      'style-src': ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      'font-src': ['https://fonts.gstatic.com'],
      'img-src': ["'self'", 'data:', 'https://s4.anilist.co'],
    },
  },
}));
app.use(express.json({ limit: '16kb' }));
app.use('/api', rateLimit({ windowMs: 60_000, limit: 120 }));
const authLimit = rateLimit({ windowMs: 15 * 60_000, limit: 20 });

const wrap = (fn) => (req, res) => fn(req, res).catch((e) => {
  console.error(e.message);
  res.status(502).json({ error: 'Could not reach AniList. Try again shortly.' });
});

// Catalog
const SORTS = new Set(['TRENDING_DESC', 'POPULARITY_DESC', 'SCORE_DESC', 'START_DATE_DESC']);
app.get('/api/anime', wrap(async (req, res) => {
  const search = String(req.query.search || '').trim().slice(0, 80) || undefined;
  const sort = search ? 'SEARCH_MATCH' : (SORTS.has(req.query.sort) ? req.query.sort : 'TRENDING_DESC');
  const perPage = Math.min(Math.max(+req.query.perPage || 30, 1), 50);
  const page = Math.max(+req.query.page || 1, 1);
  const q = `query($page:Int,$perPage:Int,$sort:[MediaSort],$search:String){
    Page(page:$page,perPage:$perPage){media(type:ANIME,isAdult:false,sort:$sort,search:$search){${FIELDS}}}}`;
  const d = await anilist(q, { page, perPage, sort: [sort], search });
  res.json({ items: d.Page.media.map(norm) });
}));

app.get('/api/anime/:id', wrap(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Bad id' });
  const d = await anilist(`query($id:Int){Media(id:$id,type:ANIME){${FIELDS}}}`, { id });
  res.json({ item: norm(d.Media) });
}));

// Auth
const sign = (u) => jwt.sign({ uid: u.id, name: u.username }, SECRET, { expiresIn: '30d' });

app.post('/api/auth/register', authLimit, (req, res) => {
  const { username = '', password = '' } = req.body || {};
  if (!/^[a-z0-9_]{3,20}$/i.test(username)) return res.status(400).json({ error: 'Username must be 3-20 letters, numbers or underscores.' });
  if (typeof password !== 'string' || password.length < 8 || password.length > 72) return res.status(400).json({ error: 'Password must be 8-72 characters.' });
  try {
    const info = db.prepare('INSERT INTO users (username, hash) VALUES (?, ?)').run(username, bcrypt.hashSync(password, 11));
    res.json({ token: sign({ id: info.lastInsertRowid, username }), username });
  } catch {
    res.status(409).json({ error: 'That username is taken.' });
  }
});

app.post('/api/auth/login', authLimit, (req, res) => {
  const { username = '', password = '' } = req.body || {};
  const u = db.prepare('SELECT * FROM users WHERE username = ?').get(String(username));
  if (!u || !bcrypt.compareSync(String(password), u.hash)) return res.status(401).json({ error: 'Wrong username or password.' });
  res.json({ token: sign(u), username: u.username });
});

function auth(req, res, next) {
  try {
    const t = (req.headers.authorization || '').replace(/^Bearer /, '');
    req.user = jwt.verify(t, SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Please log in again.' });
  }
}

// Watchlist
const STATUSES = new Set(['Watching', 'Plan to watch', 'Completed']);
app.get('/api/watchlist', auth, (req, res) => {
  const rows = db.prepare('SELECT anime_id, status, anime FROM watchlist WHERE user_id = ? ORDER BY updated_at DESC').all(req.user.uid);
  res.json({ items: rows.map((r) => ({ id: r.anime_id, status: r.status, anime: JSON.parse(r.anime) })) });
});

app.put('/api/watchlist/:id', auth, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { status, anime } = req.body || {};
  const json = JSON.stringify(anime || {});
  if (!Number.isInteger(id) || !STATUSES.has(status) || json.length > 4000 || !anime || anime.id !== id) {
    return res.status(400).json({ error: 'Invalid watchlist entry.' });
  }
  db.prepare(`INSERT INTO watchlist (user_id, anime_id, status, anime) VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id, anime_id) DO UPDATE SET status = excluded.status, anime = excluded.anime, updated_at = CURRENT_TIMESTAMP`)
    .run(req.user.uid, id, status, json);
  res.json({ ok: true });
});

app.delete('/api/watchlist/:id', auth, (req, res) => {
  db.prepare('DELETE FROM watchlist WHERE user_id = ? AND anime_id = ?').run(req.user.uid, parseInt(req.params.id, 10));
  res.json({ ok: true });
});

app.use(express.static('public'));
app.listen(PORT, () => console.log(`Yozora running on http://localhost:${PORT}`));
