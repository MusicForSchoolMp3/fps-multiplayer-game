// Server with MongoDB authentication
import { createServer } from 'http';
import express from 'express';
import compression from 'compression';
import { Server } from 'socket.io';
import msgpackParser from 'socket.io-msgpack-parser';
import { MongoClient } from 'mongodb';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readdirSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PORT = process.env.PORT || 3001;
const TICK_MS = 1000 / 18; // Reduced from 30Hz to 18Hz for bandwidth optimization
const MAX_HP = 100;
const RESPAWN_S = 3;

// Interest management: only replicate players within this horizontal radius.
// The sniper has maxRange 200, so this must not dip below that or legitimate
// long-range shots would stop rendering. 200 covers essentially the whole
// 150x150 map except the far corners, so it is gameplay-neutral yet still
// drops the few players a given client will never engage.
const VIEW_RANGE = 200.0;

// ════════════════════════════════════════════════════════════════════════════
//  EMOTE MANIFEST  (auto-detected from /emote animations/)
//  Every .glb in the folder becomes an emote. Prices come from an optional
//  "(NNN total kills)" tag in the filename; unpriced emotes are distributed
//  smoothly between 100 (easiest) and 10,000 (hardest). Nothing is hardcoded.
// ════════════════════════════════════════════════════════════════════════════
const EMOTE_DIR = join(__dirname, '..', 'emote animations');

// Returns { id, name, price } parsed from a single filename. The kill cost is
// taken from an optional "(NNN total kills)" tag; everything else is the name.
function parseEmoteMeta(base) {
  const priceMatch = base.match(/\(([\d,]+)\s*total\s*kills\)/i);
  const price = priceMatch ? parseInt(priceMatch[1].replace(/,/g, ''), 10) : null;
  const cleanName = base.replace(/\s*\([^)]*total\s*kills\)\s*$/i, '').trim() || 'Emote';
  const id = cleanName.toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '') || `emote_${Math.random().toString(36).slice(2, 8)}`;
  return { id, name: cleanName, price };
}

// Smooth exponential distribution 100 → 10,000 across n unpriced emotes.
function distributedPrice(i, n) {
  if (n <= 1) return 100;
  const raw = 100 * Math.pow(100, i / (n - 1));
  const nice = raw < 500 ? Math.round(raw / 50) * 50
            : raw < 2500 ? Math.round(raw / 100) * 100
            : Math.round(raw / 500) * 500;
  return Math.max(100, Math.min(10000, nice));
}

function buildEmoteManifest() {
  let files = [];
  try {
    files = readdirSync(EMOTE_DIR).filter(f => f.toLowerCase().endsWith('.glb'));
  } catch (e) {
    console.warn(`[Emotes] Folder not found: ${EMOTE_DIR} - no emotes available`);
  }

  const emotes = files.map((file) => {
    const base = file.replace(/\.glb$/i, '');
    const meta = parseEmoteMeta(base);
    return {
      id: meta.id,
      file,
      name: meta.name,
      url: `/emote animations/${encodeURIComponent(file)}`,
      price: meta.price, // null until auto-assigned below
    };
  });

  // Stable ordering then auto-price anything that lacked an explicit tag.
  emotes.sort((a, b) => a.file.localeCompare(b.file));
  const unpriced = emotes.filter(e => e.price === null);
  unpriced.forEach((e, i) => { e.price = distributedPrice(i, Math.max(1, unpriced.length)); });

  // Push any degenerate price tags inside the allowed band.
  for (const e of emotes) {
    if (e.price !== null) e.price = Math.max(100, Math.min(10000, e.price));
  }

  // Final order: easiest → hardest (ascending price)
  emotes.sort((a, b) => a.price - b.price);
  return emotes;
}

const EMOTES = buildEmoteManifest();
const EMOTE_BY_ID = new Map(EMOTES.map(e => [e.id, e]));
const DEFAULT_EMOTE_ID = EMOTES.length ? EMOTES[0].id : null;
const EMPTY_WHEEL = Array(10).fill(null);

function defaultWheel() {
  const wheel = EMPTY_WHEEL.slice();
  if (DEFAULT_EMOTE_ID) wheel[0] = DEFAULT_EMOTE_ID;
  return wheel;
}

console.log(`[Emotes] Detected ${EMOTES.length} emote(s): ${EMOTES.map(e => `${e.name}(${e.price})`).join(', ') || '(none)'}`);

// Anticheat constants
const MAX_SPEED = 15.0; // Maximum allowed speed (units/sec)
const ANTICHEAT_WARNINGS_THRESHOLD = 3; // Number of warnings before kick
const ANTICHEAT_BAN_DURATION = 300000; // 5 minutes in milliseconds

// ── Leaderboard helpers ────────────────────────────────────────────────────────
// Testing blacklist: these accounts are locked out of the game.
const BLACKLISTED_USERS = ['ben', 'dom'];
function isBlacklisted(username) {
  return BLACKLISTED_USERS.includes((username || '').toLowerCase());
}
// Current calendar month key, used to bucket "monthly kills".
function currentMonthKey() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

