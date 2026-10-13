const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuid } = require('uuid');
const path = require('path');

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'change-this-secret-before-real-use';

const db = new Database(path.join(__dirname, 'data.sqlite'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    color TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS channels (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL,
    author_id TEXT NOT NULL,
    text TEXT NOT NULL,
    ts INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel_id, ts);
`);

// seed a default channel
const chCount = db.prepare('SELECT COUNT(*) AS c FROM channels').get().c;
if (chCount === 0) {
  db.prepare('INSERT INTO channels (id, name, created_at) VALUES (?, ?, ?)')
    .run('general', 'Общий', Date.now());
}

const COLORS = ['#4f9dff', '#ff6b6b', '#5fd6a8', '#ffb347', '#b088f9', '#ff8ec7'];
function randomColor() { return COLORS[Math.floor(Math.random() * COLORS.length)]; }

function signToken(user) {
  return jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '30d' });
}

function authMiddleware(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'no_token' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (e) {
    return res.status(401).json({ error: 'invalid_token' });
  }
}

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---- auth ----
app.post('/api/register', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password || username.length < 3 || password.length < 4) {
    return res.status(400).json({ error: 'invalid_input' });
  }
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (existing) return res.status(409).json({ error: 'username_taken' });

  const id = uuid();
  const hash = bcrypt.hashSync(password, 10);
  db.prepare('INSERT INTO users (id, username, password_hash, color, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, username, hash, randomColor(), Date.now());

  const user = { id, username };
  res.json({ token: signToken(user), user });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  const row = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!row || !bcrypt.compareSync(password || '', row.password_hash)) {
    return res.status(401).json({ error: 'bad_credentials' });
  }
  const user = { id: row.id, username: row.username };
  res.json({ token: signToken(user), user });
});

app.get('/api/me', authMiddleware, (req, res) => {
  const row = db.prepare('SELECT id, username, color FROM users WHERE id = ?').get(req.user.id);
  res.json({ user: row });
});

// ---- channels ----
app.get('/api/channels', authMiddleware, (req, res) => {
  const rows = db.prepare('SELECT * FROM channels ORDER BY created_at ASC').all();
  res.json({ channels: rows });
});

app.post('/api/channels', authMiddleware, (req, res) => {
  const { name } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'invalid_name' });
  const id = uuid();
  db.prepare('INSERT INTO channels (id, name, created_at) VALUES (?, ?, ?)')
    .run(id, name.trim().slice(0, 60), Date.now());
  const channel = { id, name: name.trim() };
  broadcastAll({ type: 'channel_created', channel });
  res.json({ channel });
});

// ---- messages (history) ----
app.get('/api/channels/:id/messages', authMiddleware, (req, res) => {
  const limit = Math.min(200, parseInt(req.query.limit || '50', 10));
  const rows = db.prepare(
    `SELECT m.*, u.username, u.color FROM messages m
     JOIN users u ON u.id = m.author_id
     WHERE m.channel_id = ? ORDER BY m.ts ASC LIMIT ?`
  ).all(req.params.id, limit);
  res.json({ messages: rows });
});

// fallback to SPA index for any other route
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

// channelId -> Set of ws clients currently viewing it
const channelViewers = new Map();

function broadcastAll(payload) {
  const data = JSON.stringify(payload);
  wss.clients.forEach(ws => { if (ws.readyState === 1) ws.send(data); });
}

function broadcastToChannel(channelId, payload) {
  const set = channelViewers.get(channelId);
  if (!set) return;
  const data = JSON.stringify(payload);
  set.forEach(ws => { if (ws.readyState === 1) ws.send(data); });
}

wss.on('connection', (ws, req) => {
  let authedUser = null;
  let currentChannel = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch (e) { return; }

    if (msg.type === 'auth') {
      try {
        authedUser = jwt.verify(msg.token, JWT_SECRET);
      } catch (e) {
        ws.send(JSON.stringify({ type: 'error', error: 'invalid_token' }));
      }
      return;
    }

    if (!authedUser) {
      ws.send(JSON.stringify({ type: 'error', error: 'not_authed' }));
      return;
    }

    if (msg.type === 'subscribe') {
      if (currentChannel && channelViewers.get(currentChannel)) {
        channelViewers.get(currentChannel).delete(ws);
      }
      currentChannel = msg.channelId;
      if (!channelViewers.has(currentChannel)) channelViewers.set(currentChannel, new Set());
      channelViewers.get(currentChannel).add(ws);
      return;
    }

    if (msg.type === 'send') {
      const text = (msg.text || '').toString().slice(0, 4000).trim();
      if (!text || !msg.channelId) return;
      const id = uuid();
      const ts = Date.now();
      db.prepare('INSERT INTO messages (id, channel_id, author_id, text, ts) VALUES (?, ?, ?, ?, ?)')
        .run(id, msg.channelId, authedUser.id, text, ts);
      const row = db.prepare(
        `SELECT m.*, u.username, u.color FROM messages m
         JOIN users u ON u.id = m.author_id WHERE m.id = ?`
      ).get(id);
      broadcastToChannel(msg.channelId, { type: 'message', message: row });
      return;
    }
  });

  ws.on('close', () => {
    if (currentChannel && channelViewers.get(currentChannel)) {
      channelViewers.get(currentChannel).delete(ws);
    }
  });
});

server.listen(PORT, () => {
  console.log(`Messenger server running on port ${PORT}`);
});
