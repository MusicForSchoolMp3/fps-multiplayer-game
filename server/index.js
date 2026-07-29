// Simple test server without Firebase authentication
import { createServer } from 'http';
import express from 'express';
import { Server } from 'socket.io';
import { promises as fs } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PORT = process.env.PORT || 3001;
const TICK_MS = 1000 / 30;
const MAX_HP = 100;
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

let colorCounter = 0;
let spawnIdx = 0;

const players = new Map();
const accounts = new Map(); // username -> { uid, totalKills }
const ACCOUNTS_FILE = join(__dirname, 'accounts.json');

// Load accounts from file
async function loadAccounts() {
  try {
    const data = await fs.readFile(ACCOUNTS_FILE, 'utf8');
    const parsed = JSON.parse(data);
    for (const [username, account] of Object.entries(parsed)) {
      accounts.set(username, account);
    }
    console.log(`Loaded ${accounts.size} accounts from file`);
  } catch (err) {
    console.log('No existing accounts file, starting fresh');
  }
}

// Save accounts to file
async function saveAccounts() {
  const obj = {};
  for (const [username, account] of accounts) {
    obj[username] = account;
  }
  await fs.writeFile(ACCOUNTS_FILE, JSON.stringify(obj, null, 2));
}

loadAccounts();

function nextSpawn() {
  const s = SPAWNS[spawnIdx % SPAWNS.length];
  spawnIdx++;
  return { ...s };
}

function createPlayer(socket, username) {
  const spawn = nextSpawn();
  const account = accounts.get(username) || { totalKills: 0 };
  return {
    id: socket.id,
    accountId: username,
    username: username,
    name: username,
    colorIndex: (colorCounter++) % COLORS.length,
    x: spawn.x, y: spawn.y, z: spawn.z,
    yaw: 0, pitch: 0, speed: 0,
    isGrounded: true,
    health: MAX_HP,
    kills: account.totalKills || 0,
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
});

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use(express.json());
app.use(express.static('dist'));

// API endpoints for account management
app.post('/api/create-player', async (req, res) => {
  const { uid, username } = req.body || {};
  if (!username) return res.status(400).json({ error: 'Missing username' });
  
  if (!accounts.has(username)) {
    accounts.set(username, { uid: uid || username, totalKills: 0 });
    await saveAccounts();
  }
  res.json({ success: true });
});

app.get('/api/me', (req, res) => {
  const username = req.query.username;
  if (username && accounts.has(username)) {
    const account = accounts.get(username);
    res.json({ uid: account.uid, username, totalKills: account.totalKills || 0 });
  } else {
    res.json({ uid: 'test-uid', username: 'TestPlayer', totalKills: 0 });
  }
});

io.on('connection', (socket) => {
  const username = socket.handshake.auth.username || `Player${socket.id.slice(0, 4)}`;
  const player = createPlayer(socket, username);
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
      io.emit('health_update', { id: data.hitId, health: victim.health });

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

async function killPlayer(victimId, killerId) {
  const victim = players.get(victimId);
  const killer = players.get(killerId);
  if (!victim) return;
  victim.isDead = true;
  victim.health = 0;
  if (killer) {
    killer.kills++;
    // Save kills to account
    if (accounts.has(killer.username)) {
      const account = accounts.get(killer.username);
      account.totalKills = killer.kills;
      await saveAccounts();
    }
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

http.listen(PORT, () => {
  console.log(`Test server → http://localhost:${PORT}`);
});
