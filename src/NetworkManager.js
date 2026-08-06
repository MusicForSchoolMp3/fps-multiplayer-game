// ─── NetworkManager.js ────────────────────────────────────────────────────────
// Handles all socket.io communication, entity interpolation, and client prediction.

import { io } from 'socket.io-client';
import msgpackParser from 'socket.io-msgpack-parser';

const INTERP_DELAY = 100; // ms of interpolation buffer
const MOVE_INTERVAL = 1000 / 18; // 18Hz movement update rate (reduced from 20Hz)

export class NetworkManager {
  constructor(serverUrl, token, username) {
    this.socket    = io(serverUrl, { transports: ['websocket'], auth: { token, username }, parser: msgpackParser });
    this.localId   = null;
    this.connected = false;
    this.ping      = 0;

    // Snapshot buffer for each remote player: Map<id, Array<{t, snap}>>
    this._snapshots = new Map();
    
    // Full state cache for delta updates
    this._fullState = new Map();
    
    // Last sent snapshot for movement throttling
    this._lastSentSnapshot = null;

    // Callbacks (set by main)
    this.onInit        = null; // (id, players, colorIndex) => {}
    this.onPlayerJoin  = null; // (id, data) => {}
    this.onPlayerLeave = null; // (id) => {}
    this.onSnapshot    = null; // (id, snap) => {}
    this.onShot        = null; // (data) => {}
    this.onHit         = null; // (data) => {}
    this.onDied        = null; // (data) => {}
    this.onRespawn     = null; // (data) => {}
    this.onHealthSync  = null; // (id, health) => {}
    this.onChatMessage = null; // (data) => {}
    this.onPlayerWeaponChange = null; // (id, weapon) => {}
    this.onDuplicateLogin = null; // (message) => {}
    this.onAnticheatKick = null; // (data) => {}

    this._setupEvents();

    // Ping pong
    setInterval(() => {
      if (this.connected) {
        this._pingTime = performance.now();
        this.socket.emit('ping_req');
      }
    }, 2000);
  }

  _setupEvents() {
    this.socket.on('connect', () => {
      this.connected = true;
    });

    this.socket.on('disconnect', () => {
      this.connected = false;
    });

    this.socket.on('pong_res', () => {
      this.ping = Math.round(performance.now() - this._pingTime);
    });

    this.socket.on('init', (data) => {
      this.localId = data.id;
      if (this.onInit) this.onInit(data.id, data.players, data.colorIndex);
    });

    this.socket.on('player_join', (data) => {
      if (this.onPlayerJoin) this.onPlayerJoin(data.id, data);
    });

    this.socket.on('player_leave', (id) => {
      this._snapshots.delete(id);
      this._fullState.delete(id);
      if (this.onPlayerLeave) this.onPlayerLeave(id);
    });

    this.socket.on('world_state', (state) => {
      const now = performance.now();
      for (const [id, delta] of Object.entries(state)) {
        if (id === this.localId) continue;
        
        // Get or create full state for this player
        const fullState = this._fullState.get(id) || {
          x: 0, y: 0, z: 0,
          yaw: 0, pitch: 0,
          speed: 0, isGrounded: true,
          velocityY: 0,
          health: 100, isDead: false,
          username: '',
          currentWeapon: 'ar',
        };
        
        // Apply delta to full state
        if (delta.x !== undefined) fullState.x = delta.x;
        if (delta.y !== undefined) fullState.y = delta.y;
        if (delta.z !== undefined) fullState.z = delta.z;
        if (delta.yaw !== undefined) fullState.yaw = delta.yaw;
        if (delta.pitch !== undefined) fullState.pitch = delta.pitch;
        if (delta.speed !== undefined) fullState.speed = delta.speed;
        if (delta.isGrounded !== undefined) fullState.isGrounded = delta.isGrounded;
        if (delta.velocityY !== undefined) fullState.velocityY = delta.velocityY;
        if (delta.health !== undefined) fullState.health = delta.health;
        if (delta.isDead !== undefined) fullState.isDead = delta.isDead;
        if (delta.username !== undefined) fullState.username = delta.username;
        if (delta.currentWeapon !== undefined) fullState.currentWeapon = delta.currentWeapon;
        
        // Store updated full state
        this._fullState.set(id, { ...fullState });
        
        // Add to snapshot buffer for interpolation
        if (!this._snapshots.has(id)) this._snapshots.set(id, []);
        const buf = this._snapshots.get(id);
        buf.push({ t: now, snap: { ...fullState } });
        // keep buffer trimmed to ~30 entries
        while (buf.length > 30) buf.shift();
        if (this.onSnapshot) this.onSnapshot(id, { ...fullState });
      }
    });

    this.socket.on('player_shot', (data) => {
      if (this.onShot) this.onShot(data);
    });

    this.socket.on('player_hit', (data) => {
      if (this.onHit) this.onHit(data);
    });

    this.socket.on('player_died', (data) => {
      if (this.onDied) this.onDied(data);
    });

    this.socket.on('player_respawn', (data) => {
      if (this.onRespawn) this.onRespawn(data);
    });

    this.socket.on('health_update', (data) => {
      if (this.onHealthSync) this.onHealthSync(data.id, data.health);
    });

    this.socket.on('chat_message', (data) => {
      if (this.onChatMessage) this.onChatMessage(data);
    });

    this.socket.on('player_weapon_change', (data) => {
      if (this.onPlayerWeaponChange) this.onPlayerWeaponChange(data.id, data.weapon);
    });

    this.socket.on('duplicate_login', (data) => {
      if (this.onDuplicateLogin) this.onDuplicateLogin(data.message);
    });

    this.socket.on('anticheat_kick', (data) => {
      if (this.onAnticheatKick) this.onAnticheatKick(data);
    });
  }