// Weapon configurations for server-side validation
const WEAPONS = {
  ar: {
    name: 'AR',
    maxAmmo: 30,
    reserveMax: 90,
    reloadTime: 2.0,
    fireRate: 0.1,
    damage: 25,
    maxRange: 120
  },
  sniper: {
    name: 'Sniper',
    maxAmmo: 1,
    reserveMax: 10,
    reloadTime: 2.5,
    fireRate: 0.15,
    damage: 100,
    maxRange: 200
  }
};

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

    // Wait a moment for collection to be fully ready
    await new Promise(resolve => setTimeout(resolve, 500));

    // Migration: Add skins field to existing accounts that don't have it
    try {
      // First, count total accounts
      const totalCount = await accountsCollection.countDocuments();
      console.log(`Total accounts in database: ${totalCount}`);

      // Count accounts without skins
      const withoutSkins = await accountsCollection.countDocuments({ skins: { $exists: false } });
      console.log(`Accounts without skins field: ${withoutSkins}`);

      if (withoutSkins > 0) {
        const result = await accountsCollection.updateMany(
          { skins: { $exists: false } },
          { $set: { skins: ['ar_default', 'sniper_midnight'] } }
        );
        console.log(`Skin migration: matched ${result.matchedCount}, modified ${result.modifiedCount} accounts`);
      } else {
        console.log('All accounts already have skins field');
      }
    } catch (migrationError) {
      console.error('Skin migration error:', migrationError);
    }

    // Migration: Add anticheat fields to existing accounts that don't have them
    try {
      const withoutAnticheat = await accountsCollection.countDocuments({ anticheatWarnings: { $exists: false } });
      console.log(`Accounts without anticheat field: ${withoutAnticheat}`);

      if (withoutAnticheat > 0) {
        const result = await accountsCollection.updateMany(
          { anticheatWarnings: { $exists: false } },
          { $set: { anticheatWarnings: 0, lastAnticheatWarning: null, lastAnticheatReason: null, isBanned: false, banExpiry: null } }
        );
        console.log(`Anticheat migration: matched ${result.matchedCount}, modified ${result.modifiedCount} accounts`);
      } else {
        console.log('All accounts already have anticheat field');
      }
      
      // Clear any existing bans from previous false positives
      const clearBansResult = await accountsCollection.updateMany(
        { isBanned: true },
        { $set: { isBanned: false, banExpiry: null, anticheatWarnings: 0 } }
      );
      if (clearBansResult.modifiedCount > 0) {
        console.log(`Cleared ${clearBansResult.modifiedCount} existing bans from false positives`);
      }
    } catch (anticheatMigrationError) {
      console.error('Anticheat migration error:', anticheatMigrationError);
    }

    // Migration: Add emote fields to existing accounts (no new accounts needed).
    try {
      const defaultUnlocked = DEFAULT_EMOTE_ID ? [DEFAULT_EMOTE_ID] : [];
      const defaultWheelVal = defaultWheel();

      // Accounts missing unlockedEmotes entirely
      const withoutUnlocked = await accountsCollection.countDocuments({ unlockedEmotes: { $exists: false } });
      if (withoutUnlocked > 0) {
        const result = await accountsCollection.updateMany(
          { unlockedEmotes: { $exists: false } },
          { $set: { unlockedEmotes: defaultUnlocked, equippedEmotes: defaultWheelVal } }
        );
        console.log(`Emote migration (unlockedEmotes): matched ${result.matchedCount}, modified ${result.modifiedCount} accounts`);
      }

      // Accounts that have unlockedEmotes but no equippedEmotes yet
      const withoutEquipped = await accountsCollection.countDocuments({
        unlockedEmotes: { $exists: true },
        equippedEmotes: { $exists: false }
      });
      if (withoutEquipped > 0) {
        const result = await accountsCollection.updateMany(
          { unlockedEmotes: { $exists: true }, equippedEmotes: { $exists: false } },
          { $set: { equippedEmotes: defaultWheelVal } }
        );
        console.log(`Emote migration (equippedEmotes): matched ${result.matchedCount}, modified ${result.modifiedCount} accounts`);
      }

      // Sanity: any account with a malformed (non-array) wheel gets reset
      const malformed = await accountsCollection.countDocuments({ equippedEmotes: { $not: { $type: 'array' } } });
      if (malformed > 0) {
        const result = await accountsCollection.updateMany(
          { equippedEmotes: { $not: { $type: 'array' } } },
          { $set: { equippedEmotes: defaultWheelVal } }
        );
        console.log(`Emote migration (malformed wheel): matched ${result.matchedCount}, modified ${result.modifiedCount} accounts`);
      }
    } catch (emoteMigrationError) {
      console.error('Emote migration error:', emoteMigrationError);
    }
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
  const now = Date.now();
  return {
    id: socket.id,
    accountId: username,
    username: username,
    name: username,
    colorIndex: (colorCounter++) % COLORS.length,
    x: spawn.x, y: spawn.y, z: spawn.z,
    yaw: 0, pitch: 0, speed: 0,
    isGrounded: true,
    velocityY: 0,
    health: MAX_HP,
    kills: 0,
    deaths: 0,
    isDead: false,
    lastSeen: Date.now(),
    currentWeapon: 'ar',
    // Emotes: per-account unlocked set + currently playing emote (server mirrors)
    unlockedEmotes: new Set(),
    currentEmote: null,
    // Anticheat tracking
    anticheatWarnings: 0,
    lastAnticheatWarning: 0,
    isBanned: false,
    banExpiry: 0,
    // Weapon anticheat tracking
    lastShotTime: now,
    lastReloadTime: now,
    lastReloadWeapon: 'ar', // which weapon the last reload_start belonged to
    isReloading: false,
    reloadStartTime: 0,
    // Previous state for delta compression
    _prev: {
      x: spawn.x, y: spawn.y, z: spawn.z,
      yaw: 0, pitch: 0, speed: 0,
      isGrounded: true,
      velocityY: 0,
      health: MAX_HP,
      isDead: false,
      currentWeapon: 'ar',
      username: username,
    },
  };
}

