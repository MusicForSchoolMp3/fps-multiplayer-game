// Server with Firebase authentication
import { createServer } from 'http';
import express from 'express';
import { Server } from 'socket.io';
import { promises as fs } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import admin from 'firebase-admin';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PORT = process.env.PORT || 3001;
const TICK_MS = 1000 / 30;
const MAX_HP = 100;
const RESPAWN_S = 3;

// Initialize Firebase Admin
let db = null;
try {
  if (process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_PRIVATE_KEY) {
    const serviceAccount = {
      type: 'service_account',
      project_id: process.env.FIREBASE_PROJECT_ID,
      private_key_id: process.env.FIREBASE_PRIVATE_KEY_ID,
      private_key: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
      client_email: process.env.FIREBASE_CLIENT_EMAIL,
      client_id: process.env.FIREBASE_CLIENT_ID,
      auth_uri: 'https://accounts.google.com/o/oauth2/auth',
      token_uri: 'https://oauth2.googleapis.com/token',
      auth_provider_x509_cert_url: 'https://www.googleapis.com/oauth2/v1/certs',
      client_x509_cert_url: process.env.FIREBASE_CLIENT_X509_CERT_URL,
    };

    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      databaseURL: process.env.FIREBASE_DATABASE_URL,
    });
    db = admin.database();
    console.log('Firebase Admin initialized');
  } else {
    console.log('Firebase credentials not found, running without Firebase');
  }
} catch (error) {
  console.error('Firebase initialization error:', error);
}

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

function createPlayer(socket, username) {
  const spawn = nextSpawn();
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
});

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use(express.json());

// API endpoints for account management (must be before static files)
app.post('/api/create-player', async (req, res) => {
  const { uid, username } = req.body || {};
  if (!username) return res.status(400).json({ error: 'Missing username' });

  if (db) {
    // Use Firebase Realtime Database
    try {
      await db.ref(`players/${uid}`).set({
        username,
        totalKills: 0,
        createdAt: Date.now(),
      });
      res.json({ success: true });
    } catch (error) {
      console.error('Firebase error:', error);
      res.status(500).json({ error: 'Database error' });
    }
  } else {
    // Fallback to file-based storage
    res.json({ success: true });
  }
});

app.get('/api/me', async (req, res) => {
  const token = req.query.token;
  if (!token) return res.status(401).json({ error: 'Missing token' });

  if (db) {
    try {
      const decodedToken = await admin.auth().verifyIdToken(token);
      const playerRef = db.ref(`players/${decodedToken.uid}`);
      const snapshot = await playerRef.once('value');
      const playerData = snapshot.val();

      res.json({
        uid: decodedToken.uid,
        username: playerData?.username || decodedToken.email?.split('@')[0] || 'Player',
        totalKills: playerData?.totalKills || 0,
      });
    } catch (error) {
      console.error('Firebase auth error:', error);
      res.status(401).json({ error: 'Invalid token' });
    }
  } else {
    res.status(401).json({ error: 'Firebase not configured' });
  }
});

// Static file serving (must be after API routes)
app.use(express.static('dist'));
app.use(express.static('.')); // Serve root directory for FBX files

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
    // Save kills to Firebase
    if (db && killer.accountId) {
      try {
        await db.ref(`players/${killer.accountId}/totalKills`).set(killer.kills);
      } catch (error) {
        console.error('Firebase kill save error:', error);
      }
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
