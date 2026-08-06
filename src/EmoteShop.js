// ─── EmoteShop.js ────────────────────────────────────────────────────────────
// Main-menu emote shop. Lists every emote (locked/unlocked + kill requirement),
// unlocks using LIFETIME total kills (never deducted), and lets the player
// arrange any unlocked emote across the 10 wheel slots. Layout auto-saves.

import { EMOTE_WHEEL_SIZE, emoteEmoji } from './EmoteManager.js';

export class EmoteShop {
  constructor({ serverUrl, emoteManager, tokenProvider, getAccount, setAccount, onClose }) {
    this.serverUrl = serverUrl;
    this.emoteManager = emoteManager;
    this.tokenProvider = tokenProvider;      // () => string
    this.getAccount = getAccount;            // () => { totalKills, unlockedEmotes, equippedEmotes }
    this.setAccount = setAccount;            // (partial) => void
    this.onClose = onClose || (() => {});    // () => void (return to menu)

    this.selectedEmote = null;               // emote currently "held"
    this._build();
    this._bindKeys();
  }

  async open() {
    if (this.emoteManager.emotes.length === 0) {
      await this.emoteManager.loadManifest().catch(() => {});
    }
    this.selectedEmote = null;
    this._render();
    this._show();
  }

  close() {
    if (!this.isOpen) return;
    this._hide();
    this.onClose && this.onClose();
  }

  // ── Rendering ────────────────────────────────────────────────────────────
  _render() {
    const account = this.getAccount();
    const kills = account.totalKills || 0;
    const unlocked = account.unlockedEmotes || [];
    const equipped = account.equippedEmotes || Array(EMOTE_WHEEL_SIZE).fill(null);

    const killsEl = this._root.querySelector('.es-kills');
    if (killsEl) killsEl.textContent = kills.toLocaleString();

    // Wheel editor
    const wheel = this._root.querySelector('.es-wheel');
    if (wheel) {
      wheel.innerHTML = '';
      for (let i = 0; i < EMOTE_WHEEL_SIZE; i++) {
        const id = equipped[i] || null;
        const emote = id ? this.emoteManager.get(id) : null;
        const slot = document.createElement('div');
        slot.className = 'ew-slot edit' + (emote ? '' : ' empty') + (this.selectedEmote ? ' pickable' : '');

        const icon = document.createElement('div');
        icon.className = 'es-icon';
        icon.textContent = emote ? (emote.emoji || emoteEmoji(emote.id, i)) : '＋';

        const name = document.createElement('div');
        name.className = 'es-name';
        name.textContent = emote ? emote.name : 'EMPTY';

        const num = document.createElement('div');
        num.className = 'es-num';
        num.textContent = i + 1;

        slot.appendChild(icon);
        slot.appendChild(name);
        slot.appendChild(num);

        if (emote) {
          const rm = document.createElement('button');
          rm.className = 'es-remove';
          rm.textContent = '✕';
          rm.title = 'Remove from wheel';
          rm.addEventListener('click', (e) => {
            e.stopPropagation();
            this._updateSlot(i, null);
          });
          slot.appendChild(rm);
        }

        slot.addEventListener('click', (e) => {
          // Filled slot: pick it up (rearrange) or replace with selected.
          if (this.selectedEmote) {
            this._updateSlot(i, this.selectedEmote);
            return;
          }
          if (emote) {
            this.selectedEmote = emote.id; // pick up to move elsewhere
            this._render();
          }
        });

        wheel.appendChild(slot);
      }
    }

    // Emote list
    const list = this._root.querySelector('.es-list');
    if (list) {
      list.innerHTML = '';
      this.emoteManager.emotes.forEach((emote, idx) => {
        const owned = unlocked.includes(emote.id);
        const price = emote.price || 0;
        const canUnlock = !owned && kills >= price;
        const equippedIn = equipped.indexOf(emote.id);
        const isSelected = this.selectedEmote === emote.id;

        const card = document.createElement('div');
        card.className = 'es-card' + (owned ? ' owned' : '') + (isSelected ? ' selected' : '');

        const icon = document.createElement('div');
        icon.className = 'es-card-icon';
        icon.textContent = emote.emoji || emoteEmoji(emote.id, idx);

        const info = document.createElement('div');
        info.className = 'es-card-info';
        const name = document.createElement('div');
        name.className = 'es-card-name';
        name.textContent = emote.name;
        const meta = document.createElement('div');
        meta.className = 'es-card-meta';
        meta.textContent = owned
          ? (equippedIn >= 0 ? `EQUIPPED • Slot ${equippedIn + 1}` : 'UNLOCKED')
          : `${price.toLocaleString()} total kills`;
        info.appendChild(name);
        info.appendChild(meta);

        const action = document.createElement('button');
        action.className = 'es-card-action';
        if (owned) {
          action.textContent = 'EQUIP';
          action.disabled = false;
        } else {
          action.textContent = 'UNLOCK';
          action.disabled = !canUnlock;
        }

        card.appendChild(icon);
        card.appendChild(info);
        card.appendChild(action);

        // Click anywhere on an owned card selects it for wheel placement.
        card.addEventListener('click', (e) => {
          if (!owned) return;
          this.selectedEmote = this.selectedEmote === emote.id ? null : emote.id;
          this._render();
        });

        action.addEventListener('click', async (e) => {
          e.stopPropagation();
          if (owned) {
            this.selectedEmote = this.selectedEmote === emote.id ? null : emote.id;
            this._render();
          } else {
            await this._unlock(emote.id);
          }
        });

        list.appendChild(card);
      });
    }
  }

