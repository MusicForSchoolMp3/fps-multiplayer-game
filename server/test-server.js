// Simple test server without Firebase authentication
import { createServer } from 'http';
import express from 'express';
import compression from 'compression';
import { Server } from 'socket.io';
import msgpackParser from 'socket.io-msgpack-parser';

const PORT = process.env.PORT || 3001;
const TICK_MS = 1000 / 30;
const MAX_HP = 100;
const RESPAWN_S = 3;
// Match client/server wire parser. Must stay in sync with the real server.
const VIEW_RANGE = 200.0;

const SPAWNS = [
  { x: -60, y: 0, z: 0 },
  { x:  60, y: 0, z: 0 },
  { x:   0, y: 0, z: -60 },
  { x:   0, y: 0, z: 60 },
  { x: -40, y: 0, z: -40 },
  { x:  40, y: 0, z: -40 },
  { x: -40, y: 0, z: 40 },
  { x:  40, y: 0, z: 40 },
];

const COLORS = [0xff4444, 0x44aaff, 0x44ff88, 0xffcc44, 0xcc44ff, 0xff8844];

let colorCounter = 0;
let spawnIdx = 0;

const players = new Map();

function nextSpawn() {
  const s = SPAWNS[spawnIdx % SPAWNS.length];
  spawnIdx++;
  return { ...s };
}

function createPlayer(socket) {
  const spawn = nextSpawn();
  return {
    id: socket.id,
    accountId: socket.id,
    username: `Player${socket.id.slice(0, 4)}`,
    name: `Player${socket.id.slice(0, 4)}`,
    colorIndex: (colorCounter++) % COLORS.length,
    x: spawn.x, y: spawn.y, z: spawn.z,
    yaw: 0, pitch: 0, speed: 0,
    isGrounded: true,
    health: MAX_HP,
    kills: 0,
    deaths: 0,
    isDead: false,
    lastSeen: Date.now(),
  };
}

function sanitize(p) {
  return {
    x: p.x, y: p.y, z: p.z,
    yaw: p.yaw, pitch: p.pitch,
    speed: p.speed,
    isGrounded: p.isGrounded,
    health: p.health,
    kills: p.kills, deaths: p.deaths,
    name: p.name,
    username: p.username,
    colorIndex: p.colorIndex,
    isDead: p.isDead,
  };
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

const app = express();
const http = createServer(app);
const io = new Server(http, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  parser: msgpackParser,
});

app.use(compression({ threshold: 512, brotli: { enabled: true, quality: 5 } }));

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use(express.json());
app.use(express.static('dist'));

// Mock API endpoints for testing
app.post('/api/create-player', (req, res) => {
  res.json({ success: true });
});

app.get('/api/me', (req, res) => {
  res.json({ uid: 'test-uid', username: 'TestPlayer', totalKills: 0 });
});

io.on('connection', (socket) => {
  const player = createPlayer(socket);
  players.set(socket.id, player);
  console.log(`[+] ${player.username} connected (${socket.id})`);

  const existing = {};
  for (const [id, p] of players) {
    if (id !== socket.id) existing[id] = sanitize(p);
  }
  socket.emit('init', {
    id: socket.id,
    colorIndex: player.colorIndex,
    username: player.username,
    players: existing,
  });

  socket.broadcast.emit('player_join', { id: socket.id, ...sanitize(player) });

  socket.on('move', (snap) => {
    const p = players.get(socket.id);
    if (!p || p.isDead) return;
    p.x = clamp(snap.x, -74, 74);
    p.y = Math.max(0, snap.y);
    p.z = clamp(snap.z, -74, 74);
    p.yaw = snap.yaw || 0;
    p.pitch = clamp(snap.pitch || 0, -Math.PI / 2, Math.PI / 2);
    p.speed = Math.abs(snap.speed || 0);
    p.isGrounded = !!snap.isGrounded;
    p.lastSeen = Date.now();
  });

  socket.on('shoot', (data) => {
    const shooter = players.get(socket.id);
    if (!shooter || shooter.isDead) return;

    io.emit('player_shot', {
      shooterId: socket.id,
      origin: data.origin,
      dir: data.dir,
    });

    if (data.hitId && players.has(data.hitId)) {
      const victim = players.get(data.hitId);
      if (victim.isDead) return;

      const damage = clamp(data.damage || 25, 1, 100);
      victim.health = Math.max(0, victim.health - damage);

io.to(data.hitId).emit('player_hit', {
      shooterId: socket.id, victimId: data.hitId, damage, health: victim.health,
    });
    socket.emit('player_hit', {
      shooterId: socket.id, victimId: data.hitId, damage, health: victim.health,
    });
    io.to(data.hitId).emit('health_update', { id: data.hitId, health: victim.health });

      if (victim.health <= 0) killPlayer(data.hitId, socket.id);
    }
  });

  socket.on('ping_req', () => socket.emit('pong_res'));

  socket.on('disconnect', () => {
    players.delete(socket.id);
    io.emit('player_leave', socket.id);
    console.log(`[-] ${player.username} disconnected`);
  });
});

function killPlayer(victimId, killerId) {
  const victim = players.get(victimId);
  const killer = players.get(killerId);
  if (!victim) return;
  victim.isDead = true;
  victim.health = 0;
  if (killer) {
    killer.kills++;
  }
  victim.deaths++;
  console.log(`[!] ${victim.username} killed by ${killer?.username || '?'}`);
  io.emit('player_died', {
    victimId, killerId,
    victimName: victim.username,
    killerName: killer?.username || '?',
    respawnIn: RESPAWN_S,
  });
  setTimeout(() => {
    const p = players.get(victimId);
    if (!p) return;
    const s = nextSpawn();
    p.x = s.x; p.y = s.y; p.z = s.z;
    p.health = MAX_HP;
    p.isDead = false;
    io.emit('player_respawn', { id: victimId, ...s });
    io.emit('health_update', { id: victimId, health: MAX_HP });
  }, RESPAWN_S * 1000);
}

setInterval(() => {
  // Per-recipient interest management: only forward moving/delta players that
  // are within range (gameplay-neutral given VIEW_RANGE >= sniper range).
  const deltas = new Map();
  for (const [id, p] of players) {
    deltas.set(id, {
      x: p.x, y: p.y, z: p.z,
      yaw: p.yaw, pitch: p.pitch,
      speed: p.speed, isGrounded: p.isGrounded,
      health: p.health, isDead: p.isDead,
      username: p.username,
    });
  }
  if (deltas.size === 0) return;

  const viewSq = VIEW_RANGE * VIEW_RANGE;
  for (const [recipientId, recipient] of players) {
    const sock = io.sockets.sockets.get(recipientId);
    if (!sock || !sock.connected) continue;
    const out = {};
    for (const [pid, snap] of deltas) {
      if (pid === recipientId) continue;
      const other = players.get(pid);
      if (!other) continue;
      const dx = other.x - recipient.x;
      const dz = other.z - recipient.z;
      if (dx * dx + dz * dz > viewSq) continue;
      out[pid] = snap;
    }
    if (Object.keys(out).length > 0) sock.emit('world_state', out);
  }
}, TICK_MS);

http.listen(PORT, () => {
  console.log(`Test server → http://localhost:${PORT}`);
});
