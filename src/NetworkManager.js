// ─── NetworkManager.js ────────────────────────────────────────────────────────
// Handles all socket.io communication, entity interpolation, and client prediction.

import { io } from 'socket.io-client';
import msgpackParser from 'socket.io-msgpack-parser';
import { IntegrityGuard, computeIntegrityAnswer } from './IntegrityGuard.js';

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
    this.onPlayerEmote = null; // (id, emoteId) => {}
    this.onPlayerEmoteStop = null; // (id) => {}
    this.onDuplicateLogin = null; // (message) => {}
    this.onAnticheatKick = null; // (data) => {}
    this.onAmmoUpdate = null; // (data) => { weapon, ammo } - server-authoritative magazine
    this.onLeaderboardUpdate = null; // (standings) => {}

    this._setupEvents();

    // Tamper/devtools reporting: best-effort early warning to the server. The
    // server makes the final call (it also verifies every challenge answer and
    // times out silent clients), so a disabled/suppressed guard changes nothing
    // from the player's perspective — they just lose the ability to be heard.
    this._integrity = new IntegrityGuard((hits) => {
      if (this.socket && this.socket.connected) {
        this.socket.emit('integrity_report', { type: 'tampering', detail: hits });
      }
    });

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
      if (this._integrity) this._integrity.start();
    });

    this.socket.on('disconnect', () => {
      this.connected = false;
      if (this._integrity) this._integrity.stop();
    });

    // Server-authoritative integrity challenge: must be answered with the exact
    // deterministic hash or the server kicks + strikes the account.
    this.socket.on('integrity_challenge', (data) => {
      const nonce = data && data.nonce;
      if (!nonce) return;
      const t = Number(data.t) || Date.now();
      this.socket.emit('integrity_answer', {
        nonce,
        t,
        answer: computeIntegrityAnswer(nonce, t),
      });
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
          px: 0, py: 0, pz: 0,
          ry: 0, rp: 0,
          gait: 0, docked: true,
          ascend: 0,
          health: 100, isDead: false,
          username: '',
          currentWeapon: 'ar',
        };
        
        // Apply delta to full state
        if (delta.px !== undefined) fullState.px = delta.px;
        if (delta.py !== undefined) fullState.py = delta.py;
        if (delta.pz !== undefined) fullState.pz = delta.pz;
        if (delta.ry !== undefined) fullState.ry = delta.ry;
        if (delta.rp !== undefined) fullState.rp = delta.rp;
        if (delta.gait !== undefined) fullState.gait = delta.gait;
        if (delta.docked !== undefined) fullState.docked = delta.docked;
        if (delta.ascend !== undefined) fullState.ascend = delta.ascend;
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

    // Server-authoritative magazine count. Editing weapon.ammo in devtools is
    // cosmetic: the HUD gets corrected to the server's count after every shot,
    // reload and weapon switch.
    this.socket.on('ammo_update', (data) => {
      if (this.onAmmoUpdate) this.onAmmoUpdate(data);
    });

    this.socket.on('chat_message', (data) => {
      if (this.onChatMessage) this.onChatMessage(data);
    });

    this.socket.on('player_weapon_change', (data) => {
      if (this.onPlayerWeaponChange) this.onPlayerWeaponChange(data.id, data.weapon);
    });

    this.socket.on('player_emote', (data) => {
      if (this.onPlayerEmote) this.onPlayerEmote(data.id, data.emoteId);
    });

    this.socket.on('player_emote_stop', (data) => {
      if (this.onPlayerEmoteStop) this.onPlayerEmoteStop(data.id);
    });

    this.socket.on('duplicate_login', (data) => {
      if (this.onDuplicateLogin) this.onDuplicateLogin(data.message);
    });

    this.socket.on('anticheat_kick', (data) => {
      if (this.onAnticheatKick) this.onAnticheatKick(data);
    });

    this.socket.on('leaderboard_update', (standings) => {
      if (this.onLeaderboardUpdate) this.onLeaderboardUpdate(standings);
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
      Math.abs(snapshot.px - this._lastSentSnapshot.px) > threshold ||
      Math.abs(snapshot.py - this._lastSentSnapshot.py) > threshold ||
      Math.abs(snapshot.pz - this._lastSentSnapshot.pz) > threshold;
    
    const rotChanged =
      Math.abs(snapshot.ry - this._lastSentSnapshot.ry) > angleThreshold ||
      Math.abs(snapshot.rp - this._lastSentSnapshot.rp) > angleThreshold;
    
    const stateChanged = snapshot.docked !== this._lastSentSnapshot.docked;

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
    px: lerp(a.px, b.px, t),
    py: lerp(a.py, b.py, t),
    pz: lerp(a.pz, b.pz, t),
    ry:   lerpAngle(a.ry, b.ry, t),
    rp: lerp(a.rp, b.rp, t),
    gait: lerp(a.gait || 0, b.gait || 0, t),
    docked: b.docked,
  };
}

function lerp(a, b, t) { return a + (b - a) * t; }

function lerpAngle(a, b, t) {
  let diff = b - a;
  while (diff >  Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;
  return a + diff * t;
}
