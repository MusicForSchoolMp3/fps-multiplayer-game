// Server with MongoDB authentication
import { createServer } from 'http';
import express from 'express';
import { Server } from 'socket.io';
import { MongoClient } from 'mongodb';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PORT = process.env.PORT || 3001;
const TICK_MS = 1000 / 30;
const MAX_HP = 100;
const RESPAWN_S = 3;

// JWT secret for token validation
const JWT_SECRET = process.env.JWT_SECRET || 'fps-game-secret-key-change-in-production';

// MongoDB connection
const MONGO_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/fps-game';
let db = null;
let accountsCollection = null;

async function connectToMongo() {
  try {
    const client = new MongoClient(MONGO_URI);
    await client.connect();
    db = client.db();
    accountsCollection = db.collection('accounts');
    console.log('Connected to MongoDB');

    // Create case-insensitive index on username for faster lookups
    await accountsCollection.createIndex({ username: 1 }, { unique: true, collation: { locale: 'en', strength: 2 } });
  } catch (error) {
    console.error('MongoDB connection error:', error);
    console.log('Running without database - accounts will not persist');
  }
}

connectToMongo();

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
    currentWeapon: 'ar',
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
    currentWeapon: p.currentWeapon || 'ar',
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
app.post('/api/register', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Missing username or password' });

  // Validate username: no spaces, 3-20 characters
  if (username.includes(' ')) {
    return res.status(400).json({ error: 'Username cannot contain spaces' });
  }
  if (username.length < 3 || username.length > 20) {
    return res.status(400).json({ error: 'Username must be 3-20 characters' });
  }

  if (!accountsCollection) {
    return res.status(500).json({ error: 'Database not available' });
  }

  try {
    // Check if username already exists (case-insensitive)
    const existing = await accountsCollection.findOne(
      { username: username },
      { collation: { locale: 'en', strength: 2 } }
    );
    if (existing) {
      return res.status(400).json({ error: 'Username already exists' });
    }

    // Hash password
    const passwordHash = await bcrypt.hash(password, 10);

    // Create account with lowercase username for consistency
    await accountsCollection.insertOne({
      username: username.toLowerCase(),
      passwordHash,
      totalKills: 0,
      skins: ['ar_default', 'sniper_midnight'], // Default skins
      createdAt: new Date(),
    });

    res.json({ success: true });
  } catch (error) {
    console.error('Registration error:', error);
    if (error.code === 11000) {
      return res.status(400).json({ error: 'Username already exists' });
    }
    res.status(500).json({ error: 'Registration failed' });
  }
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Missing username or password' });

  if (!accountsCollection) {
    return res.status(500).json({ error: 'Database not available' });
  }

  try {
    // Find account (case-insensitive)
    const account = await accountsCollection.findOne(
      { username: username.toLowerCase() },
      { collation: { locale: 'en', strength: 2 } }
    );
    if (!account) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    // Verify password
    const validPassword = await bcrypt.compare(password, account.passwordHash);
    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    // Generate JWT token
    const token = jwt.sign(
      { username: account.username, uid: account._id.toString() },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({
      uid: account._id.toString(),
      username: account.username,
      totalKills: account.totalKills || 0,
      skins: account.skins || ['ar_default', 'sniper_midnight'],
      token
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
});

app.get('/api/me', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Missing token' });

  try {
    // Verify JWT token
    const decoded = jwt.verify(token, JWT_SECRET);

    if (!accountsCollection) {
      return res.status(500).json({ error: 'Database not available' });
    }

    const account = await accountsCollection.findOne({ username: decoded.username });
    if (!account) {
      return res.status(401).json({ error: 'Account not found' });
    }

    res.json({
      uid: account._id.toString(),
      username: account.username,
      totalKills: account.totalKills || 0,
      skins: account.skins || ['ar_default', 'sniper_midnight']
    });
  } catch (error) {
    if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({ error: 'Invalid token' });
    }
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expired' });
    }
    console.error('Get account error:', error);
    res.status(500).json({ error: 'Failed to get account' });
  }
});