function sanitize(p) {
  return {
    x: p.x, y: p.y, z: p.z,
    yaw: p.yaw, pitch: p.pitch,
    speed: p.speed,
    isGrounded: p.isGrounded,
    velocityY: p.velocityY || 0, // Include vertical velocity for jump animation sync
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

// Emit an event only to players within VIEW_RANGE of `from` (bandwidth-friendly).
function broadcastToNearby(event, payload, from) {
  const viewSq = VIEW_RANGE * VIEW_RANGE;
  for (const [id, p] of players) {
    if (!from || id === from.id) continue;
    const sock = io.sockets.sockets.get(id);
    if (!sock || !sock.connected) continue;
    const dx = p.x - from.x;
    const dz = p.z - from.z;
    if (dx * dx + dz * dz > viewSq) continue;
    sock.emit(event, payload);
  }
}

// Anticheat: Kick player and add warning to account
async function kickPlayerForCheating(socket, player, reason) {
  console.log(`[Anticheat] Kicking ${player.username} for: ${reason}`);
  
  // Set ban status
  const banExpiry = Date.now() + ANTICHEAT_BAN_DURATION;
  player.isBanned = true;
  player.banExpiry = banExpiry;
  
  // Notify player
  socket.emit('anticheat_kick', {
    reason: reason,
    duration: ANTICHEAT_BAN_DURATION / 1000, // seconds
    expiry: new Date(banExpiry).toISOString()
  });
  
  // Add warning and ban to database if available
  if (accountsCollection) {
    try {
      await accountsCollection.updateOne(
        { username: player.username },
        {
          $inc: { anticheatWarnings: 1 },
          $set: { 
            lastAnticheatWarning: new Date(),
            lastAnticheatReason: reason,
            isBanned: true,
            banExpiry: new Date(banExpiry)
          }
        }
      );
      console.log(`[Anticheat] Added warning and ban to database for ${player.username} until ${new Date(banExpiry).toISOString()}`);
    } catch (error) {
      console.error(`[Anticheat] Failed to update database warning: ${error}`);
    }
  }
  
  // Disconnect player
  players.delete(socket.id);
  socket.disconnect();
  
  // Notify other players
  socket.broadcast.emit('player_leave', socket.id);
}

// Quantization functions to reduce bandwidth
function quantizePosition(val) {
  // Round to 2 decimal places (1cm precision) - reduces float precision
  return Math.round(val * 100) / 100;
}

function quantizeRotation(val) {
  // Round to 3 decimal places for rotation (better precision needed for smooth gameplay)
  return Math.round(val * 1000) / 1000;
}

// Delta compression - only send changed fields
function createDeltaUpdate(prevState, currentState) {
  const delta = {};
  let hasChanges = false;

  // Check position changes
  if (prevState.x !== currentState.x) {
    delta.x = quantizePosition(currentState.x);
    hasChanges = true;
  }
  if (prevState.y !== currentState.y) {
    delta.y = quantizePosition(currentState.y);
    hasChanges = true;
  }
  if (prevState.z !== currentState.z) {
    delta.z = quantizePosition(currentState.z);
    hasChanges = true;
  }

  // Check rotation changes
  if (prevState.yaw !== currentState.yaw) {
    delta.yaw = quantizeRotation(currentState.yaw);
    hasChanges = true;
  }
  if (prevState.pitch !== currentState.pitch) {
    delta.pitch = quantizeRotation(currentState.pitch);
    hasChanges = true;
  }

  // Check other state changes
  if (prevState.speed !== currentState.speed) {
    delta.speed = currentState.speed;
    hasChanges = true;
  }
  if (prevState.isGrounded !== currentState.isGrounded) {
    delta.isGrounded = currentState.isGrounded;
    hasChanges = true;
  }
  if (prevState.velocityY !== currentState.velocityY) {
    delta.velocityY = quantizePosition(currentState.velocityY);
    hasChanges = true;
  }
  if (prevState.health !== currentState.health) {
    delta.health = currentState.health;
    hasChanges = true;
  }
  if (prevState.isDead !== currentState.isDead) {
    delta.isDead = currentState.isDead;
    hasChanges = true;
  }
  if (prevState.currentWeapon !== currentState.currentWeapon) {
    delta.currentWeapon = currentState.currentWeapon;
    hasChanges = true;
  }

  // Always include username for new players or if it changed
  if (!prevState.username || prevState.username !== currentState.username) {
    delta.username = currentState.username;
    hasChanges = true;
  }

  return hasChanges ? delta : null;
}

const app = express();
const http = createServer(app);
const io = new Server(http, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  parser: msgpackParser, // Binary MessagePack wire format (replaces verbose JSON)
});

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use(express.json());

// Brotli/gzip compression for every text & JSON response (API + static).
// Silent no-op for already-compressed binary assets (glb/fbx).
app.use(compression({
  threshold: 512, // compress even small responses
  brotli: { enabled: true, quality: 5 }, // brotli preferred by modern browsers
}));

// API endpoints for account management (must be before static files)
app.post('/api/register', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Missing username or password' });

  // Validate username: only letters, numbers and underscores, 3-20 characters.
  // No spaces, emojis or special characters (e.g. * ; : { [ ...).
  if (username.length < 3 || username.length > 20) {
    return res.status(400).json({ error: 'Username must be 3-20 characters' });
  }
  if (!/^[a-zA-Z0-9_]+$/.test(username)) {
    return res.status(400).json({ error: 'Username can only contain letters, numbers and underscores' });
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
      monthKey: currentMonthKey(),
      monthKills: 0,
      skins: ['ar_default', 'sniper_midnight'], // Default skins
      unlockedEmotes: DEFAULT_EMOTE_ID ? [DEFAULT_EMOTE_ID] : [], // New accounts start with the cheapest emote
      equippedEmotes: defaultWheel(),
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
      unlockedEmotes: account.unlockedEmotes || [],
      equippedEmotes: Array.isArray(account.equippedEmotes) ? account.equippedEmotes : defaultWheel(),
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
      skins: account.skins || ['ar_default', 'sniper_midnight'],
      unlockedEmotes: account.unlockedEmotes || [],
      equippedEmotes: Array.isArray(account.equippedEmotes) ? account.equippedEmotes : defaultWheel()
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

// ── Emote API ────────────────────────────────────────────────────────────────
// Public manifest (no auth needed): every emote + its price.
app.get('/api/emotes', (req, res) => {
  res.json({ emotes: EMOTES.map(e => ({ id: e.id, name: e.name, price: e.price, file: e.file, url: e.url })) });
});

// Unlock an emote using LIFETIME total kills. Kills are never deducted.
app.post('/api/emotes/unlock', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  const { emoteId } = req.body || {};
  if (!token) return res.status(401).json({ error: 'Missing token' });
  if (!emoteId) return res.status(400).json({ error: 'Missing emoteId' });

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (!accountsCollection) return res.status(500).json({ error: 'Database not available' });

    const account = await accountsCollection.findOne({ username: decoded.username });
    if (!account) return res.status(401).json({ error: 'Account not found' });

    const emote = EMOTE_BY_ID.get(emoteId);
    if (!emote) return res.status(404).json({ error: 'Emote not found' });

    const unlocked = account.unlockedEmotes || [];
    if (unlocked.includes(emoteId)) {
      return res.json({ success: true, alreadyUnlocked: true, unlockedEmotes: unlocked });
    }

    // Kills are a lifetime requirement only - nothing is spent.
    const totalKills = account.totalKills || 0;
    if (totalKills < emote.price) {
      return res.status(400).json({ error: `Requires ${emote.price} total kills` });
    }

    const newUnlocked = [...unlocked, emoteId];
    await accountsCollection.updateOne({ username: decoded.username }, { $set: { unlockedEmotes: newUnlocked } });
    res.json({ success: true, unlockedEmotes: newUnlocked });
  } catch (error) {
    if (error.name === 'JsonWebTokenError') return res.status(401).json({ error: 'Invalid token' });
    if (error.name === 'TokenExpiredError') return res.status(401).json({ error: 'Token expired' });
    console.error('Unlock emote error:', error);
    res.status(500).json({ error: 'Failed to unlock emote' });
  }
});

// Save the equipped wheel layout (exactly 10 slots, only unlocked emotes).
app.post('/api/emotes/equip', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  const { equippedEmotes } = req.body || {};
  if (!token) return res.status(401).json({ error: 'Missing token' });
  if (!Array.isArray(equippedEmotes) || equippedEmotes.length !== 10) {
    return res.status(400).json({ error: 'Wheel must have exactly 10 slots' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (!accountsCollection) return res.status(500).json({ error: 'Database not available' });

    const account = await accountsCollection.findOne({ username: decoded.username });
    if (!account) return res.status(401).json({ error: 'Account not found' });

    const unlocked = account.unlockedEmotes || [];
    // Server-side validation: only unlocked emotes, unknown ids become empty slots.
    const clean = equippedEmotes.map(v => {
      const s = v === null || v === undefined || v === '' ? null : String(v);
      return s && unlocked.includes(s) && EMOTE_BY_ID.has(s) ? s : null;
    });

    await accountsCollection.updateOne({ username: decoded.username }, { $set: { equippedEmotes: clean } });
    res.json({ success: true, equippedEmotes: clean });
  } catch (error) {
    if (error.name === 'JsonWebTokenError') return res.status(401).json({ error: 'Invalid token' });
    if (error.name === 'TokenExpiredError') return res.status(401).json({ error: 'Token expired' });
    console.error('Equip emote error:', error);
    res.status(500).json({ error: 'Failed to save emote layout' });
  }
});

// ── Leaderboard ────────────────────────────────────────────────────────────────
// GET /api/leaderboard?type=global|monthly&limit=50
// Returns the top accounts by kills (excluding blacklisted accounts), in real
// time from the database.
app.get('/api/leaderboard', async (req, res) => {
  if (!accountsCollection) return res.status(500).json({ error: 'Database not available' });

  const type = req.query.type === 'monthly' ? 'monthly' : 'global';
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 100));

  try {
    // Query: exclude blacklisted, pick the right kill counter.
    const filter = { username: { $nin: BLACKLISTED_USERS } };
    const sortField = type === 'monthly' ? 'monthKills' : 'totalKills';
    if (type === 'monthly') filter.monthKey = currentMonthKey(); // only current-month kills

    const docs = await accountsCollection
      .find(filter, { projection: { username: 1, totalKills: 1, monthKey: 1, monthKills: 1 } })
      .sort({ [sortField]: -1, _id: 1 })
      .limit(limit)
      .toArray();

    // Sequential positions 1..N - every row gets its own spot even when kills
    // are tied (no duplicate rank numbers).
    const list = docs.map((acc, i) => {
      const kills = type === 'monthly' ? (acc.monthKills || 0) : (acc.totalKills || 0);
      return { rank: i + 1, username: acc.username, kills };
    });

    res.json({ type, month: currentMonthKey(), entries: list });
  } catch (error) {
    console.error('Leaderboard error:', error);
    res.status(500).json({ error: 'Failed to load leaderboard' });
  }
});

