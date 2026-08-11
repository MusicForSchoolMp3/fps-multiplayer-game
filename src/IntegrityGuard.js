// ─── IntegrityGuard.js ─────────────────────────────────────────────────────────
// Client side of the server-authoritative integrity protocol.
//
// IMPORTANT: this module is NOT the anti-cheat. All enforcement lives on the
// server (server/index.js). This module exists to (1) answer the server's
// integrity challenges and (2) give the server an early warning when developer
// tools / obvious code tampering is detected. A modified client can always
// suppress these warnings — that is exactly why the server ALSO verifies every
// answer and times out non-responding clients with a kick + strike, and why
// movement/teleport/skin/shop logic is validated server-side.

import * as THREE from 'three';
import { PlayerController } from './PlayerController.js';
import { WeaponSystem } from './WeaponSystem.js';

// MUST match server/index.js computeIntegrityAnswer.
const INTEGRITY_SALT = 'fps-game-int3gr1ty-v1-xk91';
const INTEGRITY_BUCKET_MS = 5000;

export function computeIntegrityAnswer(nonce, t) {
  const s = `${INTEGRITY_SALT}|${nonce}|${Math.floor(Number(t) / INTEGRITY_BUCKET_MS)}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `${(h >>> 0).toString(16)}-${(h >>> 13).toString(16)}-${s.length.toString(16)}`;
}

export class IntegrityGuard {
  constructor(reportFn) {
    this._report = reportFn || (() => {});
    this._interval = null;
    this._reported = false;

    // Function references captured at construction and compared every tick so
    // devtools overrides of the core gameplay/collision code are caught (e.g.
    // hijacking the gun's raycast, spoofing position snapshots).
    this._refs = [];
    try {
      this._refs.push({
        label: 'raycaster.intersectObjects',
        get: () => THREE.Raycaster.prototype.intersectObjects,
      });
      this._refs.push({
        label: 'player.getSnapshot',
        get: () => PlayerController.prototype.getSnapshot,
      });
      this._refs.push({
        label: 'player.update',
        get: () => PlayerController.prototype.update,
      });
      this._refs.push({
        label: 'weapon._shoot',
        get: () => WeaponSystem.prototype._shoot,
      });
    } catch (e) {
      // Modules not fully loaded yet — the first check will retry later.
    }
    this._refs.forEach(r => { r.orig = r.get(); });
  }

  start() {
    if (this._interval) return;
    this._interval = setInterval(() => this._tick(), 3000);
    setTimeout(() => this._tick(), 750);
  }

  stop() {
    if (this._interval) clearInterval(this._interval);
    this._interval = null;
  }

  _tick() {
    const hits = this._detect();
    if (hits.length > 0) {
      this._report(hits);
    }
  }

  _detect() {
    const hits = [];

    // 1. Debugger/timing trap: with devtools open (pause-on-debugger is on by
    //    default), executing a `debugger` statement halts JS long enough to
    //    measure. Overriding this method itself is caught by the server, which
    //    never receives valid answers.
    const t0 = performance.now();
    try { (() => { debugger; })(); } catch (e) { /* swallowed */ }
    if (performance.now() - t0 > 120) hits.push('debugger-pause');

    // 2. Detached devtools window heuristic (opened in its own window).
    const w = window.outerWidth - window.innerWidth;
    const h = window.outerHeight - window.innerHeight;
    if (w > 220 || h > 250) hits.push('detached-window');

    // 3. Core function overrides (raycast hijacking, position spoofing,
    //    movement hacks). If anyone redefines these in devtools the captured
    //    references no longer match.
    for (const r of this._refs) {
      try {
        if (r.get() !== r.orig) hits.push(r.label);
      } catch (e) { /* module not ready */ }
    }

    return hits;
  }
}