app.post('/api/validate-skin', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  const { skinId } = req.body || {};
  
  if (!token) return res.status(401).json({ error: 'Missing token' });
  if (!skinId) return res.status(400).json({ error: 'Missing skinId' });

  try {
    // Verify JWT token
    const decoded = jwt.verify(token, JWT_SECRET);

    if (!accountsCollection) {
      return res.status(500).json({ error: 'Database not available' });
    }

    const account = await accountsCollection.findOne({ username: decoded.username });
    if (!account) {
      return res.status(401).json({ error: 'Account not found' });
    }

    const ownedSkins = account.skins || ['ar_default', 'sniper_midnight'];
    const ownsSkin = ownedSkins.includes(skinId);

    res.json({ ownsSkin, ownedSkins });
  } catch (error) {
    if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({ error: 'Invalid token' });
    }
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expired' });
    }
    console.error('Validate skin error:', error);
    res.status(500).json({ error: 'Failed to validate skin' });
  }
});

// Static file serving (must be after API routes)
app.use(express.static('dist'));
app.use(express.static('.')); // Serve root directory for FBX files

io.on('connection', async (socket) => {
  const token = socket.handshake.auth.token;
  let username = null;

  // Validate JWT token
  if (token) {
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      username = decoded.username;

      // Verify account still exists in database
      if (accountsCollection) {
        const account = await accountsCollection.findOne({ username });
        if (!account) {
          console.log(`[-] Rejected connection: account not found for ${username}`);
          socket.disconnect();
          return;
        }
      }
    } catch (error) {
      console.log(`[-] Rejected connection: invalid token (${socket.id})`);
      socket.disconnect();
      return;
    }
  } else {
    console.log(`[-] Rejected connection: missing token (${socket.id})`);
    socket.disconnect();
    return;
  }

  // Check for duplicate account connections
  for (const [existingId, existingPlayer] of players) {
    if (existingPlayer.username === username) {
      console.log(`[!] Duplicate connection detected for ${username} - kicking both`);
      
      // Kick the existing connection
      io.to(existingId).emit('duplicate_login', {
        message: 'You have been logged in from another location'
      });
      players.delete(existingId);
      io.sockets.sockets.get(existingId)?.disconnect();
      
      // Kick the new connection
      socket.emit('duplicate_login', {
        message: 'You are already logged in from another location'
      });
      socket.disconnect();
      return;
    }
  }

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

    // Validate shooter is alive and legitimate
    if (shooter.health <= 0) return;

    io.emit('player_shot', {
      shooterId: socket.id,
      origin: data.origin,
      dir: data.dir,
    });

    if (data.hitId && players.has(data.hitId)) {
      const victim = players.get(data.hitId);
      if (victim.isDead) return;

      // Validate damage is reasonable (1-100)
      const damage = clamp(data.damage || 25, 1, 100);

      // Server-side health calculation (prevent client tampering)
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

  socket.on('chat_message', (data) => {
    const p = players.get(socket.id);
    if (!p) return;

    const message = (data.message || '').trim().slice(0, 100);
    if (!message) return;

    io.emit('chat_message', {
      username: p.username,
      message: message,
      timestamp: Date.now(),
    });
  });

  socket.on('weapon_change', (data) => {
    const p = players.get(socket.id);
    if (!p) return;
    
    // Store current weapon for this player
    p.currentWeapon = data.weapon || 'ar';
    
    // Broadcast to other players
    socket.broadcast.emit('player_weapon_change', {
      id: socket.id,
      weapon: p.currentWeapon
    });
  });

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
    // Save kills to MongoDB with server-side validation
    if (accountsCollection && killer.username) {
      try {
        // Get current total kills from database to prevent tampering
        const account = await accountsCollection.findOne({ username: killer.username });
        if (account) {
          // Use max of server-side count and database count to prevent rollback
          const dbKills = account.totalKills || 0;
          const newTotalKills = Math.max(killer.kills, dbKills);
          await accountsCollection.updateOne(
            { username: killer.username },
            { $set: { totalKills: newTotalKills } }
          );
        }
      } catch (error) {
        console.error('Failed to save kills:', error);
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
      currentWeapon: p.currentWeapon || 'ar',
    };
  }
  io.emit('world_state', state);
}, TICK_MS);

http.listen(PORT, () => {
  console.log(`Test server → http://localhost:${PORT}`);
});