// Static file serving with proper caching headers (must be after API routes)
app.use(express.static('dist', {
  maxAge: '1y', // Cache for 1 year for hashed assets
  etag: true,
  lastModified: true,
  setHeaders: (res, filePath) => {
    // For hashed assets (Vite build outputs), cache aggressively
    if (filePath.includes('.')) {
      const ext = filePath.split('.').pop().toLowerCase();
      // Cache static assets with long duration
      if (['js', 'css', 'png', 'jpg', 'jpeg', 'gif', 'svg', 'ico', 'woff', 'woff2', 'ttf', 'eot'].includes(ext)) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      }
    }
  }
}));

app.use(express.static('.', {
  maxAge: '30d', // Longer cache for heavy binary assets (they never change at runtime)
  etag: true,
  lastModified: true,
  setHeaders: (res, filePath) => {
    const ext = filePath.split('.').pop().toLowerCase();
    // Cache model files for 30 days - they are immutable at runtime.
    // Previously 1h/1d meant every fresh or expired client re-downloaded
    // the 38MB Character.glb + 15MB sniper GLBs.
    if (['fbx', 'glb', 'gltf', 'bin', 'ktx2', 'drc'].includes(ext)) {
      res.setHeader('Cache-Control', 'public, max-age=2592000');
    }
    // Text assets at the repo root (JSON, fonts) can be compressed + cached
    if (['json', 'css', 'js', 'txt'].includes(ext)) {
      res.setHeader('Cache-Control', 'public, max-age=604800');
    }
  }
}));

