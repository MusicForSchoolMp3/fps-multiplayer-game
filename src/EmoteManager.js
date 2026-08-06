// ─── EmoteManager.js ─────────────────────────────────────────────────────────
// Central emote system: fetches the manifest from the server, streams each
// emote GLB's animation clip into the shared registry, and handles local
// start/stop with bandwidth-efficient multiplayer events (start/stop/emoteId
// only - no per-frame animation streaming).

import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { registerEmoteClip, hasEmoteClip } from './AvatarManager.js';

const WHEEL_SIZE = 10;
const MOVE_CANCEL_SPEED = 0.1; // horizontal speed below which we count as "standing"

// Sorted by price-first appears first; palette is a stable visual fallback icon
const EMOJI_PALETTE = ['💃', '🕺', '🤸', '🎉', '🙌', '🏃', '💪', '🎪', '🎬', '🥳', '🕶️', '🤖', '🔥', '⭐', '🏆', '💫'];

export function emoteEmoji(id, index = 0) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return EMOJI_PALETTE[h % EMOJI_PALETTE.length];
}

export class EmoteManager {
  constructor(serverUrl, net, getContext) {
    this.serverUrl = serverUrl;
    this.net = net;
    // getContext() => { animState, controller, isDead: () => bool }
    this.getContext = getContext;

    this.emotes = [];          // manifest [{id,name,price,url,file}]
    this.emotesById = new Map();
    this._loading = new Map(); // id -> Promise (dedupe concurrent loads)
    this._manifestPromise = null;

    this.activeEmote = null;
    this.onManifestLoaded = null; // (emotes) => void
  }

  // ── Manifest ──────────────────────────────────────────────────────────────
  loadManifest() {
    if (this._manifestPromise) return this._manifestPromise;
    this._manifestPromise = (async () => {
      const res = await fetch(`${this.serverUrl}/api/emotes`);
      if (!res.ok) throw new Error(`Failed to fetch emote manifest (${res.status})`);
      const data = await res.json();
      this.emotes = Array.isArray(data.emotes) ? data.emotes : [];
      // Decorate with a stable emoji per emote
      this.emotes = this.emotes.map((e, i) => ({ ...e, emoji: emojiForEmote(e, i) }));
      this.emotesById = new Map(this.emotes.map(e => [e.id, e]));
      if (this.onManifestLoaded) this.onManifestLoaded(this.emotes);
      return this.emotes;
    })();
    return this._manifestPromise;
  }

  get(id) { return this.emotesById.get(id); }

  // Stream/register a single emote animation. Returns a promise resolving with
  // the clip's name (id) or null on failure. Cached + deduped.
  preload(id) {
    if (hasEmoteClip(id)) return Promise.resolve(id);
    if (this._loading.has(id)) return this._loading.get(id);
    const emote = this.emotesById.get(id);
    if (!emote) return Promise.resolve(null);

    const p = new Promise((resolve) => {
      const loader = new GLTFLoader();
      loader.load(
        emote.url,
        (gltf) => {
          const clip = gltf.animations && gltf.animations[0];
          registerEmoteClip(id, clip);
          this._loading.delete(id);
          resolve(clip ? id : null);
        },
        undefined,
        (err) => {
          console.warn(`Failed to load emote ${id}:`, err);
          this._loading.delete(id);
          resolve(null);
        }
      );
    });
    this._loading.set(id, p);
    return p;
  }

  // Preload every emote currently on the player's wheel.
  preloadWheel(equipped) {
    const ids = (equipped || []).filter(Boolean).slice(0, WHEEL_SIZE);
    return Promise.all(ids.map(id => this.preload(id)));
  }

  // ── Standing-still gate ──────────────────────────────────────────────────
  isStandingStill() {
    const ctx = this.getContext && this.getContext();
    const c = ctx && ctx.controller;
    if (!c) return true;
    const hSpeed = Math.sqrt(c.velocity.x ** 2 + c.velocity.z ** 2);
    return c.isGrounded && hSpeed <= MOVE_CANCEL_SPEED;
  }

  // ── Local playback ───────────────────────────────────────────────────────
  start(id) {
    const ctx = this.getContext && this.getContext();
    if (ctx && ctx.isDead && ctx.isDead()) return false;
    if (!this.emotesById.has(id)) return false;
    if (!this.isStandingStill()) return false; // emotes only while standing still

    if (this.activeEmote && this.activeEmote !== id) this.stop();

    this.activeEmote = id;
    if (ctx && ctx.animState) ctx.animState.emote = id;

    // Stream the clip; if it lands after we already moved on, ignore it.
    this.preload(id).then(() => {
      if (this.activeEmote === id && ctx && ctx.animState && !ctx.animState.emote) {
        ctx.animState.emote = id;
      }
    });

    // Network: only the start signal (id). No per-frame streaming.
    if (this.net && this.net.socket) this.net.socket.emit('emote_start', { emoteId: id });
    return true;
  }

  // Stop the local emote and notify peers. Called on movement/death/manual.
  stop() {
    if (!this.activeEmote) return false;
    this.activeEmote = null;
    const ctx = this.getContext && this.getContext();
    if (ctx && ctx.animState) ctx.animState.emote = null;
    if (this.net && this.net.socket) this.net.socket.emit('emote_stop');
    return true;
  }

  // Called every frame: instantly cancel the emote the moment the player moves.
  update() {
    if (!this.activeEmote) return;
    const ctx = this.getContext && this.getContext();
    if ((ctx && ctx.isDead && ctx.isDead()) || !this.isStandingStill()) {
      this.stop();
    }
  }
}

// stable emoji chosen by manifest order then by id hash
function emojiFor(e, i) {
  const seed = i * 7 + e.id.length;
  return EMOJI_PALETTE[seed % EMOJI_PALETTE.length];
}

export const EMOTE_WHEEL_SIZE = WHEEL_SIZE;