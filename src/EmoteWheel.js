// ─── EmoteWheel.js ───────────────────────────────────────────────────────────
// Radial emote wheel opened with the "." key. Exactly 10 slots in a circle.
// Hover highlights a slot, releasing the mouse over a filled slot plays it,
// releasing over empty space closes without playing.

import { EMOTE_WHEEL_SIZE, emoteEmoji } from './EmoteManager.js';

export class EmoteWheel {
  constructor({ emoteManager, getEquipped, onSelect, onClose, isAlive }) {
    this.emoteManager = emoteManager;
    this.getEquipped = getEquipped; // () => [10] of id|null
    this.onSelect = onSelect;       // (emoteId|null) => void
    this.onClose = onClose;         // () => void (re-lock pointer etc.)
    this.isAlive = isAlive;         // () => bool

    this.open = false;
    this._slots = [];
    this._build();
    this._bindKeys();
  }

  toggle() {
    if (this.open) this.close(null);
    else this.openWheel();
  }

  async openWheel() {
    if (this.open) return;
    if (this.isAlive && !this.isAlive()) return;
    this.open = true;

    // Exit pointer lock so the mouse can hover the UI.
    if (document.pointerLockElement) document.exitPointerLock();

    // Make sure we have the manifest before rendering.
    if (this.emoteManager.emotes.length === 0) {
      await this.emoteManager.loadManifest().catch(() => {});
    }

    this._render();
    this._show();
  }

  close(selectId) {
    if (!this.open) return;
    this.open = false;
    this._hide();
    this.onClose && this.onClose();
    if (selectId) this.onSelect && this.onSelect(selectId);
  }

  // Toggle rebuilt each open so the layout reflects the latest equipped wheel.
  _render() {
    const equipped = this.getEquipped ? this.getEquipped() : [];
    this._slots.forEach((slot, i) => {
      const id = equipped[i] || null;
      const emote = id ? this.emoteManager.get(id) : null;
      slot.dataset.emoteId = id || '';
      slot.classList.toggle('empty', !emote);

      const icon = slot.querySelector('.es-icon');
      const name = slot.querySelector('.es-name');
      if (emote) {
        icon.textContent = emote.emoji || emoteEmoji(emote.id, i);
        name.textContent = emote.name || id;
      } else {
        icon.textContent = '＋';
        name.textContent = 'EMPTY';
      }
    });
  }

  _build() {
    const root = document.createElement('div');
    root.id = 'emote-wheel';
    root.className = 'emote-wheel';
    root.style.display = 'none';

    const bg = document.createElement('div');
    bg.className = 'ew-bg';

    const ring = document.createElement('div');
    ring.className = 'ew-ring';

    const center = document.createElement('div');
    center.className = 'ew-center';
    center.innerHTML = '<div class="ew-center-title">EMOTES</div><div class="ew-center-hint">Release on a slot to play • Esc to close</div>';
    ring.appendChild(center);

    for (let i = 0; i < EMOTE_WHEEL_SIZE; i++) {
      const slot = document.createElement('div');
      slot.className = 'ew-slot';
      slot.dataset.index = i;
      slot.innerHTML = '<div class="es-icon"></div><div class="es-name"></div>';
      slot.addEventListener('pointerdown', (e) => e.stopPropagation());
      slot.addEventListener('pointerup', () => {
        if (this.open) this.close(slot.dataset.emoteId || null);
      });
      ring.appendChild(slot);
      this._slots.push(slot);
    }

    // Background release closes without playing anything.
    bg.addEventListener('pointerup', () => { if (this.open) this.close(null); });

    root.appendChild(bg);
    root.appendChild(ring);
    document.body.appendChild(root);

    // Position the slots radially (JS computes angles; CSS fully styled).
    const place = () => {
      const r = Math.min(window.innerWidth, window.innerHeight) * 0.28;
      this._slots.forEach((slot, i) => {
        const a = (i / EMOTE_WHEEL_SIZE) * Math.PI * 2 - Math.PI / 2;
        const x = Math.cos(a) * r;
        const y = Math.sin(a) * r;
        slot.style.setProperty('--x', `${x.toFixed(1)}px`);
        slot.style.setProperty('--y', `${y.toFixed(1)}px`);
      });
    };
    place();
    window.addEventListener('resize', place);
    this._root = root;
  }

  _show() {
    if (!this._root) return;
    this._root.style.display = 'block';
    this._root.classList.add('open');
  }

  _hide() {
    if (!this._root) return;
    this._root.classList.remove('open');
    this._root.style.display = 'none';
  }

  _bindKeys() {
    document.addEventListener('keydown', (e) => {
      if (!this.open) return;
      if (e.code === 'Escape') {
        e.preventDefault();
        e.stopImmediatePropagation(); // don't also open the settings menu
        this.close(null);
      }
    });
  }
}