io.on('connection', async (socket) => {
  const token = socket.handshake.auth.token;
  let username = null;
  let accountUnlocked = new Set();

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
        // Load this account's unlocked emotes for server-side validation
        accountUnlocked = new Set(account.unlockedEmotes || []);
        
        // Check if account is currently banned
        if (account.isBanned && account.banExpiry) {
          const banExpiry = new Date(account.banExpiry);
          const now = new Date();
          if (now < banExpiry) {
            const remainingTime = Math.ceil((banExpiry - now) / 1000);
            console.log(`[-] Rejected connection: ${username} is banned for ${remainingTime} more seconds`);
            socket.emit('anticheat_kick', {
              reason: 'You are currently banned for anticheat violations',
              duration: remainingTime,
              expiry: banExpiry.toISOString()
            });
            socket.disconnect();
            return;
          } else {
            // Ban has expired, clear it
            await accountsCollection.updateOne(
              { username },
              { $set: { isBanned: false, banExpiry: null } }
            );
            console.log(`[+] Ban expired for ${username}, cleared database ban`);
          }
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
  player.unlockedEmotes = accountUnlocked;
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
    
    // Anticheat: Check if player is banned
    if (p.isBanned && Date.now() < p.banExpiry) {
      console.log(`[Anticheat] Banned player ${p.username} attempted to move`);
      socket.disconnect();
      return;
    }
    
    // Reset ban if expired
    if (p.isBanned && Date.now() >= p.banExpiry) {
      p.isBanned = false;
      p.anticheatWarnings = 0;
      console.log(`[Anticheat] Ban expired for ${p.username}`);
    }
    
    // Anticheat: Speed check
    const speed = Math.abs(snap.speed || 0);
    if (speed > MAX_SPEED) {
      p.anticheatWarnings++;
      p.lastAnticheatWarning = Date.now();
      console.log(`[Anticheat] Speed violation for ${p.username}: ${speed} > ${MAX_SPEED} (Warning ${p.anticheatWarnings}/${ANTICHEAT_WARNINGS_THRESHOLD})`);
      
      if (p.anticheatWarnings >= ANTICHEAT_WARNINGS_THRESHOLD) {
        kickPlayerForCheating(socket, p, 'Speed hacking detected');
        return;
      }
    }
    
    // Anticheat: Height/Flight check (account for eye height)
    const eyeHeight = 1.65; // Match client EYE_HEIGHT
    const groundHeight = (snap.y || 0) - eyeHeight;
    // Allow some tolerance for jumping (normal jump reaches ~1-2 units above ground)
    const maxJumpHeight = 8.0; // Maximum reasonable jump height (increased for safety)
    if (groundHeight > maxJumpHeight && !snap.isGrounded) {
      p.anticheatWarnings++;
      p.lastAnticheatWarning = Date.now();
      console.log(`[Anticheat] Height violation for ${p.username}: ${groundHeight} > ${maxJumpHeight} (Warning ${p.anticheatWarnings}/${ANTICHEAT_WARNINGS_THRESHOLD})`);
      
      if (p.anticheatWarnings >= ANTICHEAT_WARNINGS_THRESHOLD) {
        kickPlayerForCheating(socket, p, 'Flight hacking detected');
        return;
      }
    }
    
    p.x = clamp(snap.x, -74, 74);
    p.y = Math.max(0, snap.y);
    p.z = clamp(snap.z, -74, 74);
    p.yaw = snap.yaw || 0;
    p.pitch = clamp(snap.pitch || 0, -Math.PI / 2, Math.PI / 2);
    p.speed = Math.abs(snap.speed || 0);
    p.isGrounded = !!snap.isGrounded;
    p.velocityY = snap.velocityY || 0; // Store vertical velocity for jump animation sync
    p.lastSeen = Date.now();

    // Emotes are cancelled by ANY movement. The server enforces this so all
    // clients stay in sync even if a player's client misbehaves.
    if (p.currentEmote && (p.speed > 0.1 || !p.isGrounded)) {
      p.currentEmote = null;
      broadcastToNearby('player_emote_stop', { id: socket.id }, p);
    }
  });

  socket.on('emote_start', (data) => {
    const p = players.get(socket.id);
    if (!p || p.isDead || p.isBanned) return;
    const emoteId = (data && (data.emoteId || data.id)) || null;
    const emote = EMOTE_BY_ID.get(emoteId);
    if (!emote) return;
    // Cheat guard: must actually own the emote
    if (p.unlockedEmotes && p.unlockedEmotes.size > 0 && !p.unlockedEmotes.has(emoteId)) return;
    if (!p.currentEmote || p.currentEmote !== emoteId) {
      p.currentEmote = emoteId;
      broadcastToNearby('player_emote', { id: socket.id, emoteId }, p);
    }
  });

  socket.on('emote_stop', () => {
    const p = players.get(socket.id);
    if (!p) return;
    if (p.currentEmote) {
      p.currentEmote = null;
      broadcastToNearby('player_emote_stop', { id: socket.id }, p);
    }
  });

  socket.on('shoot', (data) => {
    const shooter = players.get(socket.id);
    if (!shooter || shooter.isDead) return;

    // Validate shooter is alive and legitimate
    if (shooter.health <= 0) return;

    // Anticheat: Check if player is banned
    if (shooter.isBanned && Date.now() < shooter.banExpiry) {
      console.log(`[Anticheat] Banned player ${shooter.username} attempted to shoot`);
      socket.disconnect();
      return;
    }

    // Get weapon configuration
    const weaponConfig = WEAPONS[shooter.currentWeapon] || WEAPONS.ar;
    
    // Anticheat: Fire rate validation (with network latency tolerance)
    const now = Date.now();
    const timeSinceLastShot = now - shooter.lastShotTime;
    const minFireRate = weaponConfig.fireRate * 1000; // Convert to milliseconds
    const latencyTolerance = 100; // 100ms tolerance for network latency
    
    // Only check fire rate for sniper (AR is meant to be rapid fire)
    if (shooter.currentWeapon === 'sniper' && timeSinceLastShot < minFireRate - latencyTolerance) {
      shooter.anticheatWarnings++;
      shooter.lastAnticheatWarning = now;
      console.log(`[Anticheat] Fire rate violation for ${shooter.username}: ${timeSinceLastShot}ms < ${minFireRate - latencyTolerance}ms (Warning ${shooter.anticheatWarnings}/${ANTICHEAT_WARNINGS_THRESHOLD})`);
      
      if (shooter.anticheatWarnings >= ANTICHEAT_WARNINGS_THRESHOLD) {
        kickPlayerForCheating(socket, shooter, 'Rapid fire hacking detected');
        return;
      }
    }
    
    // Update last shot time
    shooter.lastShotTime = now;
    
    // Cancel reload if player shoots (realistic behavior)
    if (shooter.isReloading) {
      shooter.isReloading = false;
      shooter.reloadStartTime = 0;
    }

    // Anticheat: Damage validation based on weapon
    const clientDamage = data.damage || 25;
    const expectedDamage = weaponConfig.damage;
    
    // Allow small margin of error for network latency but catch obvious damage hacks
    if (clientDamage > expectedDamage * 1.5) {
      shooter.anticheatWarnings++;
      shooter.lastAnticheatWarning = now;
      console.log(`[Anticheat] Damage violation for ${shooter.username}: ${clientDamage} > ${expectedDamage * 1.5} (Warning ${shooter.anticheatWarnings}/${ANTICHEAT_WARNINGS_THRESHOLD})`);
      
      if (shooter.anticheatWarnings >= ANTICHEAT_WARNINGS_THRESHOLD) {
        kickPlayerForCheating(socket, shooter, 'Damage hacking detected');
        return;
      }
    }
    
    // Use server-side damage value to prevent tampering
    const serverDamage = expectedDamage;

    // Broadcast tracer to everyone EXCEPT the shooter (they already see the
    // local tracer). Previously this was io.emit (sent to the shooter too,
    // who ignored it) - saving one redundant N-of-N delivery per shot.
    socket.broadcast.emit('player_shot', {
      shooterId: socket.id,
      origin: data.origin,
      dir: data.dir,
    });

    if (data.hitId && players.has(data.hitId)) {
      const victim = players.get(data.hitId);
      if (victim.isDead) return;

      // Server-side health calculation (prevent client tampering)
      victim.health = Math.max(0, victim.health - serverDamage);

      io.to(data.hitId).emit('player_hit', {
        shooterId: socket.id, victimId: data.hitId, damage: serverDamage, health: victim.health,
      });
      socket.emit('player_hit', {
        shooterId: socket.id, victimId: data.hitId, damage: serverDamage, health: victim.health,
      });
      // Only the victim needs their health bar updated. Previously emitted to
      // every client on every shot - the health value is also already present
      // in the victim's player_hit payload, so this is purely the HUD sync.
      io.to(data.hitId).emit('health_update', { id: data.hitId, health: victim.health });

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
    
    // Swapping weapons legitimately cancels any in-progress reload and resets
    // the reload timer window (a reload of the *new* gun must not be compared
    // against the *old* gun's reload timestamp - that caused false bans when
    // switching guns and reloading quickly).
    p.isReloading = false;
    p.reloadStartTime = 0;
    p.lastReloadWeapon = p.currentWeapon;
    const now = Date.now();
    p.lastReloadTime = now;
    p.lastShotTime = now;
    
    // Broadcast to other players
    socket.broadcast.emit('player_weapon_change', {
      id: socket.id,
      weapon: p.currentWeapon
    });
  });

  socket.on('reload_start', (data) => {
    const p = players.get(socket.id);
    if (!p || p.isDead) return;

    // Anticheat: Check if player is banned
    if (p.isBanned && Date.now() < p.banExpiry) {
      console.log(`[Anticheat] Banned player ${p.username} attempted to reload`);
      socket.disconnect();
      return;
    }

    // Get weapon configuration
    const weaponConfig = WEAPONS[p.currentWeapon] || WEAPONS.ar;
    
    // Anticheat: Reload time validation
    const now = Date.now();
    const timeSinceLastReload = now - p.lastReloadTime;
    const minReloadTime = weaponConfig.reloadTime * 1000; // Convert to milliseconds
    
    // Check if reload is happening too quickly. Only counts as a violation when
    // the SAME weapon is being reloaded again (switching guns mid-reload is
    // legitimate and must not trip the anti-cheat).
    if (p.isReloading && p.lastReloadWeapon === p.currentWeapon && timeSinceLastReload < minReloadTime * 0.8) {
      p.anticheatWarnings++;
      p.lastAnticheatWarning = now;
      console.log(`[Anticheat] Reload time violation for ${p.username}: ${timeSinceLastReload}ms < ${minReloadTime * 0.8}ms (Warning ${p.anticheatWarnings}/${ANTICHEAT_WARNINGS_THRESHOLD})`);
      
      if (p.anticheatWarnings >= ANTICHEAT_WARNINGS_THRESHOLD) {
        kickPlayerForCheating(socket, p, 'Reload hacking detected');
        return;
      }
    }
    
    // Update reload state
    p.isReloading = true;
    p.reloadStartTime = now;
    p.lastReloadTime = now;
    p.lastReloadWeapon = p.currentWeapon;
  });

  socket.on('reload_complete', (data) => {
    const p = players.get(socket.id);
    if (!p || p.isDead) return;

    // Anticheat: Check if player is banned
    if (p.isBanned && Date.now() < p.banExpiry) {
      console.log(`[Anticheat] Banned player ${p.username} attempted to complete reload`);
      socket.disconnect();
      return;
    }

    // Get weapon configuration
    const weaponConfig = WEAPONS[p.currentWeapon] || WEAPONS.ar;
    
    // Anticheat: Validate reload completion time
    const now = Date.now();
    // reloadStartTime is 0 when the weapon was switched mid-reload, so there is
    // no valid duration to validate against - never flag that.
    if (p.reloadStartTime === 0) {
      p.isReloading = false;
      return;
    }
    const reloadDuration = now - p.reloadStartTime;
    const expectedReloadTime = weaponConfig.reloadTime * 1000; // Convert to milliseconds
    
    // Allow 20% margin for network latency but catch obvious reload hacks
    if (reloadDuration < expectedReloadTime * 0.8) {
      p.anticheatWarnings++;
      p.lastAnticheatWarning = now;
      console.log(`[Anticheat] Reload completion time violation for ${p.username}: ${reloadDuration}ms < ${expectedReloadTime * 0.8}ms (Warning ${p.anticheatWarnings}/${ANTICHEAT_WARNINGS_THRESHOLD})`);
      
      if (p.anticheatWarnings >= ANTICHEAT_WARNINGS_THRESHOLD) {
        kickPlayerForCheating(socket, p, 'Instant reload hacking detected');
        return;
      }
    }
    
    // Update reload state
    p.isReloading = false;
  });

  socket.on('disconnect', () => {
    if (player.currentEmote) {
      broadcastToNearby('player_emote_stop', { id: socket.id }, player);
    }
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
    // Save kills to MongoDB (server-authoritative).
    if (accountsCollection && killer.username) {
      try {
        // Get current account (needed for the monthly-bucket check).
        const account = await accountsCollection.findOne({ username: killer.username });
        if (account) {
          // Always increment the lifetime counter by one per kill. Previously we
          // wrote max(sessionKills, dbTotal); sessionKills resets to 0 on every
          // login, so once the DB total passed the session count the number could
          // never grow again - kills appeared frozen on subsequent sessions.
          await accountsCollection.updateOne(
            { username: killer.username },
            { $inc: { totalKills: 1 } }
          );

          // Track monthly kills. If the stored month is stale (including legacy
          // accounts with no monthKey), reset the counter for the current month
          // first, then always increment by one.
          const monthKey = currentMonthKey();
          if (account.monthKey !== monthKey) {
            await accountsCollection.updateOne(
              { username: killer.username, monthKey: { $ne: monthKey } },
              { $set: { monthKey, monthKills: 0 } }
            );
          }
          await accountsCollection.updateOne(
            { username: killer.username },
            { $inc: { monthKills: 1 } }
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
    const now = Date.now();
    p.x = s.x; p.y = s.y; p.z = s.z;
    p.health = MAX_HP;
    p.isDead = false;
    // Reset weapon anticheat tracking on respawn
    p.isReloading = false;
    p.reloadStartTime = 0;
    p.lastShotTime = now;
    p.lastReloadTime = now;
    p.lastReloadWeapon = p.currentWeapon;
    // Emote state must not survive death/respawn
    p.currentEmote = null;
    io.emit('player_respawn', { id: victimId, ...s });
    io.emit('health_update', { id: victimId, health: MAX_HP });
  }, RESPAWN_S * 1000);
}

setInterval(() => {
  // ── Phase 1: compute deltas once per player (per tick) ──────────────────
  const deltas = new Map();
  for (const [id, p] of players) {
    const currentState = {
      x: p.x, y: p.y, z: p.z,
      yaw: p.yaw, pitch: p.pitch,
      speed: p.speed, isGrounded: p.isGrounded,
      health: p.health, isDead: p.isDead,
      username: p.username,
      currentWeapon: p.currentWeapon || 'ar',
    };

    const delta = createDeltaUpdate(p._prev, currentState);

    // If there are changes, send delta and update previous state
    if (delta) {
      deltas.set(id, delta);
      // Update previous state for next comparison
      p._prev = { ...currentState };
    }
  }

  if (deltas.size === 0) return;

  // ── Phase 2: per-recipient interest management ───────────────────────────
  // Instead of broadcasting every moving player to EVERY connected client
  // (O(N^2) traffic), each recipient only receives deltas for players that
  // are actually close enough to be seen on their screen.
  const viewSq = VIEW_RANGE * VIEW_RANGE;
  for (const [recipientId, recipient] of players) {
    const sock = io.sockets.sockets.get(recipientId);
    if (!sock || !sock.connected) continue;

    const out = {};
    for (const [pid, delta] of deltas) {
      if (pid === recipientId) continue;
      const other = players.get(pid);
      if (!other) continue;

      const dx = other.x - recipient.x;
      const dz = other.z - recipient.z;
      if (dx * dx + dz * dz > viewSq) continue;

      out[pid] = delta;
    }

    if (Object.keys(out).length > 0) {
      sock.emit('world_state', out);
    }
  }
}, TICK_MS);

http.listen(PORT, () => {
  console.log(`Test server → http://localhost:${PORT}`);
});