  // ── Send local movement ────────────────────────────────────────────────────
  sendMove(snapshot) {
    // Only send if position or rotation has changed significantly
    if (!this._lastSentSnapshot) {
      this._lastSentSnapshot = snapshot;
      this.socket.emit('move', snapshot);
      return;
    }

    const threshold = 0.01; // 1cm threshold for position
    const angleThreshold = 0.001; // Small threshold for rotation
    
    const posChanged = 
      Math.abs(snapshot.x - this._lastSentSnapshot.x) > threshold ||
      Math.abs(snapshot.y - this._lastSentSnapshot.y) > threshold ||
      Math.abs(snapshot.z - this._lastSentSnapshot.z) > threshold;
    
    const rotChanged =
      Math.abs(snapshot.yaw - this._lastSentSnapshot.yaw) > angleThreshold ||
      Math.abs(snapshot.pitch - this._lastSentSnapshot.pitch) > angleThreshold;
    
    const stateChanged = snapshot.isGrounded !== this._lastSentSnapshot.isGrounded;

    if (posChanged || rotChanged || stateChanged) {
      this._lastSentSnapshot = snapshot;
      this.socket.emit('move', snapshot);
    }
  }

  // ── Send shoot event ───────────────────────────────────────────────────────
  sendShoot(data) {
    this.socket.emit('shoot', data);
  }

  // ── Interpolate a remote entity at current render time ─────────────────────
  // Returns interpolated snapshot or null if not enough data.
  getInterpolated(id) {
    const buf = this._snapshots.get(id);
    if (!buf || buf.length < 2) {
      return buf && buf.length === 1 ? buf[0].snap : null;
    }
    const renderTime = performance.now() - INTERP_DELAY;
    // Find surrounding samples
    let i = buf.length - 1;
    while (i > 0 && buf[i].t > renderTime) i--;
    const s0 = buf[i];
    const s1 = buf[Math.min(i + 1, buf.length - 1)];
    if (s0 === s1) return s0.snap;
    const dt = s1.t - s0.t;
    if (dt <= 0) return s1.snap;
    const alpha = Math.max(0, Math.min(1, (renderTime - s0.t) / dt));
    return lerpSnap(s0.snap, s1.snap, alpha);
  }
}

function lerpSnap(a, b, t) {
  return {
    x: lerp(a.x, b.x, t),
    y: lerp(a.y, b.y, t),
    z: lerp(a.z, b.z, t),
    yaw:   lerpAngle(a.yaw, b.yaw, t),
    pitch: lerp(a.pitch, b.pitch, t),
    speed: lerp(a.speed || 0, b.speed || 0, t),
    isGrounded: b.isGrounded,
  };
}

function lerp(a, b, t) { return a + (b - a) * t; }

function lerpAngle(a, b, t) {
  let diff = b - a;
  while (diff >  Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;
  return a + diff * t;
}