  _updateSlot(index, emoteId) {
    const equipped = (this.getAccount().equippedEmotes || Array(EMOTE_WHEEL_SIZE).fill(null)).slice();
    equipped[index] = emoteId;
    this.selectedEmote = null;
    this._saveLayout(equipped);
  }

  // ── Server actions ───────────────────────────────────────────────────────
  async _unlock(emoteId) {
    try {
      const res = await fetch(`${this.serverUrl}/api/emotes/unlock`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.tokenProvider()}`
        },
        body: JSON.stringify({ emoteId })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Unlock failed');
      this.setAccount({ unlockedEmotes: data.unlockedEmotes });
      this._render();
    } catch (err) {
      console.error('Unlock emote error:', err);
      alert('Could not unlock emote: ' + err.message);
    }
  }

  async _saveLayout(equippedEmotes) {
    // Optimistic local update first (wheel feels instant).
    this.setAccount({ equippedEmotes });
    this._render();

    try {
      const res = await fetch(`${this.serverUrl}/api/emotes/equip`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.tokenProvider()}`
        },
        body: JSON.stringify({ equippedEmotes })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Save failed');
      // Server may have sanitized the layout - adopt its authoritative copy.
      this.setAccount({ equippedEmotes: data.equippedEmotes });
      this._render();
    } catch (err) {
      console.error('Save layout error:', err);
    }
  }

  // ── DOM ──────────────────────────────────────────────────────────────────
  _build() {
    const root = document.createElement('div');
    root.id = 'emote-shop';
    root.className = 'emote-shop';
    root.style.display = 'none';
    root.innerHTML = `
      <div class="es-backdrop"></div>
      <div class="es-panel">
        <div class="es-header">
          <div class="es-title">💃 EMOTE SHOP</div>
          <button class="es-close" title="Close">✕</button>
        </div>
        <div class="es-stats">
          <span class="es-stats-label">LIFETIME KILLS</span>
          <span class="es-kills">0</span>
          <span class="es-stats-note">Kills are never spent - they're a lifetime requirement.</span>
        </div>
        <div class="es-wheel-block">
          <div class="es-block-title">YOUR WHEEL</div>
          <div class="es-wheel"></div>
          <div class="es-wheel-hint">Select an emote below, then click a wheel slot to place it. Click a filled slot to move it, ✕ to remove.</div>
        </div>
        <div class="es-block-title es-list-title">ALL EMOTES</div>
        <div class="es-list"></div>
      </div>
    `;
    root.querySelector('.es-close').addEventListener('click', () => this.close());
    root.querySelector('.es-backdrop').addEventListener('click', () => this.close());
    document.body.appendChild(root);
    this._root = root;
  }

  _bindKeys() {
    document.addEventListener('keydown', (e) => {
      if (e.code === 'Escape' && this._root && this._root.style.display !== 'none') {
        this.close();
      }
    });
  }

  _show() { if (this._root) this._root.style.display = 'flex'; }
  _hide() { if (this._root) this._root.style.display = 'none'; }

  get isOpen() { return this._root && this._root.style.display !== 'none'; }
}