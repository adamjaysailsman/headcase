'use strict';
/*
 * Headcase server.
 * One small Node process. Rooms live in memory (no database); a restart clears them.
 * The server decides who may see which word, so a player's own word is never sent to them
 * until it is revealed.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT) || 3000;
const PASSWORD = process.env.ACCESS_PASSWORD || '';
const MAX_PLAYERS = 10, MIN_PLAYERS = 3;
const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const KINDS = ['Person', 'Place', 'Thing'];
const HOST_GRACE_MS = Number(process.env.HOST_GRACE_MS) || 20000;
const ROOM_TTL_MS = 3 * 60 * 60 * 1000;

const BOT_NAMES = ['Ava', 'Ben', 'Cleo', 'Dev', 'Eli', 'Fay', 'Gus', 'Hana', 'Ira'];
const BOT_WORDS = {
  Person: ['Dolly Parton', 'Albert Einstein', 'Shrek', 'Abraham Lincoln', 'Julia Child'],
  Place: ['Grand Canyon', 'Disneyland', 'The Moon', 'Paris', 'A laundromat'],
  Thing: ['A traffic cone', 'Bicycle', 'Toaster', 'Surfboard', 'Garden gnome']
};

const rooms = new Map();

/* ---------- small helpers ---------- */
const rid = n => crypto.randomBytes(n).toString('hex');
const cleanName = s => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 16);
const cleanWord = s => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 40);
const pick = a => a[crypto.randomInt(a.length)];
function safeEq(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
function newCode() {
  for (let n = 0; n < 50; n++) {
    let c = '';
    for (let i = 0; i < 4; i++) c += LETTERS[crypto.randomInt(LETTERS.length)];
    if (!rooms.has(c)) return c;
  }
  return null;
}

/* ---------- room model ---------- */
function makePlayer(room, { pid = null, name, bot = false }) {
  const p = { id: rid(3), pid, name, bot, connected: !bot, seq: room.seq++, round: 0, ready: false, word: '', kind: 'Person' };
  room.players.set(p.id, p);
  return p;
}
function seating(room) {
  const seen = new Set(), out = [];
  for (const id of room.order) {
    const p = room.players.get(id);
    if (p && !seen.has(id)) { seen.add(id); out.push(p); }
  }
  [...room.players.values()].sort((a, b) => a.seq - b.seq).forEach(p => { if (!seen.has(p.id)) out.push(p); });
  return out;
}
function targetOf(room, id) { const o = seating(room), i = o.findIndex(p => p.id === id); return o.length ? o[(i + 1) % o.length] : null; }
function authorOf(room, id) { const o = seating(room), i = o.findIndex(p => p.id === id); return o.length ? o[(i - 1 + o.length) % o.length] : null; }
const isReady = (room, p) => !!p && p.round === room.round && p.ready === true;
function solvedDoc(room, id) { const d = room.solved.get(id); return d && d.round === room.round ? d : null; }
function rankOf(room, id) {
  const list = [...room.solved.entries()].filter(([, d]) => d.round === room.round && !d.gaveUp).sort((a, b) => a[1].at - b[1].at);
  const i = list.findIndex(([k]) => k === id);
  return i < 0 ? 0 : i + 1;
}
function effective(room, conn) {
  if (conn.viewAs && conn.playerId === room.host) {
    const b = room.players.get(conn.viewAs);
    if (b && b.bot) return b.id;
  }
  return conn.playerId;
}
function humans(room) { return seating(room).filter(p => !p.bot); }

/* What this connection is allowed to see. */
function viewFor(room, conn) {
  const real = conn.playerId, eff = effective(room, conn);
  const order = seating(room);
  const v = {
    code: room.code, phase: room.phase, round: room.round, host: room.host, real, me: eff,
    viewing: eff !== real, hasBots: order.some(p => p.bot),
    players: order.map(p => ({ id: p.id, name: p.name, bot: p.bot, connected: p.bot || p.connected, ready: isReady(room, p), ci: p.seq }))
  };
  const me = room.players.get(eff);
  if (room.phase === 'writing' && me) {
    const t = targetOf(room, eff);
    v.target = t && t.id !== eff ? t.id : null;
    v.draft = me.round === room.round ? { word: me.word, kind: me.kind, ready: me.ready } : { word: '', kind: 'Person', ready: false };
  }
  if (room.phase === 'playing' || room.phase === 'done') {
    v.cards = {}; v.solved = {};
    for (const p of order) {
      const a = authorOf(room, p.id), sd = solvedDoc(room, p.id);
      if (sd) v.solved[p.id] = { gaveUp: !!sd.gaveUp, rank: sd.gaveUp ? 0 : rankOf(room, p.id) };
      if (!a || a.id === p.id || !isReady(room, a)) { v.cards[p.id] = null; continue; }
      const reveal = room.phase === 'done' || p.id !== eff || !!sd;
      v.cards[p.id] = { kind: a.kind, word: reveal ? a.word : null, by: reveal ? a.name : null };
    }
  }
  return v;
}

/* ---------- connections ---------- */
function send(conn, obj) { if (conn.ws.readyState === 1) conn.ws.send(JSON.stringify(obj)); }
function sendState(conn) { if (conn.room) send(conn, { t: 'state', v: viewFor(conn.room, conn) }); }
function broadcast(room) { room.touched = Date.now(); for (const c of room.conns) sendState(c); }
function detach(conn) {
  const room = conn.room;
  if (!room) return;
  room.conns.delete(conn);
  conn.room = null; conn.playerId = null; conn.viewAs = null;
}
function goHome(conn, notice) { detach(conn); send(conn, { t: 'home', notice: notice || '' }); }
function attach(conn, room, player) {
  detach(conn);
  conn.room = room; conn.playerId = player.id; conn.viewAs = null;
  player.connected = true;
  room.conns.add(conn);
}
function playerStillConnected(room, id) { for (const c of room.conns) if (c.playerId === id) return true; return false; }

function migrateHost(room) {
  const cur = room.players.get(room.host);
  if (cur && !cur.bot && (cur.connected)) return;
  const next = humans(room).find(p => p.connected);
  if (next && next.id !== room.host) { room.host = next.id; broadcast(room); }
}
function removePlayer(room, id) {
  room.players.delete(id);
  room.solved.delete(id);
  for (const c of [...room.conns]) if (c.playerId === id) goHome(c, 'You were removed from the room.');
}
function closeRoomIfEmpty(room) {
  if (humans(room).length === 0) { for (const c of [...room.conns]) goHome(c, 'The room closed.'); rooms.delete(room.code); return true; }
  return false;
}

/* ---------- message handling ---------- */
function handle(conn, m) {
  if (m.t === 'hello') {
    const pid = String(m.pid || '');
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(pid)) return send(conn, { t: 'error', msg: 'Reload the page and try again.' });
    if (PASSWORD && !safeEq(m.password || '', PASSWORD)) {
      conn.authed = false;
      return send(conn, { t: 'need_password', wrong: !!m.password });
    }
    conn.authed = true; conn.pid = pid;
    const code = String(m.code || '').toUpperCase();
    const room = rooms.get(code);
    const p = room && [...room.players.values()].find(x => x.pid === pid);
    if (room && p) { attach(conn, room, p); return broadcast(room); }
    return send(conn, { t: 'home' });
  }
  if (!conn.authed || !conn.pid) return;
  if (m.t === 'ping') return; // keep-alive from the page; counts as traffic for the host

  if (m.t === 'create') {
    const name = cleanName(m.name);
    if (!name) return send(conn, { t: 'error', msg: 'Add your name first.' });
    const code = newCode();
    if (!code) return send(conn, { t: 'error', msg: 'The server is full right now. Try again in a minute.' });
    const room = { code, host: null, phase: 'lobby', round: 1, order: [], seq: 0, players: new Map(), solved: new Map(), conns: new Set(), touched: Date.now() };
    const p = makePlayer(room, { pid: conn.pid, name });
    room.host = p.id; room.order = [p.id];
    rooms.set(code, room);
    attach(conn, room, p);
    return broadcast(room);
  }
  if (m.t === 'join') {
    const name = cleanName(m.name);
    const code = String(m.code || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
    const room = rooms.get(code);
    if (!room) return send(conn, { t: 'error', msg: `No room with the code ${code}. Check the letters and try again.` });
    let p = [...room.players.values()].find(x => x.pid === conn.pid);
    if (!p) {
      if (!name) return send(conn, { t: 'error', msg: 'Add your name first.' });
      if (room.phase !== 'lobby') return send(conn, { t: 'error', msg: 'That game has already started. Ask the host to go back to the lobby.' });
      if (room.players.size >= MAX_PLAYERS) return send(conn, { t: 'error', msg: `That room is full (${MAX_PLAYERS} players).` });
      p = makePlayer(room, { pid: conn.pid, name });
    } else if (name) p.name = name;
    attach(conn, room, p);
    return broadcast(room);
  }

  const room = conn.room;
  if (!room) return;
  if (m.t === 'sync') return sendState(conn);
  const host = conn.playerId === room.host;
  const eff = effective(room, conn);
  const me = room.players.get(eff);
  if (!me) return;

  switch (m.t) {
    case 'leave': {
      const id = conn.playerId;
      detach(conn);
      send(conn, { t: 'home' });
      if (room.phase === 'lobby') {
        room.players.delete(id);
        if (room.host === id) { const next = humans(room)[0]; if (next) room.host = next.id; }
        if (closeRoomIfEmpty(room)) return;
      } else {
        const p = room.players.get(id);
        if (p && !playerStillConnected(room, id)) { p.connected = false; if (room.host === id) scheduleHostCheck(room); }
      }
      return broadcast(room);
    }
    /* host, lobby */
    case 'move': {
      if (!host || room.phase !== 'lobby') return;
      const ids = seating(room).map(p => p.id), i = ids.indexOf(m.id), j = i + (m.dir === 1 ? 1 : -1);
      if (i < 0 || j < 0 || j >= ids.length) return;
      [ids[i], ids[j]] = [ids[j], ids[i]];
      room.order = ids;
      return broadcast(room);
    }
    case 'shuffle': {
      if (!host || room.phase !== 'lobby') return;
      const ids = seating(room).map(p => p.id);
      for (let i = ids.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [ids[i], ids[j]] = [ids[j], ids[i]]; }
      room.order = ids;
      return broadcast(room);
    }
    case 'kick': {
      if (!host || room.phase !== 'lobby' || m.id === room.host || !room.players.has(m.id)) return;
      removePlayer(room, m.id);
      return broadcast(room);
    }
    case 'start': {
      if (!host || room.phase !== 'lobby' || room.players.size < MIN_PLAYERS) return;
      room.order = seating(room).map(p => p.id);
      room.phase = 'writing';
      return broadcast(room);
    }
    case 'addbots': {
      if (!host || room.phase !== 'lobby') return;
      const have = room.players.size;
      const want = Math.max(0, Math.min(MAX_PLAYERS - have, Math.max(MIN_PLAYERS + 1 - have, 1)));
      const used = new Set([...room.players.values()].map(p => p.name));
      let made = 0;
      for (const nm of BOT_NAMES) { if (made >= want) break; if (used.has(nm)) continue; makePlayer(room, { name: nm, bot: true }); made++; }
      return broadcast(room);
    }
    case 'removebots': {
      if (!host || room.phase !== 'lobby') return;
      for (const p of [...room.players.values()]) if (p.bot) room.players.delete(p.id);
      for (const c of room.conns) c.viewAs = null;
      return broadcast(room);
    }
    case 'viewas': {
      if (!host) return;
      const b = m.id ? room.players.get(m.id) : null;
      conn.viewAs = b && b.bot ? b.id : null;
      return sendState(conn);
    }
    /* writing */
    case 'lock': {
      if (room.phase !== 'writing') return;
      const word = cleanWord(m.word);
      if (!word) return;
      me.round = room.round; me.ready = true; me.word = word; me.kind = KINDS.includes(m.kind) ? m.kind : 'Person';
      return broadcast(room);
    }
    case 'unlock': {
      if (room.phase !== 'writing') return;
      me.ready = false;
      return broadcast(room);
    }
    case 'autofill': {
      if (!host || room.phase !== 'writing') return;
      for (const b of room.players.values()) {
        if (!b.bot || isReady(room, b)) continue;
        const kind = pick(KINDS);
        b.round = room.round; b.ready = true; b.kind = kind; b.word = pick(BOT_WORDS[kind]);
      }
      return broadcast(room);
    }
    case 'startplay': {
      if (!host || room.phase !== 'writing' || !seating(room).every(p => isReady(room, p))) return;
      room.phase = 'playing'; room.solved = new Map();
      return broadcast(room);
    }
    /* playing */
    case 'solve': {
      if (room.phase !== 'playing' || !room.players.has(m.target) || m.target === eff || solvedDoc(room, m.target)) return;
      room.solved.set(m.target, { round: room.round, at: Date.now(), by: eff, gaveUp: false });
      return broadcast(room);
    }
    case 'giveup': {
      if (room.phase !== 'playing' || solvedDoc(room, eff)) return;
      room.solved.set(eff, { round: room.round, at: Date.now(), by: eff, gaveUp: true });
      return broadcast(room);
    }
    case 'undo': {
      if (room.phase !== 'playing' || m.target === eff || !solvedDoc(room, m.target)) return;
      room.solved.delete(m.target);
      return broadcast(room);
    }
    case 'end': {
      if (!host || room.phase !== 'playing') return;
      room.phase = 'done';
      return broadcast(room);
    }
    case 'again': {
      if (!host || room.phase !== 'done') return;
      room.phase = 'writing'; room.round++; room.solved = new Map();
      return broadcast(room);
    }
    case 'tolobby': {
      if (!host || room.phase !== 'done') return;
      room.phase = 'lobby'; room.round++; room.solved = new Map();
      for (const c of room.conns) c.viewAs = null;
      return broadcast(room);
    }
  }
}

function scheduleHostCheck(room) {
  setTimeout(() => {
    if (!rooms.has(room.code)) return;
    const h = room.players.get(room.host);
    if (!h || (!h.connected && !h.bot)) migrateHost(room);
  }, HOST_GRACE_MS).unref();
}
function onClose(conn) {
  const room = conn.room, id = conn.playerId;
  if (!room) return;
  detach(conn);
  const p = room.players.get(id);
  if (p && !playerStillConnected(room, id)) {
    p.connected = false;
    if (room.host === id) scheduleHostCheck(room);
    broadcast(room);
  }
}

/* ---------- http + websocket ---------- */
const INDEX = fs.readFileSync(path.join(__dirname, 'index.html'));
const server = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];
  const base = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };
  if (url === '/' || url === '/index.html') {
    res.writeHead(200, { ...base, 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    return res.end(INDEX);
  }
  if (url === '/healthz') { res.writeHead(200, { ...base, 'Content-Type': 'text/plain' }); return res.end('ok'); }
  res.writeHead(404, { ...base, 'Content-Type': 'text/plain' });
  res.end('Not found');
});
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 4096 });
wss.on('connection', ws => {
  const conn = { ws, pid: null, authed: false, room: null, playerId: null, viewAs: null, last: 0, count: 0 };
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', raw => {
    const now = Date.now();
    if (now - conn.last > 1000) { conn.last = now; conn.count = 0; }
    if (++conn.count > 30) return; // ignore floods
    let m;
    try { m = JSON.parse(raw.toString()); } catch (e) { return; }
    if (!m || typeof m.t !== 'string') return;
    try { handle(conn, m); } catch (e) { console.error(e); send(conn, { t: 'error', msg: 'Something went wrong. Try again.' }); }
  });
  ws.on('close', () => onClose(conn));
  ws.on('error', () => {});
});
const beat = setInterval(() => {
  wss.clients.forEach(ws => { if (ws.isAlive === false) return ws.terminate(); ws.isAlive = false; try { ws.ping(); } catch (e) {} });
}, 25000);
const sweep = setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) if (room.conns.size === 0 && now - room.touched > ROOM_TTL_MS) rooms.delete(room.code);
}, 10 * 60 * 1000);
beat.unref(); sweep.unref();

if (require.main === module) {
  server.listen(PORT, () => console.log(`Headcase on port ${PORT}${PASSWORD ? ' (password required)' : ''}`));
}
module.exports = { server, rooms };
