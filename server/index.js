// ─── server/index.js ──────────────────────────────────────────────────────────
// Server-authoritative Node.js + Socket.io game server with Firebase Auth.
// Runs at 30 Hz tick rate. Manages player state, shooting, damage, and respawn.

import { createServer }          from 'http';
import express                   from 'express';
import { Server }                from 'socket.io';
import { auth }                  from './firebase.js';
import * as Accounts             from './accounts.js';

const PORT      = process.env.PORT || 3001;
const TICK_MS   = 1000 / 30;
const MAX_HP    = 100;
const RESPAWN_S = 3;

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

let   colorCounter  = 0;
let   spawnIdx      = 0;

// ── Game state: Map<socketId, PlayerData> ─────────────────────────────────────
const players = new Map();

function nextSpawn() {
  const s = SPAWNS[spawnIdx % SPAWNS.length];
  spawnIdx++;
  return { ...s };
}

function createPlayer(socket) {
  const spawn = nextSpawn();
  return {
    id:         socket.id,
    accountId:  socket.accountId,
    username:   socket.username,
    name:       socket.username,
    colorIndex: (colorCounter++) % COLORS.length,
    x: spawn.x, y: spawn.y, z: spawn.z,
    yaw: 0, pitch: 0, speed: 0,
    isGrounded: true,
    health: MAX_HP,
    kills:  0,
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

// ── Express + HTTP + Socket.io ────────────────────────────────────────────────
const app  = express();
const http = createServer(app);
const io   = new Server(http, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
});

// ── CORS (allow Vite dev server on port 3000 to call the API) ───────────────
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use(express.json());
app.use(express.static('dist'));

// ── REST: Create player record after Firebase Auth ───────────────────────────
app.post('/api/create-player', async (req, res) => {
  const { uid, username } = req.body || {};
  if (!uid || !username) return res.status(400).json({ error: 'Missing fields.' });

  const result = await Accounts.createPlayer(uid, username);
  if (result.error) return res.status(400).json(result);

  res.json({ success: true });
});

// ── REST: Verify Firebase token and get player stats ──────────────────────────
app.get('/api/me', async (req, res) => {
  const token = req.query.token;
  if (!token) return res.status(401).json({ error: 'Missing token.' });

  try {
    const decoded = await auth.verifyIdToken(token);
    const acc = await Accounts.getById(decoded.uid);
    res.json({ 
      uid: decoded.uid, 
      username: acc?.username || decoded.email?.split('@')[0] || 'Player',
      totalKills: acc?.totalKills || 0 
    });
  } catch (error) {
    res.status(401).json({ error: 'Invalid token.' });
  }
});

// ── Socket middleware: Firebase auth gate ──────────────────────────────────────
io.use(async (socket, next) => {
  const { token } = socket.handshake.auth || {};
  if (!token) return next(new Error('Unauthorized'));

  try {
    const decoded = await auth.verifyIdToken(token);
    
    // Check if account is already connected
    for (const [id, player] of players) {
      if (player.accountId === decoded.uid) {
        return next(new Error('Account already connected'));
      }
    }
    
    socket.accountId = decoded.uid;
    socket.username = decoded.email?.split('@')[0] || 'Player';
    next();
  } catch (error) {
    next(new Error('Invalid Firebase token'));
  }
});

// ── Socket events ─────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  const player = createPlayer(socket);
  players.set(socket.id, player);
  console.log(`[+] ${player.username} connected (${socket.id})`);

  // Send init data to connecting player
  const existing = {};
  for (const [id, p] of players) {
    if (id !== socket.id) existing[id] = sanitize(p);
  }
  socket.emit('init', {
    id:         socket.id,
    colorIndex: player.colorIndex,
    username:   player.username,
    players:    existing,
  });

  // Announce to everyone else
  socket.broadcast.emit('player_join', { id: socket.id, ...sanitize(player) });

  // ── Move ────────────────────────────────────────────────────────────────────
  socket.on('move', (snap) => {
    const p = players.get(socket.id);
    if (!p || p.isDead) return;
    p.x          = clamp(snap.x,     -74, 74);
    p.y          = Math.max(0, snap.y);
    p.z          = clamp(snap.z,     -74, 74);
    p.yaw        = snap.yaw   || 0;
    p.pitch      = clamp(snap.pitch || 0, -Math.PI / 2, Math.PI / 2);
    p.speed      = Math.abs(snap.speed || 0);
    p.isGrounded = !!snap.isGrounded;
    p.lastSeen   = Date.now();
  });

  // ── Shoot ───────────────────────────────────────────────────────────────────
  socket.on('shoot', (data) => {
    const shooter = players.get(socket.id);
    if (!shooter || shooter.isDead) return;

    io.emit('player_shot', {
      shooterId: socket.id,
      origin: data.origin,
      dir:    data.dir,
    });

    if (data.hitId && players.has(data.hitId)) {
      const victim = players.get(data.hitId);
      if (victim.isDead) return;

      const damage   = clamp(data.damage || 25, 1, 100);
      victim.health  = Math.max(0, victim.health - damage);

      io.to(data.hitId).emit('player_hit', {
        shooterId: socket.id, victimId: data.hitId, damage, health: victim.health,
      });
      socket.emit('player_hit', {
        shooterId: socket.id, victimId: data.hitId, damage, health: victim.health,
      });
      io.emit('health_update', { id: data.hitId, health: victim.health });

      if (victim.health <= 0) killPlayer(data.hitId, socket.id);
    }
  });

  // ── Ping ────────────────────────────────────────────────────────────────────
  socket.on('ping_req', () => socket.emit('pong_res'));

  // ── Disconnect ──────────────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    players.delete(socket.id);
    io.emit('player_leave', socket.id);
    console.log(`[-] ${player.username} disconnected`);
  });
});

// ── Kill & Respawn ────────────────────────────────────────────────────────────
async function killPlayer(victimId, killerId) {
  const victim = players.get(victimId);
  const killer = players.get(killerId);
  if (!victim) return;
  victim.isDead = true;
  victim.health = 0;
  if (killer) {
    killer.kills++;
    if (killer.accountId) await Accounts.incrementKills(killer.accountId);
  }
  victim.deaths++;
  console.log(`[!] ${victim.username} killed by ${killer?.username || '?'}`);
  io.emit('player_died', {
    victimId,  killerId,
    victimName: victim.username,
    killerName: killer?.username || '?',
    respawnIn: RESPAWN_S,
  });
  setTimeout(() => {
    const p = players.get(victimId);
    if (!p) return;
    const s  = nextSpawn();
    p.x = s.x; p.y = s.y; p.z = s.z;
    p.health = MAX_HP;
    p.isDead = false;
    io.emit('player_respawn', { id: victimId, ...s });
    io.emit('health_update',  { id: victimId, health: MAX_HP });
  }, RESPAWN_S * 1000);
}

// ── World state broadcast (30 Hz) ────────────────────────────────────────────
setInterval(() => {
  const state = {};
  for (const [id, p] of players) {
    state[id] = {
      x: p.x, y: p.y, z: p.z,
      yaw: p.yaw, pitch: p.pitch,
      speed: p.speed, isGrounded: p.isGrounded,
      health: p.health, isDead: p.isDead,
      username: p.username,
    };
  }
  io.emit('world_state', state);
}, TICK_MS);

// ── Start ──────────────────────────────────────────────────────────────────────
http.listen(PORT, () => {
  console.log(`Game server → http://localhost:${PORT}`);
});
