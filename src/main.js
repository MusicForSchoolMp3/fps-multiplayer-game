// ─── main.js ──────────────────────────────────────────────────────────────────
// Main game client. Auth-gated: shows login/register until session verified.
// Features: real-time 3D FPS, third-person toggle (V), username labels.

import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { PlayerController }        from './PlayerController.js';
import { NetworkManager }          from './NetworkManager.js';
import { WeaponSystem }            from './WeaponSystem.js';
import { EmoteManager }            from './EmoteManager.js';
import { EmoteWheel }              from './EmoteWheel.js';
import { EmoteShop }               from './EmoteShop.js';
import {
  buildHumanoid,
  buildFPHands,
  animateAvatar,
  createUsernameLabel,
  setWeaponType,
  updateWeaponSkin,
  createRankBadge,
} from './AvatarManager.js';
import {
  MenuAvatarPreview,
  SkinPreviewer,
  SKINS_CONFIG,
  getEquippedSkin,
  setEquippedSkin,
  hasSkinAccess,
  getAccessibleSkins,
} from './SkinManager.js';
import './style.css';
import {
  auth,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  onAuthStateChanged,
  firebaseSignOut
} from './firebase-config.js';

// ── Constants ──────────────────────────────────────────────────────────────────
// Production: the frontend and backend are served from the SAME origin (Express
// serves the built frontend on the VM), so the browser automatically talks to
// whatever host served the page — no hardcoded server URL.
// Development: the Vite dev server runs on a different port, so override it
// with VITE_SERVER_URL (e.g. http://localhost:3001) in your local .env.
const SERVER_URL = import.meta.env.VITE_SERVER_URL || window.location.origin;
const TICK_RATE   = 18; // Reduced from 20 to 18 for bandwidth optimization
const EYE_HEIGHT  = 1.65;

// ── Update Log ─────────────────────────────────────────────────────────────────
const UPDATE_LOG = [
  {
    date: '2026-08-05',
    items: [
      'COMING SOON: Brand new map, ranks, more weapons, and both character and weapon skins',
      'Added monthly/global leaderboard (total kills)',
      'Added unlockable emotes',
      'Added emote wheel',
      'Added anticheat',
      'Fixed weapon switching ammo persistence to prevent abuse',
      {
        text: 'Note to Users: The current false banning issue has been resolved.',
        bold: true
      }
    ]
  }
];

function renderUpdateLog(containerId) {
  const container = document.getElementById(containerId);
  if (!container) return;

  let html = '';
  for (const entry of UPDATE_LOG) {
    html += `<div class="update-entry">
      <div class="update-date">${entry.date}</div>`;
    for (const item of entry.items) {
      const itemText = typeof item === 'string' ? item : item.text;
      const isBold = typeof item === 'object' && item.bold;
      const textStyle = isBold ? 'font-weight: bold; color: #ff4444;' : '';
      html += `<div class="update-item">
        <span class="update-bullet">•</span>
        <span style="${textStyle}">${itemText}</span>
      </div>`;
    }
    html += `</div>`;
  }
  container.innerHTML = html;
}

// ── DOM refs ───────────────────────────────────────────────────────────────────
const canvas          = document.getElementById('game-canvas');
const authScreen      = document.getElementById('auth-screen');
const lockScreen      = document.getElementById('lock-screen');
const deathOverlay    = document.getElementById('death-overlay');
const respawnCount    = document.getElementById('respawn-count');
const healthBar       = document.getElementById('health-bar');
const healthText      = document.getElementById('health-text');
const killFeed        = document.getElementById('kill-feed');
const hitmarkerEl     = document.getElementById('hitmarker');
const damageVignette  = document.getElementById('damage-vignette');
const statusDot       = document.getElementById('status-dot');
const statusText      = document.getElementById('status-text');
const pingDisplay     = document.getElementById('ping-display');
const scoreboard      = document.getElementById('scoreboard');
const sbList          = document.getElementById('scoreboard-list');
const ammoEl          = document.getElementById('ammo-current');
const reserveEl       = document.getElementById('ammo-reserve');
const reloadEl        = document.getElementById('reload-indicator');
const viewIndicator   = document.getElementById('view-indicator');

// ─── Account Menu & Settings refs ─────────────────────────────────────────────
const accountMenu        = document.getElementById('account-menu');
const menuUsername       = document.getElementById('menu-username');
const menuTotalKills     = document.getElementById('menu-total-kills');
const menuPlayBtn        = document.getElementById('menu-play-btn');
const menuGunsBtn        = document.getElementById('menu-guns-btn');
const menuSettingsBtn    = document.getElementById('menu-settings-btn');
const menuSignoutBtn     = document.getElementById('menu-signout-btn');

const settingsModal      = document.getElementById('settings-modal');
const settingHeadBob     = document.getElementById('setting-head-bob');
const settingsResumeBtn  = document.getElementById('settings-resume-btn');
const settingsCloseBtn   = document.getElementById('settings-close-btn');
const settingsSignoutBtn = document.getElementById('settings-signout-btn');

// ─── Leaderboard refs ──────────────────────────────────────────────────────────
const leaderboardModal   = document.getElementById('leaderboard-modal');
const leaderboardList    = document.getElementById('leaderboard-list');
const leaderboardMeta    = document.getElementById('leaderboard-meta');
const libTabGlobal       = document.getElementById('lib-tab-global');
const libTabMonthly      = document.getElementById('lib-tab-monthly');
let leaderboardTab       = 'global';
let leaderboardTimer     = null; // polling interval while the modal is open

// ─── Auth UI refs ──────────────────────────────────────────────────────────────
const tabLogin        = document.getElementById('tab-login');
const tabRegister     = document.getElementById('tab-register');
const loginPanel      = document.getElementById('login-panel');
const registerPanel   = document.getElementById('register-panel');
const loginUsername   = document.getElementById('login-username');
const loginPassword   = document.getElementById('login-password');
const loginError      = document.getElementById('login-error');
const loginBtn        = document.getElementById('login-btn');
const regUsername     = document.getElementById('reg-username');
const regPassword     = document.getElementById('reg-password');
const regConfirm      = document.getElementById('reg-confirm');
const regError        = document.getElementById('reg-error');
const registerBtn     = document.getElementById('register-btn');

// ── Auth state ─────────────────────────────────────────────────────────────────
let sessionToken      = null;
let sessionUsername   = null;
let sessionTotalKills = 0;
let ownedSkins        = ['ar_default', 'sniper_midnight']; // Default skins
let unlockedEmotes    = []; // Emotes owned by this account
let equippedEmotes    = Array(10).fill(null); // 10-slot wheel layout
let isGameStarted     = false;
let openingMenu       = false; // Flag to prevent lock screen from showing when opening menu

// ── Game objects (lazy-initialized after auth) ─────────────────────────────────
let renderer, scene, camera, clock;
let controller, net, weapon;
let emoteManager, emoteWheel, emoteShop;
let fpHandsGroup;
let fpHandsAnimator;
let fpHandsRoot;
let localBodyAvatar   = null; // full body for third-person view
let localAnimState    = { time: 0, speed: 0, isGrounded: true, pitch: 0, velocityY: 0 };
let isThirdPerson     = false;
let emotePovOverride  = null; // POV saved while an emote forces third-person view
let isDead            = false;
let localHealth       = 100;
let localColorIdx     = 0;
let localUsername     = '';
const scores          = new Map();
const remotePlayers   = new Map(); // id → { root, joints, animState, label, hitbox, username }
const _remoteTracers  = [];
let lbRanks           = new Map(); // username(lower) → global leaderboard rank
let inGameRankTimer   = null;      // interval that refreshes in-game rank badges
let _lastMoveSent     = 0;
const MOVE_INTERVAL   = 1000 / TICK_RATE;
let _lastSentState    = null; // Track last sent state for delta compression

// ══════════════════════════════════════════════════════════════════════════════
//  AUTH
// ══════════════════════════════════════════════════════════════════════════════

async function bootstrap() {
  setupAuthUI();
  setupMenuButtons();
  // Always try to check session with JWT token
  const ok = await checkSession();
  if (ok) {
    hideAuth();
    showAccountMenu();
  }
  initEmoteSystem();
}

// ══════════════════════════════════════════════════════════════════════════════
//  EMOTE SYSTEM  (created once after auth; works from the menu and in-game)
// ══════════════════════════════════════════════════════════════════════════════

function initEmoteSystem() {
  if (emoteManager) return;

  emoteManager = new EmoteManager(SERVER_URL, null, () => ({
    animState: localAnimState,
    controller,
    isDead: () => isDead,
  }));

  emoteWheel = new EmoteWheel({
    emoteManager,
    getEquipped: () => equippedEmotes,
    onSelect: (emoteId) => { if (emoteId) emoteManager.start(emoteId); },
    onClose: () => {
      // Re-lock pointer after the wheel closes so the player returns to gameplay.
      if (!isDead && controller) controller.lock();
    },
    isAlive: () => !isDead,
  });

  emoteShop = new EmoteShop({
    serverUrl: SERVER_URL,
    emoteManager,
    tokenProvider: () => sessionToken,
    getAccount: () => ({ totalKills: sessionTotalKills, unlockedEmotes, equippedEmotes }),
    setAccount: (partial) => {
      if (partial.totalKills !== undefined) sessionTotalKills = partial.totalKills;
      if (Array.isArray(partial.unlockedEmotes)) unlockedEmotes = partial.unlockedEmotes;
      if (Array.isArray(partial.equippedEmotes)) equippedEmotes = partial.equippedEmotes;
      if (emoteManager) emoteManager.preloadWheel(equippedEmotes);
    },
    onClose: () => {
      // Return to the account menu.
      if (isGameStarted) lockScreen.style.display = 'flex';
      else accountMenu.style.display = 'flex';
    },
  });
}

function openEmoteShop() {
  if (!emoteShop) return;
  accountMenu.style.display = 'none';
  lockScreen.style.display = 'none';
  settingsModal.style.display = 'none';
  emoteShop.open();
}

// ══════════════════════════════════════════════════════════════════════════════
//  LEADERBOARD  (global + monthly kills, polled in real time while open)
// ══════════════════════════════════════════════════════════════════════════════

function openLeaderboard() {
  accountMenu.style.display = 'none';
  lockScreen.style.display = 'none';
  settingsModal.style.display = 'none';
  if (leaderboardModal) leaderboardModal.style.display = 'flex';
  refreshLeaderboard();
  // Live update while open.
  if (leaderboardTimer === null) leaderboardTimer = setInterval(refreshLeaderboard, 5000);
}

function closeLeaderboard() {
  if (leaderboardTimer !== null) { clearInterval(leaderboardTimer); leaderboardTimer = null; }
  if (leaderboardModal) leaderboardModal.style.display = 'none';
  if (!isGameStarted) accountMenu.style.display = 'flex';
}

async function refreshLeaderboard() {
  if (!leaderboardList) return;
  try {
    const res = await fetch(`${SERVER_URL}/api/leaderboard?type=${leaderboardTab}&limit=100`, { cache: 'no-store' });
    if (!res.ok) throw new Error('Leaderboard request failed');
    const data = await res.json();
    renderLeaderboard(data);
  } catch (err) {
    leaderboardList.innerHTML = '<div class="lib-empty">Could not load leaderboard.</div>';
  }
}

function formatMonthLabel(monthKey) {
  if (!monthKey) return '';
  const [y, m] = monthKey.split('-').map(Number);
  const names = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${names[m - 1]} ${y}`;
}

function renderLeaderboard(data) {
  const type = data.type || leaderboardTab;
  const entries = Array.isArray(data.entries) ? data.entries : [];
  const metaPrefix = type === 'monthly'
    ? (data.month ? `${formatMonthLabel(data.month)} ` : '') + 'Top players '
    : 'All-time ';

  if (leaderboardMeta) {
    leaderboardMeta.textContent = entries.length
      ? `${metaPrefix}by kills`
      : 'No entries yet this month.';
  }

  if (!entries.length) {
    leaderboardList.innerHTML = '<div class="rank-empty">No players on the board yet.</div>';
    return;
  }

  leaderboardList.innerHTML = entries.map((e) => {
    const isMe = sessionUsername && e.username.toLowerCase() === sessionUsername.toLowerCase();
    const medal = e.rank === 1 ? '🥇' : e.rank === 2 ? '🥈' : e.rank === 3 ? '🥉' : e.rank;
    return `
      <div class="rank-row${isMe ? ' me' : ''}">
        <div class="rank-medal">${medal}</div>
        <div class="rank-name">${escapeHtml(e.username)}${isMe ? ' <span class="rank-you">(you)</span>' : ''}</div>
        <div class="rank-kills">${e.kills.toLocaleString()}</div>
      </div>`;
  }).join('');
}

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

// ══════════════════════════════════════════════════════════════════════════════
//  IN-GAME RANK BADGES  (top 3 leaderboard players get #1/#2/#3 above their head)
// ══════════════════════════════════════════════════════════════════════════════

// Apply the live rank medal to a username entry (remote player or local body).
// `entry` exposes `medal` and either `username` or `lookupName`.
function applyRankBadge(entry) {
  if (!entry || !entry.medal) return;
  const key = String(entry.lookupUsername != null ? entry.lookupUsername : entry.username).toLowerCase();
  entry.medal.setRank(lbRanks.get(key) || 0);
}

async function refreshInGameRanks() {
  try {
    const res = await fetch(`${SERVER_URL}/api/leaderboard?type=global&limit=100`, { cache: 'no-store' });
    if (!res.ok) return;
    const data = await res.json();
    const next = new Map();
    for (const e of (data.entries || [])) next.set(e.username.toLowerCase(), e.rank);
    lbRanks = next;
    // Refresh rank medals on every connected remote player.
    for (const rp of remotePlayers.values()) applyRankBadge(rp);
    // And on the local player's own body (third-person view).
    applyRankBadge(localBodyAvatar);
  } catch (err) { /* ignore transient network errors */ }
}

async function checkSession() {
  // Check for JWT token in localStorage
  const token = localStorage.getItem('jwt_token');
  if (!token) return false;

  try {
    const res = await fetch(`${SERVER_URL}/api/me`, {
      headers: {
        'Authorization': `Bearer ${token}`
      }
    });

    if (!res.ok) {
      localStorage.removeItem('jwt_token');
      return false;
    }

    const data = await res.json();
    sessionToken = token;
    sessionUsername = data.username;
    sessionTotalKills = data.totalKills || 0;
    ownedSkins = data.skins || ['ar_default', 'sniper_midnight'];
    unlockedEmotes = Array.isArray(data.unlockedEmotes) ? data.unlockedEmotes : [];
    equippedEmotes = Array.isArray(data.equippedEmotes) && data.equippedEmotes.length === 10 ? data.equippedEmotes : Array(10).fill(null);
    return true;
  } catch (error) {
    console.error('Session check error:', error);
    localStorage.removeItem('jwt_token');
    return false;
  }
}

function saveSession(token, username, totalKills = 0, skins = null) {
  sessionToken = token;
  sessionUsername = username;
  sessionTotalKills = totalKills;
  ownedSkins = skins || ['ar_default', 'sniper_midnight'];
  // Persist JWT token to localStorage
  localStorage.setItem('jwt_token', token);
}

function hideAuth() {
  authScreen.style.display = 'none';
}

function showAccountMenu() {
  if (menuUsername) menuUsername.textContent = sessionUsername || 'Player';
  if (menuTotalKills) menuTotalKills.textContent = sessionTotalKills || 0;
  accountMenu.style.display = 'flex';
  lockScreen.style.display = 'none';
  settingsModal.style.display = 'none';
  // Kills earned during a match are only stored on the server, so always
  // refresh the lifetime total when the menu is shown (login, or back to menu).
  refreshAccountStats();
}

// Fetch the latest account stats from the server and update the menu (and any
// consumers of sessionTotalKills) so totals never show a stale value.
async function refreshAccountStats() {
  if (!sessionToken) return;
  try {
    const res = await fetch(`${SERVER_URL}/api/me`, {
      headers: { 'Authorization': `Bearer ${sessionToken}` },
      cache: 'no-store'
    });
    if (!res.ok) return;
    const data = await res.json();
    if (typeof data.totalKills === 'number') {
      sessionTotalKills = data.totalKills;
      if (menuTotalKills) menuTotalKills.textContent = sessionTotalKills || 0;
    }
  } catch (err) { /* ignore - keep last known value */ }
}

async function signOut() {
  sessionToken = null;
  sessionUsername = null;
  sessionTotalKills = 0;
  localStorage.removeItem('jwt_token');
  accountMenu.style.display = 'none';
  settingsModal.style.display = 'none';
  lockScreen.style.display = 'none';
  authScreen.style.display = 'flex';
  if (net && net.socket) net.socket.disconnect();
}

function loadSession() {
  const token = localStorage.getItem('jwt_token');
  if (token) {
    sessionToken = token;
    return true;
  }
  return false;
}

function setupAuthUI() {
  // Tab switching
  tabLogin.addEventListener('click', () => {
    tabLogin.classList.add('active');
    tabRegister.classList.remove('active');
    loginPanel.style.display    = 'flex';
    registerPanel.style.display = 'none';
    loginError.textContent      = '';
  });
  tabRegister.addEventListener('click', () => {
    tabRegister.classList.add('active');
    tabLogin.classList.remove('active');
    registerPanel.style.display = 'flex';
    loginPanel.style.display    = 'none';
    regError.textContent        = '';
  });

  // Allow Enter key on inputs
  [loginUsername, loginPassword].forEach(el =>
    el.addEventListener('keydown', e => { if (e.key === 'Enter') loginBtn.click(); })
  );
  [regUsername, regPassword, regConfirm].forEach(el =>
    el.addEventListener('keydown', e => { if (e.key === 'Enter') registerBtn.click(); })
  );

  // Login submit
  loginBtn.addEventListener('click', async () => {
    loginError.textContent = '';
    const user = loginUsername.value.trim();
    const pass = loginPassword.value;
    if (!user || !pass) { loginError.textContent = 'Please fill in all fields.'; return; }
    loginBtn.disabled = true;
    loginBtn.textContent = 'LOGGING IN...';
    try {
      const res = await fetch(`${SERVER_URL}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: user, password: pass }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Login failed');
      }
      saveSession(data.token, data.username, data.totalKills || 0, data.skins || null);
      if (Array.isArray(data.unlockedEmotes)) unlockedEmotes = data.unlockedEmotes;
      if (Array.isArray(data.equippedEmotes) && data.equippedEmotes.length === 10) equippedEmotes = data.equippedEmotes;
      hideAuth();
      showAccountMenu();
    } catch (error) {
      loginError.textContent = error.message || 'Cannot reach server. Is it running?';
    } finally {
      loginBtn.disabled = false;
      loginBtn.textContent = 'LOGIN';
    }
  });

  // Register submit
  registerBtn.addEventListener('click', async () => {
    regError.textContent = '';
    const user  = regUsername.value.trim();
    const pass  = regPassword.value;
    const conf  = regConfirm.value;
    if (!user || !pass || !conf) { regError.textContent = 'Please fill in all fields.'; return; }
    if (pass !== conf) { regError.textContent = 'Passwords do not match.'; return; }
    if (pass.length < 6) { regError.textContent = 'Password must be at least 6 characters.'; return; }
    if (user.length < 3 || user.length > 20) { regError.textContent = 'Username must be 3-20 characters.'; return; }
    if (!/^[a-zA-Z0-9_]+$/.test(user)) { regError.textContent = 'Username can only contain letters, numbers and underscores.'; return; }
    registerBtn.disabled = true;
    registerBtn.textContent = 'CREATING...';
    try {
      const res = await fetch(`${SERVER_URL}/api/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: user, password: pass }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Registration failed');
      }
      // Auto-login after registration
      const loginRes = await fetch(`${SERVER_URL}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: user, password: pass }),
      });
      const loginData = await loginRes.json();
      if (!loginRes.ok) {
        throw new Error(loginData.error || 'Auto-login failed');
      }
      saveSession(loginData.token, loginData.username, loginData.totalKills || 0);
      if (Array.isArray(loginData.unlockedEmotes)) unlockedEmotes = loginData.unlockedEmotes;
      if (Array.isArray(loginData.equippedEmotes) && loginData.equippedEmotes.length === 10) equippedEmotes = loginData.equippedEmotes;
      hideAuth();
      showAccountMenu();
    } catch (error) {
      regError.textContent = error.message || 'Cannot reach server. Is it running?';
    } finally {
      registerBtn.disabled = false;
      registerBtn.textContent = 'CREATE ACCOUNT';
    }
  });

  // Render update logs
  renderUpdateLog('auth-update-log-content');
  renderUpdateLog('menu-update-log-content');
  renderUpdateLog('settings-update-log-content');
}

// ══════════════════════════════════════════════════════════════════════════════
//  GAME INITIALIZATION  (called once after successful auth)
// ══════════════════════════════════════════════════════════════════════════════

async function startGame() {
  localUsername = sessionUsername;

  // ── Renderer ──────────────────────────────────────────────────────────────
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setClearColor(0x87CEEB); // Sky blue

  scene = new THREE.Scene();
  // No fog

  camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.05, 200);
  scene.add(camera);
  clock  = new THREE.Clock();

  // ── Lighting ──────────────────────────────────────────────────────────────
  scene.add(new THREE.AmbientLight(0xffffff, 0.9)); // Brighter ambient
  const sun = new THREE.DirectionalLight(0xffffcc, 1.5); // Brighter sun
  sun.position.set(50, 80, 30);
  scene.add(sun);

  // Visual sun sphere
  const sunGeometry = new THREE.SphereGeometry(8, 32, 32);
  const sunMaterial = new THREE.MeshBasicMaterial({ color: 0xffff00 });
  const sunMesh = new THREE.Mesh(sunGeometry, sunMaterial);
  sunMesh.position.set(50, 80, 30);
  scene.add(sunMesh);

  const fill = new THREE.DirectionalLight(0x8899cc, 0.4);
  fill.position.set(-8, 5, -10);
  scene.add(fill);

  // ── Clouds ────────────────────────────────────────────────────────────────
  const cloudMat = new THREE.MeshLambertMaterial({ color: 0xffffff, transparent: true, opacity: 0.9 });
  const cloudPositions = [
    { x: -30, y: 40, z: -50 }, { x: 20, y: 45, z: -40 },
    { x: -50, y: 38, z: 20 }, { x: 40, y: 42, z: 30 },
    { x: 0, y: 50, z: -60 }, { x: -20, y: 35, z: 50 },
    { x: 60, y: 45, z: -20 }, { x: -60, y: 40, z: 40 },
  ];

  const createCloud = (x, y, z) => {
    const cloudGroup = new THREE.Group();
    const cloudParts = 5;

    for (let i = 0; i < cloudParts; i++) {
      const size = 3 + Math.random() * 4;
      const cloudPart = new THREE.Mesh(
        new THREE.SphereGeometry(size, 8, 8),
        cloudMat
      );
      cloudPart.position.set(
        (Math.random() - 0.5) * 8,
        (Math.random() - 0.5) * 2,
        (Math.random() - 0.5) * 4
      );
      cloudGroup.add(cloudPart);
    }

    cloudGroup.position.set(x, y, z);
    cloudGroup.userData.isCloud = true;
    cloudGroup.userData.baseX = x;
    cloudGroup.userData.speed = 0.5 + Math.random() * 0.5;
    scene.add(cloudGroup);
    return cloudGroup;
  };

  const clouds = cloudPositions.map(pos => createCloud(pos.x, pos.y, pos.z));
  window.clouds = clouds;

  // ── Map: /NEWMAP/Redblue.glb ─────────────────────────────────────────────
  // The map is a single glTF binary asset served as a static file from the repo
  // root by the Node/Express server, exactly like the other model folders.
  const MAP_GLB_URL = '/NEWMAP/Redblue.glb';

  const mapMeshes    = [];
  const mapColliders = [];

  // Compute Box3 collision boxes for solid map meshes. The huge ground sheet
  // must never become a collider (it would block ALL horizontal movement) or
  // a bullet target, matching the previous map where bullets passed the floor.
  function computeMapColliders(meshes) {
    const boxes = [];
    for (const m of meshes) {
      m.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(m);
      const w = box.max.x - box.min.x;
      const d = box.max.z - box.min.z;
      if (box.max.y <= 1.5 && w > 180 && d > 180) continue; // ground sheet
      boxes.push(box);
    }
    return boxes;
  }

  // Safety net: if the GLB is ever missing or fails to parse, build a plain
  // flat arena so the match remains playable (players can still fight).
  function addFallbackArena() {
    const floorMat = new THREE.MeshLambertMaterial({ color: 0x5a8a4a });
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(200, 200, 1, 1), floorMat);
    floor.rotation.x = -Math.PI / 2;
    scene.add(floor);

    const wallMat = new THREE.MeshLambertMaterial({ color: 0x3a4055 });
    const wallHeight = 8;
    const HALF = 99;
    const defs = [
      { pos: [0, wallHeight / 2, -HALF], size: [200, wallHeight, 1] },
      { pos: [0, wallHeight / 2,  HALF], size: [200, wallHeight, 1] },
      { pos: [-HALF, wallHeight / 2, 0], size: [1, wallHeight, 200] },
      { pos: [ HALF, wallHeight / 2, 0], size: [1, wallHeight, 200] },
    ];
    const fallbackMeshes = [];
    for (const d of defs) {
      const wall = new THREE.Mesh(new THREE.BoxGeometry(d.size[0], d.size[1], d.size[2]), wallMat);
      wall.position.set(d.pos[0], d.pos[1], d.pos[2]);
      scene.add(wall);
      fallbackMeshes.push(wall);
    }
    mapMeshes.push(...fallbackMeshes);
    mapColliders.push(...computeMapColliders(fallbackMeshes));
  }

  try {
    const gltf = await new Promise((resolve, reject) => {
      new GLTFLoader().load(MAP_GLB_URL, resolve, undefined, reject);
    });

    const mapRoot = gltf.scene;

    mapRoot.traverse((child) => {
      if (!child.isMesh) return;

      const srcMat = Array.isArray(child.material) ? child.material[0] : child.material;
      const matName = (srcMat && srcMat.name) || '';

      // Convert to the same flat Lambert look the rest of the game uses and
      // brighten the dark GLB materials so the arena reads clearly in-game.
      const base = srcMat && srcMat.color ? srcMat.color.clone() : new THREE.Color(0x9a9a9a);
      base.multiplyScalar(2.2);
      base.r = Math.max(0.05, base.r);
      base.g = Math.max(0.05, base.g);
      base.b = Math.max(0.05, base.b);
      child.material = new THREE.MeshLambertMaterial({ color: base });

      if (matName === 'Ground') return; // floor: not a collider/bullet target
      mapMeshes.push(child);
    });

    scene.add(mapRoot);
    mapColliders.push(...computeMapColliders(mapMeshes));
    console.log('[Map] Loaded ' + mapMeshes.length + ' solid meshes, ' + mapColliders.length + ' colliders');
  } catch (mapErr) {
    console.error('[Map] GLB load failed - using fallback arena:', mapErr);
    addFallbackArena();
  }

  // ── Ammo pickups - load FBX model
  const ammoPickups = [];
  const ammoPositions = [
    { x: -25, z: -12 }, { x: 25, z: -12 }, { x: -25, z: 12 }, { x: 25, z: 12 },
    { x: -20, z: 55 }, { x: 20, z: -55 }, { x: 55, z: 20 }, { x: -55, z: -20 },
    { x: 40, z: -50 }, { x: -50, z: 35 }, { x: -10, z: 70 }, { x: 75, z: -10 },
  ];

  const fbxLoader = new FBXLoader();
  let ammoModel = null;

  console.log('Loading ammo model from: /Ammo crate.fbx');
  fbxLoader.load('/Ammo crate.fbx', (fbx) => {
    console.log('Ammo model loaded successfully');
    ammoModel = fbx;
    ammoModel.scale.set(0.05, 0.05, 0.05); // Increased scale

    // Apply default material to override missing textures
    const ammoMat = new THREE.MeshLambertMaterial({ color: 0xffaa00, emissive: 0xff4400, emissiveIntensity: 0.3 });
    ammoModel.traverse((child) => {
      if (child.isMesh) {
        child.material = ammoMat;
        child.castShadow = true;
        child.receiveShadow = true;
      }
    });

    ammoPositions.forEach((pos, index) => {
      const ammoInstance = ammoModel.clone();
      ammoInstance.position.set(pos.x, 1.5, pos.z);
      ammoInstance.userData.isAmmo = true;
      ammoInstance.userData.ammoAmount = 30;
      ammoInstance.userData.baseY = 1.5;
      ammoInstance.userData.phaseOffset = index * 0.5; // Different phase for each pickup
      scene.add(ammoInstance);
      ammoPickups.push(ammoInstance);
    });

    // Store ammo pickups globally for collision detection
    window.ammoPickups = ammoPickups;
  }, undefined, (error) => {
    console.error('Error loading FBX model:', error);
    // Fallback to procedural boxes if FBX fails
    console.log('Falling back to procedural ammo boxes');
    const ammoMat = new THREE.MeshLambertMaterial({ color: 0xffaa00, emissive: 0xff4400, emissiveIntensity: 0.3 });
    ammoPositions.forEach((pos, index) => {
      const ammoBox = new THREE.Mesh(
        new THREE.BoxGeometry(1.0, 1.0, 1.0), // Bigger fallback boxes
        ammoMat
      );
      ammoBox.position.set(pos.x, 1.5, pos.z);
      ammoBox.userData.isAmmo = true;
      ammoBox.userData.ammoAmount = 30;
      ammoBox.userData.baseY = 1.5;
      ammoBox.userData.phaseOffset = index * 0.5;
      scene.add(ammoBox);
      ammoPickups.push(ammoBox);
    });
    window.ammoPickups = ammoPickups;
  });

  // ── Spawn points (visual indicators) ─────────────────────────────────────────
  const spawnMat = new THREE.MeshLambertMaterial({ color: 0x6688aa });
  const spawnPositions = [
    { x: 0, z: 0 },
    { x: -30, z: 30 },
    { x: 30, z: -30 },
    { x: 0, z: 60 },
    { x: 0, z: -60 },
    { x: 60, z: 0 },
    { x: -45, z: 20 },
    { x: -30, z: -30 }
  ];

  spawnPositions.forEach(pos => {
    const spawnPad = new THREE.Mesh(
      new THREE.CylinderGeometry(2.5, 2.5, 0.2, 16),
      spawnMat
    );
    spawnPad.position.set(pos.x, 2.0, pos.z); // Adjusted height for new map
    scene.add(spawnPad);
  });


  // ── Controller ────────────────────────────────────────────────────────────
  controller = new PlayerController(camera, canvas);
  controller.setColliders(mapColliders);

  // ── Network ───────────────────────────────────────────────────────────────
  net = new NetworkManager(SERVER_URL, sessionToken, sessionUsername);
  setupNetworkCallbacks();
  if (emoteManager) {
    emoteManager.net = net; // emotes now broadcast via socket
    emoteManager.loadManifest().catch(() => {});
    emoteManager.preloadWheel(equippedEmotes); // warm the cache for the wheel
  }

  // Refresh the in-game rank badges every 15s (and once right now).
  refreshInGameRanks();
  if (inGameRankTimer) clearInterval(inGameRankTimer);
  inGameRankTimer = setInterval(refreshInGameRanks, 15000);

  // ── FP hands ──────────────────────────────────────────────────────────────
  const fp = buildFPHands();
  fpHandsGroup = fp.group;
  fpHandsAnimator = fp.animator;
  fpHandsRoot = fp.root;
  camera.add(fpHandsGroup);

  // ── Local body avatar (create immediately, update color later) ─────────────
  await ensureLocalBody();

  // ── Weapon ────────────────────────────────────────────────────────────────
  const weaponNameEl = document.getElementById('weapon-name');
  const ui = { ammoEl, reserveEl, reloadEl, showHitmarker, weaponEl: weaponNameEl };
  weapon   = new WeaponSystem(camera, scene, net, controller, ui, 
    () => isThirdPerson, 
    () => localBodyAvatar
  );
  weapon.setFPHandsGroup(fpHandsGroup);
  weapon.remotePlayers = remotePlayers;
  weapon.setMapMeshes(mapMeshes);

  // ── Hook weapon events into the body-avatar animation system ─────────────
  weapon.onShoot  = () => { localAnimState.triggerShoot  = true; };
  weapon.onReload = () => { localAnimState.triggerReload = true; };

  // ── Setup weapon buttons after weaponSystem is created ───────────────────────
  const weaponArBtn = document.getElementById('weapon-ar-btn');
  const weaponSniperBtn = document.getElementById('weapon-sniper-btn');
  
  if (weaponArBtn) {
    weaponArBtn.addEventListener('click', () => {
      weapon.switchWeapon('ar');
      weaponArBtn.classList.add('active');
      weaponSniperBtn.classList.remove('active');
    });
  }
  
  if (weaponSniperBtn) {
    weaponSniperBtn.addEventListener('click', () => {
      weapon.switchWeapon('sniper');
      weaponSniperBtn.classList.add('active');
      weaponArBtn.classList.remove('active');
    });
  }

  // ── Input ─────────────────────────────────────────────────────────────────
  setupInput();

  // ── Status bar ────────────────────────────────────────────────────────────
  setInterval(() => {
    pingDisplay.textContent = net.connected ? `${net.ping}ms` : '';
    statusDot.className     = net.connected ? 'connected' : '';
    statusText.textContent  = net.connected ? 'Connected' : 'Connecting...';
  }, 1000);

  // ── Resize ────────────────────────────────────────────────────────────────
  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  isGameStarted = true;
  lockScreen.style.display = 'flex';
  viewIndicator.style.display = 'block';
  gameLoop();
}

// ══════════════════════════════════════════════════════════════════════════════
//  MENU BUTTON SETUP (called early in bootstrap)
// ══════════════════════════════════════════════════════════════════════════════

function setupMenuButtons() {
  // Account Menu Play Button
  if (menuPlayBtn) {
    menuPlayBtn.addEventListener('click', async () => {
      accountMenu.style.display = 'none';
      if (!isGameStarted) {
        await startGame();
      } else {
        lockScreen.style.display = 'flex';
        viewIndicator.style.display = 'block';
      }
    });
  }

  // Account Menu Guns Button
  if (menuGunsBtn) {
    menuGunsBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      accountMenu.style.display = 'none';
      const gunsModal = document.getElementById('guns-modal');
      if (gunsModal) gunsModal.style.display = 'flex';
    });
  }

  // Account Menu Emote Shop Button
  const menuEmotesBtn = document.getElementById('menu-emotes-btn');
  if (menuEmotesBtn) {
    menuEmotesBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openEmoteShop();
    });
  }

  // Account Menu Leaderboard Button
  const menuLeaderboardBtn = document.getElementById('menu-leaderboard-btn');
  if (menuLeaderboardBtn) {
    menuLeaderboardBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openLeaderboard();
    });
  }

  // Leaderboard modal controls
  const leaderboardCloseBtn = document.getElementById('leaderboard-close-btn');
  if (leaderboardCloseBtn) leaderboardCloseBtn.addEventListener('click', closeLeaderboard);
  const leaderboardBackdrop = document.getElementById('leaderboard-backdrop');
  if (leaderboardBackdrop) leaderboardBackdrop.addEventListener('click', closeLeaderboard);

  const setLeaderboardTab = (type) => {
    if (leaderboardTab === type) return;
    leaderboardTab = type;
    if (libTabGlobal) libTabGlobal.classList.toggle('active', type === 'global');
    if (libTabMonthly) libTabMonthly.classList.toggle('active', type === 'monthly');
    refreshLeaderboard();
  };
  if (libTabGlobal) libTabGlobal.addEventListener('click', () => setLeaderboardTab('global'));
  if (libTabMonthly) libTabMonthly.addEventListener('click', () => setLeaderboardTab('monthly'));

  // Account Menu Settings Button
  if (menuSettingsBtn) {
    menuSettingsBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      accountMenu.style.display = 'none';
      settingsModal.style.display = 'flex';
      // Change resume button text when not in game
      if (settingsResumeBtn) {
        settingsResumeBtn.textContent = 'BACK TO MENU';
      }
    });
  }

  // Account Menu Sign Out Button
  if (menuSignoutBtn) {
    menuSignoutBtn.addEventListener('click', signOut);
  }

  // Menu Head Bob Toggle
  const menuHeadBob = document.getElementById('menu-head-bob');
  if (menuHeadBob) {
    menuHeadBob.addEventListener('change', () => {
      if (controller) {
        controller.enableHeadBob = menuHeadBob.checked;
      }
    });
  }

  // Lock Screen Menu Button
  const lockMenuBtn = document.getElementById('lock-menu-btn');
  if (lockMenuBtn) {
    lockMenuBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      // Set flag to prevent lock screen from showing
      openingMenu = true;
      // Unlock pointer if locked
      if (document.pointerLockElement) {
        document.exitPointerLock();
      }
      accountMenu.style.display = 'flex';
      lockScreen.style.display = 'none';
      refreshAccountStats(); // pull the latest lifetime kills from the server
      settingsModal.style.display = 'none';
      // Reset flag after a short delay
      setTimeout(() => { openingMenu = false; }, 100);
    });
  }

  // Weapon Selection Buttons (now in Guns Modal)
  const weaponArBtn = document.getElementById('weapon-ar-btn');
  const weaponSniperBtn = document.getElementById('weapon-sniper-btn');

  if (weaponArBtn) {
    weaponArBtn.addEventListener('click', () => {
      if (weapon) weapon.switchWeapon('ar');
      weaponArBtn.classList.add('active');
      weaponSniperBtn.classList.remove('active');
      const gunsModal = document.getElementById('guns-modal');
      if (gunsModal) gunsModal.style.display = 'none';
      if (!isGameStarted) accountMenu.style.display = 'flex';
    });
  }

  if (weaponSniperBtn) {
    weaponSniperBtn.addEventListener('click', () => {
      if (weapon) weapon.switchWeapon('sniper');
      weaponSniperBtn.classList.add('active');
      weaponArBtn.classList.remove('active');
      const gunsModal = document.getElementById('guns-modal');
      if (gunsModal) gunsModal.style.display = 'none';
      if (!isGameStarted) accountMenu.style.display = 'flex';
    });
  }

  // Guns Modal Close Button
  const gunsCloseBtn = document.getElementById('guns-close-btn');
  if (gunsCloseBtn) {
    gunsCloseBtn.addEventListener('click', () => {
      const gunsModal = document.getElementById('guns-modal');
      if (gunsModal) gunsModal.style.display = 'none';
      if (!isGameStarted) accountMenu.style.display = 'flex';
    });
  }

  // ── Character Preview + Skins Manager ─────────────────────────────────────
  setupCharacterPreviewAndSkins();
}

// ─────────────────────────────────────────────────────────────────────────────
// Character preview + Skins modal logic
// ─────────────────────────────────────────────────────────────────────────────
let menuAvatarPreview = null;
let skinPreviewer     = null;
let skinsCurrentWeapon = 'ar';
let skinsSelectedSkinId = null;

function setupCharacterPreviewAndSkins() {
  // ── 3D Character Preview (left panel) ──────────────────────────────────────
  const avatarCanvas = document.getElementById('menu-avatar-canvas');
  if (avatarCanvas) {
    menuAvatarPreview = new MenuAvatarPreview(avatarCanvas);
    menuAvatarPreview.start();
  }

  // Keep weapon tag in sync with current weapon
  function updateCharPanelTag() {
    if (menuAvatarPreview) {
      const currentW = weapon ? weapon.currentWeapon : 'ar';
      const tag = document.getElementById('char-weapon-tag');
      if (tag) tag.textContent = currentW.toUpperCase();
      menuAvatarPreview.updateWeapon(currentW);
    }
  }

  // Initial update
  updateCharPanelTag();

  // Patch weapon.switchWeapon to also update the preview
  const _origSwitch = WeaponSystem.prototype.switchWeapon;
  WeaponSystem.prototype.switchWeapon = function(key) {
    _origSwitch.call(this, key);
    updateCharPanelTag();
  };

  // Update immediately when menu opens
  const accountMenuEl = document.getElementById('account-menu');
  if (accountMenuEl) {
    const menuObserver = new MutationObserver(() => {
      if (accountMenuEl.style.display !== 'none') {
        updateCharPanelTag();
      }
    });
    menuObserver.observe(accountMenuEl, { attributes: true, attributeFilter: ['style'] });
  }

  // ── SKINS Button (on character panel) ──────────────────────────────────────
  const loadoutBtn = document.getElementById('menu-loadout-btn');
  const skinsModal = document.getElementById('skins-modal');
  const skinsCloseBtn = document.getElementById('skins-close-btn');
  const skinsBackdrop = document.getElementById('skins-backdrop');

  function openSkinsModal() {
    if (skinsModal) skinsModal.style.display = 'flex';
    renderSkinsList(skinsCurrentWeapon);
    if (!skinPreviewer) {
      const previewCanvas = document.getElementById('skins-preview-canvas');
      if (previewCanvas) {
        skinPreviewer = new SkinPreviewer(previewCanvas);
        skinPreviewer.start();
      }
    }
    skinPreviewer?.showWeapon(skinsCurrentWeapon);
  }

  function closeSkinsModal() {
    if (skinsModal) skinsModal.style.display = 'none';
  }

  if (loadoutBtn) loadoutBtn.addEventListener('click', openSkinsModal);
  if (skinsCloseBtn) skinsCloseBtn.addEventListener('click', closeSkinsModal);
  if (skinsBackdrop) skinsBackdrop.addEventListener('click', closeSkinsModal);

  // ── Weapon tabs inside Skins Modal ─────────────────────────────────────────
  const tabAr     = document.getElementById('skins-tab-ar');
  const tabSniper = document.getElementById('skins-tab-sniper');

  function setSkinsTab(weaponType) {
    skinsCurrentWeapon = weaponType;
    skinsSelectedSkinId = null;
    tabAr?.classList.toggle('active', weaponType === 'ar');
    tabSniper?.classList.toggle('active', weaponType === 'sniper');
    renderSkinsList(weaponType);
    skinPreviewer?.showWeapon(weaponType);
    const previewName = document.getElementById('skins-preview-name');
    const previewDesc = document.getElementById('skins-preview-desc');
    if (previewName) previewName.textContent = weaponType === 'ar' ? 'AR Skins' : 'Sniper Skins';
    if (previewDesc) previewDesc.textContent = 'Select a skin card to preview it here.';
  }

  if (tabAr)     tabAr.addEventListener('click',     () => setSkinsTab('ar'));
  if (tabSniper) tabSniper.addEventListener('click', () => setSkinsTab('sniper'));

  // ── Skin card rendering ─────────────────────────────────────────────────────
  function renderSkinsList(weaponType) {
    const list = document.getElementById('skins-list');
    if (!list) return;
    list.innerHTML = '';

    // Only show skins the user has access to
    const skins = getAccessibleSkins(weaponType, sessionUsername);
    const equipped = getEquippedSkin(weaponType);

    skins.forEach((skin) => {
      const isEquipped = skin.id === equipped;
      const isPlaceholder = skin.type === 'placeholder';
      const isOwned = ownedSkins.includes(skin.id) || skin.exclusive; // Exclusive skins are automatically owned if accessible

      const card = document.createElement('div');
      card.className = 'skin-card' + (isEquipped ? ' equipped' : '');
      card.dataset.skinId = skin.id;

      // Badge class
      let badgeClass = 'badge-default';
      let badgeText = skin.badge || 'DEFAULT';
      if (isEquipped)          { badgeClass = 'badge-equipped'; badgeText = 'EQUIPPED'; }
      else if (skin.badge === 'FEATURED')    badgeClass = 'badge-featured';
      else if (skin.badge === 'COMING SOON') badgeClass = 'badge-coming';
      else if (skin.badge === 'CLASSIC')     badgeClass = 'badge-classic';
      else if (skin.badge === 'EXCLUSIVE')   badgeClass = 'badge-exclusive';
      else if (skin.type === 'glb')          badgeClass = 'badge-glb';
      else if (!isOwned)         { badgeClass = 'badge-locked'; badgeText = 'LOCKED'; }

      const icon = weaponType === 'sniper' ? '🎯' : '🔫';

      card.innerHTML = `
        <div class="skin-card-icon" style="border-color:${skin.color}33; background: ${skin.color}14;">${icon}</div>
        <div class="skin-card-info">
          <div class="skin-card-name">${skin.name}</div>
          <div class="skin-card-desc">${skin.desc}</div>
        </div>
        <div class="skin-card-badge ${badgeClass}">${badgeText}</div>
      `;

      if (!isPlaceholder && isOwned) {
        card.addEventListener('click', () => {
          // Deselect all
          list.querySelectorAll('.skin-card').forEach(c => c.classList.remove('selected'));
          card.classList.add('selected');
          skinsSelectedSkinId = skin.id;

          // Update preview info
          const previewName = document.getElementById('skins-preview-name');
          const previewDesc = document.getElementById('skins-preview-desc');
          if (previewName) previewName.textContent = skin.name;
          if (previewDesc) previewDesc.textContent = skin.desc;

          // Load and show the specific skin in preview
          if (skin.type === 'glb' && skin.url) {
            // Load the GLB model for preview
            import('three/examples/jsm/loaders/GLTFLoader.js').then(({ GLTFLoader }) => {
              const loader = new GLTFLoader();
              
              // Clear current weapon from preview
              const previewScene = skinPreviewer.scene;
              const oldWeapon = previewScene.children.find(c => c.name === 'weapon-container');
              if (oldWeapon) previewScene.remove(oldWeapon);
              
              loader.load(skin.url, (gltf) => {
                const model = gltf.scene;
                const box3 = new THREE.Box3().setFromObject(model);
                const center = box3.getCenter(new THREE.Vector3());
                const size = box3.getSize(new THREE.Vector3());
                
                const pivot = new THREE.Group();
                pivot.name = 'weapon-container';
                
                const sniperMat = new THREE.MeshStandardMaterial({
                  color: 0x1a1e24,
                  metalness: 0.85,
                  roughness: 0.25,
                });
                
                model.traverse((child) => {
                  if (child.isMesh) {
                    child.material = sniperMat;
                  }
                });
                
                model.position.sub(center);
                model.rotation.y = -Math.PI / 2;
                
                const maxDim = Math.max(size.x, size.y, size.z);
                const targetLength = 0.95;
                const scale = targetLength / (maxDim || 1);
                pivot.scale.set(scale, scale, scale);
                
                pivot.add(model);
                previewScene.add(pivot);
              });
            });
          } else {
            // Switch the 3D preview to show this weapon type
            skinPreviewer?.showWeapon(weaponType);
          }
        });
      } else {
        card.style.opacity = isOwned ? '1' : '0.45';
        card.style.cursor = isOwned ? 'pointer' : 'not-allowed';
      }

      list.appendChild(card);
    });
  }

  // ── Equip Button ─────────────────────────────────────────────────────────────
  const equipBtn = document.getElementById('skins-equip-btn');
  if (equipBtn) {
    equipBtn.addEventListener('click', () => {
      if (!skinsSelectedSkinId) return;
      
      // Check if user has access to this skin
      if (!hasSkinAccess(skinsSelectedSkinId, sessionUsername)) {
        alert('You do not have access to this exclusive skin.');
        return;
      }
      
      console.log(`Equipping skin: ${skinsSelectedSkinId} for weapon: ${skinsCurrentWeapon}`);
      setEquippedSkin(skinsCurrentWeapon, skinsSelectedSkinId);
      renderSkinsList(skinsCurrentWeapon);

      // If game is running and this weapon is selected, re-apply visual
      if (weapon && weapon.currentWeapon === skinsCurrentWeapon) {
        weapon._updateVisualWeapon();
        // Update weapon skin
        if (fpHandsGroup) {
          const weaponContainer = fpHandsGroup.children.find(c => c.name === 'weapon');
          if (weaponContainer) {
            console.log('Updating FP hands weapon skin');
            updateWeaponSkin(weaponContainer, skinsCurrentWeapon, skinsSelectedSkinId);
            weaponContainer.visible = true;
          }
        }
        // Also update local body avatar weapon
        if (localBodyAvatar && localBodyAvatar.root) {
          console.log('Updating local body avatar weapon skin');
          localBodyAvatar.root.traverse((obj) => {
            if (obj.name === 'weapon' || obj.name === 'weapon-container') {
              console.log('Found weapon container in local body, updating skin');
              updateWeaponSkin(obj, skinsCurrentWeapon, skinsSelectedSkinId);
              obj.visible = true;
            }
          });
        }
      }

      // Flash the equip button
      equipBtn.textContent = '✔ EQUIPPED!';
      equipBtn.style.background = 'linear-gradient(135deg, #22bb66 0%, #44dd88 100%)';
      setTimeout(() => {
        equipBtn.textContent = '✔ EQUIP SKIN';
        equipBtn.style.background = '';
      }, 1500);
    });
  }

} // end setupCharacterPreviewAndSkins

// ══════════════════════════════════════════════════════════════════════════════
//  INPUT SETUP & MENU CONTROLS
// ══════════════════════════════════════════════════════════════════════════════

function setupInput() {
  // Settings Resume / Close Buttons
  const closeSettings = () => {
    settingsModal.style.display = 'none';
    if (isGameStarted && controller && !isDead) {
      controller.lock();
    } else {
      accountMenu.style.display = 'flex';
    }
  };

  if (settingsResumeBtn) settingsResumeBtn.addEventListener('click', closeSettings);
  if (settingsCloseBtn)  settingsCloseBtn.addEventListener('click', closeSettings);
  if (settingsSignoutBtn) settingsSignoutBtn.addEventListener('click', signOut);

  // Settings: Head Bob Toggle
  if (settingHeadBob) {
    settingHeadBob.addEventListener('change', () => {
      if (controller) {
        controller.enableHeadBob = settingHeadBob.checked;
      }
    });
  }

  // Click lock screen to enter pointer lock
  lockScreen.addEventListener('click', () => {
    if (controller) controller.lock();
    // Don't hide lock screen yet - wait for pointerlockchange to confirm lock
  });

  document.addEventListener('pointerlockchange', () => {
    if (document.pointerLockElement) {
      // Pointer lock acquired - hide lock screen
      lockScreen.style.display = 'none';
    } else if (!isDead) {
      // Pointer lock lost - show lock screen
      // Don't show lock screen if we're opening the menu or the emote wheel
      if (openingMenu) return;
      if (emoteWheel && emoteWheel.open) return; // wheel is up - re-lock handles hiding later
      // Only show lock screen if neither menu nor settings are open
      // Use a small delay to allow menu to open first
      setTimeout(() => {
        if (settingsModal.style.display !== 'flex' && accountMenu.style.display !== 'flex') {
          lockScreen.style.display = 'flex';
        }
      }, 50);
    }
  });

  // Keyboard events
  document.addEventListener('keydown', (e) => {
    if (e.code === 'Tab') { e.preventDefault(); scoreboard.style.display = 'block'; }
    if (e.code === 'KeyV') toggleThirdPerson();
    if (e.code === 'Period') {
      e.preventDefault();
      if (emoteWheel && isGameStarted && !isDead) {
        lockScreen.style.display = 'none'; // don't show the "click to play" overlay
        emoteWheel.toggle();
      }
    }
    if (e.code === 'Digit1') {
      if (weapon) weapon.switchWeapon('ar');
      const weaponArBtn = document.getElementById('weapon-ar-btn');
      const weaponSniperBtn = document.getElementById('weapon-sniper-btn');
      if (weaponArBtn) weaponArBtn.classList.add('active');
      if (weaponSniperBtn) weaponSniperBtn.classList.remove('active');
    }
    if (e.code === 'Digit2') {
      if (weapon) weapon.switchWeapon('sniper');
      const weaponArBtn = document.getElementById('weapon-ar-btn');
      const weaponSniperBtn = document.getElementById('weapon-sniper-btn');
      if (weaponSniperBtn) weaponSniperBtn.classList.add('active');
      if (weaponArBtn) weaponArBtn.classList.remove('active');
    }
    if (e.code === 'Slash') {
      e.preventDefault();
      toggleChat();
      const chatInput = document.getElementById('chat-input');
      if (chatInput) chatInput.focus();
    }
    if (e.code === 'BracketLeft') {
      e.preventDefault();
      toggleChat();
    }
    if (e.code === 'Escape') {
      if (settingsModal.style.display === 'flex') {
        closeSettings();
      } else if (accountMenu.style.display === 'flex') {
        accountMenu.style.display = 'none';
        if (isGameStarted && !isDead) {
          lockScreen.style.display = 'flex';
        }
      } else if (isGameStarted && !isDead) {
        settingsModal.style.display = 'flex';
        lockScreen.style.display = 'none';
      }
    }
    if (e.code === 'Enter') {
      const chatInput = document.getElementById('chat-input');
      if (chatInput && document.activeElement === chatInput) {
        e.preventDefault();
        sendChatMessage();
      }
    }
  });
  document.addEventListener('keyup', (e) => {
    if (e.code === 'Tab') scoreboard.style.display = 'none';
  });

  // Chat toggle button
  const chatToggleBtn = document.getElementById('chat-toggle-btn');
  if (chatToggleBtn) {
    chatToggleBtn.addEventListener('click', toggleChat);
  }

  // Chat input submit
  const chatInput = document.getElementById('chat-input');
  if (chatInput) {
    chatInput.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        sendChatMessage();
      }
    });
  }
}

// ── Chat System ────────────────────────────────────────────────────────────────
let chatVisible = false;

function toggleChat() {
  const chatPanel = document.getElementById('chat-panel');
  if (!chatPanel) return;

  chatVisible = !chatVisible;
  chatPanel.style.display = chatVisible ? 'flex' : 'none';

  if (chatVisible) {
    const chatInput = document.getElementById('chat-input');
    if (chatInput) chatInput.focus();
  } else {
    if (controller && !isDead) controller.lock();
  }
}

function sendChatMessage() {
  const chatInput = document.getElementById('chat-input');
  if (!chatInput || !net) return;

  const message = chatInput.value.trim();
  if (!message) return;

  net.socket.emit('chat_message', { message });
  chatInput.value = '';

  // Keep chat open after sending
  chatInput.focus();
}

function addChatMessage(username, message) {
  const chatMessages = document.getElementById('chat-messages');
  if (!chatMessages) return;

  const messageEl = document.createElement('div');
  messageEl.className = 'chat-message';
  messageEl.innerHTML = `
    <span class="chat-username">${username}:</span>
    <span class="chat-text">${message}</span>
  `;

  chatMessages.appendChild(messageEl);
  chatMessages.scrollTop = chatMessages.scrollHeight;

  // Limit to 50 messages
  while (chatMessages.children.length > 50) {
    chatMessages.removeChild(chatMessages.firstChild);
  }
}

// ── Third-person toggle ────────────────────────────────────────────────────────
function toggleThirdPerson() {
  applyThirdPerson(!isThirdPerson);
}

function applyThirdPerson(enabled) {
  if (isThirdPerson === enabled) return;

  isThirdPerson = enabled;

  // FP hands only visible in first-person
  if (fpHandsGroup) fpHandsGroup.visible = !isThirdPerson;

  // Local body only visible in third-person
  if (localBodyAvatar) {
    localBodyAvatar.root.visible = isThirdPerson;
    // Ensure weapon is visible when body is visible
    if (isThirdPerson) {
      localBodyAvatar.root.traverse((obj) => {
        if (obj.name === 'weapon' || obj.name === 'weapon-container' || obj.name === 'weaponSocket') {
          obj.visible = true;
        }
      });
    }
  }

  // Update crosshair opacity
  const ch = document.getElementById('crosshair');
  if (ch) ch.style.opacity = isThirdPerson ? '0.4' : '1';

  viewIndicator.textContent = isThirdPerson ? '3RD PERSON' : '1ST PERSON';
}

// ── Ensure local body avatar exists (created lazily on first TP) ───────────────
async function ensureLocalBody() {
  if (localBodyAvatar) return;
  const { root, joints, animator } = await buildHumanoid(localColorIdx, true);
  root.visible = false; // starts hidden (first-person default)

  // Add local username label above head
  const label = createUsernameLabel(localUsername + ' (you)');
  label.position.set(0, 2.1, 0);
  root.add(label);

  // Rank medal (1st/2nd/3rd global leaderboard image) floating beside the name.
  const medal = createRankBadge();
  medal.sprite.position.set(0.95, 2.05, 0);
  root.add(medal.sprite);
  // Invisible hitbox
  const hitboxGeo = new THREE.BoxGeometry(1, 2, 1);
  const hitboxMat = new THREE.MeshBasicMaterial({ visible: false });
  const hitbox = new THREE.Mesh(hitboxGeo, hitboxMat);
  hitbox.position.set(0, 1, 0);
  root.add(hitbox);

  // Position at player's current position if controller exists
  if (controller) {
    root.position.set(
      controller.position.x,
      controller.position.y - EYE_HEIGHT,
      controller.position.z
    );
    root.rotation.y = controller.yaw + Math.PI;
    console.log('Local body positioned at:', root.position);
  }

  scene.add(root);
  localBodyAvatar = { root, joints, animator, hitbox, label, medal, username: localUsername, lookupUsername: localUsername };
  applyRankBadge(localBodyAvatar);
}

// ══════════════════════════════════════════════════════════════════════════════
//  NETWORK CALLBACKS
// ══════════════════════════════════════════════════════════════════════════════

function setupNetworkCallbacks() {
  net.onInit = async (id, players, colorIndex) => {
    localColorIdx = colorIndex;
    statusDot.classList.add('connected');
    statusText.textContent = 'Connected';
    for (const [pid, pdata] of Object.entries(players)) {
      if (pid !== id) await spawnRemotePlayer(pid, pdata);
    }
    scores.set(id, { kills: 0, deaths: 0, name: localUsername });
    updateScoreboard();
    // Local body already created in startGame, just update color if needed
    if (localBodyAvatar) {
      console.log('Local body already exists, color index:', colorIndex);
    }
  };

  net.onPlayerJoin = async (id, data) => {
    await spawnRemotePlayer(id, data);
    addKillFeedEntry('', data.username || id.slice(0, 6), '🔌 joined', false);
  };

  net.onPlayerLeave = (id) => {
    removeRemotePlayer(id);
  };

  net.onShot = (data) => {
    if (data.shooterId === net.localId) return;
    const dir    = new THREE.Vector3(data.dir.x, data.dir.y, data.dir.z);
    const origin = new THREE.Vector3(data.origin.x, data.origin.y, data.origin.z);
    const end    = origin.clone().addScaledVector(dir, 80);
    spawnRemoteTracer(origin, end);
  };

  net.onHit = (data) => {
    if (data.victimId === net.localId) {
      localHealth = Math.max(0, data.health);
      updateHealthUI();
      // Show damage vignette
      damageVignette.classList.remove('active');
      void damageVignette.offsetWidth; // Trigger reflow
      damageVignette.classList.add('active');
    }
    if (data.shooterId === net.localId) showHitmarker();
  };

  net.onDied = (data) => {
    if (data.victimId === net.localId) {
      isDead = true;
      if (emoteManager) emoteManager.stop(); // death instantly cancels emotes
      controller.die();
      if (localBodyAvatar) localBodyAvatar.root.visible = false;
      deathOverlay.style.display = 'flex';
      // Show killer name
      const killerNameEl = document.getElementById('killer-name');
      if (killerNameEl) {
        killerNameEl.textContent = data.killerName || data.killerId?.slice(0, 6) || '?';
      }
      startRespawnCountdown(data.respawnIn || 3);
      if (scores.has(data.killerId)) scores.get(data.killerId).kills++;
      if (scores.has(net.localId))   scores.get(net.localId).deaths++;
      addKillFeedEntry(data.killerName || '?', localUsername, '🔫 AR');
    } else {
      const rp = remotePlayers.get(data.victimId);
      if (rp) rp.root.visible = false;
      if (scores.has(data.killerId)) scores.get(data.killerId).kills++;
      if (scores.has(data.victimId)) scores.get(data.victimId).deaths++;
      addKillFeedEntry(
        data.killerName || data.killerId?.slice(0, 6) || '?',
        data.victimName || data.victimId?.slice(0, 6) || '?',
        '🔫 AR'
      );
    }
    updateScoreboard();
  };

  net.onChatMessage = (data) => {
    addChatMessage(data.username, data.message);
  };

  net.onRespawn = (data) => {
    if (data.id === net.localId) {
      isDead      = false;
      localHealth = 100;
      controller.respawn({ x: data.x, y: data.y, z: data.z });
      deathOverlay.style.display = 'none';
      if (localBodyAvatar && isThirdPerson) localBodyAvatar.root.visible = true;
      updateHealthUI();
      // Refill ammo on respawn
      if (weapon) weapon.refillAmmo();
    } else {
      const rp = remotePlayers.get(data.id);
      if (rp) {
        rp.root.visible = true;
        rp.animState.emote = null; // never carry an emote across death/respawn
        rp.root.position.set(data.x, 0, data.z);
      }
    }
  };

  net.onHealthSync = (id, health) => {
    if (id === net.localId) { localHealth = health; updateHealthUI(); }
  };

  net.onPlayerWeaponChange = (id, weapon) => {
    const rp = remotePlayers.get(id);
    if (rp && rp.root) {
      setWeaponType(rp.root, weapon);
    }
  };

  net.onPlayerEmote = (id, emoteId) => {
    const rp = remotePlayers.get(id);
    if (!rp) return;
    rp.animState.emote = emoteId;
    // Stream the emote clip so the remote avatar can actually play it (cached
    // locally afterwards).
    if (emoteManager) emoteManager.preload(emoteId);
  };

  net.onPlayerEmoteStop = (id) => {
    const rp = remotePlayers.get(id);
    if (rp) rp.animState.emote = null;
  };

  net.onDuplicateLogin = (message) => {
    alert(message || 'You have been logged in from another location');
    signOut();
  };

  net.onAnticheatKick = (data) => {
    const message = `Anti-cheat violation: ${data.reason}\nYou have been temporarily banned for ${data.duration} seconds.\nBan expires: ${new Date(data.expiry).toLocaleString()}`;
    alert(message);
    signOut();
  };

  // Live leaderboard pushes: server sends the full standings whenever kills
  // change the board. Update rank badges immediately and re-render the modal
  // if it is currently open (no 5s poll wait needed).
  net.onLeaderboardUpdate = (standings) => {
    if (!standings) return;
    if (Array.isArray(standings.global)) {
      const next = new Map();
      for (const e of standings.global) next.set(String(e.username).toLowerCase(), e.rank);
      lbRanks = next;
      for (const rp of remotePlayers.values()) applyRankBadge(rp);
      applyRankBadge(localBodyAvatar);
    }
    if (leaderboardModal && leaderboardModal.style.display !== 'none') {
      const payload = {
        type: leaderboardTab,
        entries: leaderboardTab === 'monthly' ? (standings.monthly || []) : (standings.global || []),
      };
      renderLeaderboard(payload);
    }
  };
}

// ══════════════════════════════════════════════════════════════════════════════
//  PLAYER SPAWN / REMOVE
// ══════════════════════════════════════════════════════════════════════════════

async function spawnRemotePlayer(id, data) {
  if (remotePlayers.has(id)) return;
  const colorIdx = data.colorIndex || 0;
  const { root, joints, animator } = await buildHumanoid(colorIdx, false);
  // Subtract EYE_HEIGHT to convert from eye position to ground position
  root.position.set(data.x || 0, (data.y || 0) - EYE_HEIGHT, data.z || 0);
  
  // Set initial weapon type
  if (data.currentWeapon) {
    setWeaponType(root, data.currentWeapon);
  }

  // Ensure weapon is visible for remote players
  root.traverse((obj) => {
    if (obj.name === 'weapon' || obj.name === 'weapon-container' || obj.name === 'weaponSocket') {
      obj.visible = true;
    }
  });

  // Username label above head (rank medal is a separate sprite)
  const uname = data.username || data.name || id.slice(0, 6);
  const label = createUsernameLabel(uname, -1, 0);
  label.position.set(0, 2.1, 0);
  root.add(label);

  // Rank medal (1st/2nd/3rd global leaderboard image) floating beside the name.
  const medal = createRankBadge();
  medal.sprite.position.set(0.95, 2.05, 0);
  root.add(medal.sprite);

  // Invisible hitbox
  const hitboxGeo = new THREE.BoxGeometry(1, 2, 1);
  const hitboxMat = new THREE.MeshBasicMaterial({ visible: false });
  const hitbox = new THREE.Mesh(hitboxGeo, hitboxMat);
  hitbox.position.set(0, 1, 0);
  root.add(hitbox);

  scene.add(root);
  const animState = { time: 0, speed: 0, isGrounded: true, pitch: 0, velocityY: 0 };
  const rp = { root, joints, animator, animState, label, medal, hitbox, username: uname };
  remotePlayers.set(id, rp);
  applyRankBadge(rp);

  scores.set(id, { kills: data.kills || 0, deaths: data.deaths || 0, name: uname });
  updateScoreboard();
}

function removeRemotePlayer(id) {
  const rp = remotePlayers.get(id);
  if (rp) scene.remove(rp.root);
  remotePlayers.delete(id);
  scores.delete(id);
  updateScoreboard();
}

// ══════════════════════════════════════════════════════════════════════════════
//  UI HELPERS
// ══════════════════════════════════════════════════════════════════════════════

function updateHealthUI() {
  const pct = Math.max(0, localHealth) / 100;
  healthBar.style.width = `${pct * 100}%`;
  healthText.textContent = Math.max(0, Math.round(localHealth));
  if (pct < 0.3)      healthBar.style.background = 'linear-gradient(90deg, #ff2222, #ff5555)';
  else if (pct < 0.6) healthBar.style.background = 'linear-gradient(90deg, #ff8844, #ffaa66)';
  else                healthBar.style.background = 'linear-gradient(90deg, #ff4444, #ff6666)';
}

function showHitmarker() {
  hitmarkerEl.classList.remove('active');
  void hitmarkerEl.offsetWidth;
  hitmarkerEl.classList.add('active');
}

function addKillFeedEntry(killer, victim, weaponStr, isKill = true) {
  const el = document.createElement('div');
  el.className = 'kill-entry';
  el.innerHTML = isKill
    ? `<span class="killer">${killer}</span> <span class="weapon">${weaponStr}</span> <span class="victim">${victim}</span>`
    : `<span class="victim">${victim}</span> ${weaponStr}`;
  killFeed.prepend(el);
  setTimeout(() => el.remove(), 4000);
  while (killFeed.children.length > 5) killFeed.lastChild.remove();
}

function updateScoreboard() {
  sbList.innerHTML = '';
  const sorted = [...scores.entries()].sort((a, b) => b[1].kills - a[1].kills);
  for (const [id, s] of sorted) {
    const row = document.createElement('div');
    row.className = 'scoreboard-row' + (id === net?.localId ? ' local' : '');
    row.innerHTML = `<span class="score-name">${s.name}</span><span class="score-kd">${s.kills}K / ${s.deaths}D</span>`;
    sbList.appendChild(row);
  }
}

let _respawnInterval = null;
function startRespawnCountdown(secs) {
  let t = secs;
  respawnCount.textContent = t;
  if (_respawnInterval) clearInterval(_respawnInterval);
  _respawnInterval = setInterval(() => {
    t--;
    respawnCount.textContent = Math.max(0, t);
    if (t <= 0) clearInterval(_respawnInterval);
  }, 1000);
}

function spawnRemoteTracer(from, to) {
  const mat  = new THREE.LineBasicMaterial({ color: 0xffaa44, transparent: true, opacity: 0.7 });
  const geo  = new THREE.BufferGeometry().setFromPoints([from, to]);
  const line = new THREE.Line(geo, mat);
  scene.add(line);
  _remoteTracers.push({ line });
}

// ══════════════════════════════════════════════════════════════════════════════
//  GAME LOOP
// ══════════════════════════════════════════════════════════════════════════════

function gameLoop() {
  requestAnimationFrame(gameLoop);
  const delta = Math.min(clock.getDelta(), 0.1);
  const now   = performance.now();

  // ── Health regeneration ────────────────────────────────────────────────────
  if (!isDead && localHealth < 100) {
    localHealth = Math.min(100, localHealth + delta * 5); // 5 health per second
    updateHealthUI();
  }

  // ── Ammo pickup collision ────────────────────────────────────────────────
  if (!isDead && window.ammoPickups) {
    const playerPos = controller.position;
    const time = now / 1000;

    for (let i = window.ammoPickups.length - 1; i >= 0; i--) {
      const pickup = window.ammoPickups[i];
      if (!pickup.visible) continue;

      // Spin animation
      pickup.rotation.y += delta * 2;

      // Bob up and down animation
      const phase = pickup.userData.phaseOffset || 0;
      pickup.position.y = pickup.userData.baseY + Math.sin(time * 2 + phase) * 0.2;

      // Collision detection
      const dist = playerPos.distanceTo(pickup.position);
      if (dist < 2.0) {
        // Pickup ammo
        if (weapon && weapon.addAmmo) {
          weapon.addAmmo(pickup.userData.ammoAmount);
        }
        // Hide pickup and set respawn timer (30 seconds)
        pickup.visible = false;
        pickup.userData.respawnTime = now + 30000; // 30 seconds
      }

      // Check for respawn
      if (!pickup.visible && pickup.userData.respawnTime && now >= pickup.userData.respawnTime) {
        pickup.visible = true;
        pickup.userData.respawnTime = null;
      }
    }
  }

  // ── Cloud animation ─────────────────────────────────────────────────────────
  if (window.clouds) {
    for (const cloud of window.clouds) {
      cloud.position.x += cloud.userData.speed * delta;
      // Reset cloud position when it goes too far
      if (cloud.position.x > 100) {
        cloud.position.x = -100;
      }
    }
  }

// ── Local controller ──────────────────────────────────────────────────────
  if (!isDead) {
    controller.update(delta);
    // Debug: log controller state occasionally
    if (Math.random() < 0.01) {
      console.log('Controller update - isLocked:', controller.isLocked, 'velocity:', controller.velocity, 'position:', controller.position);
    }
  }

  // ── Emote management (cancel the instant the player starts moving) ────────
  if (emoteManager) emoteManager.update();

  // Auto-switch to third-person while an emote plays, then restore the POV the
  // player was in before. Works for both player-initiated emotes and emotes
  // triggered by wheel selection.
  const emotePlaying = emoteManager ? !!emoteManager.activeEmote : false;
  if (emotePlaying) {
    if (emotePovOverride === null) {
      emotePovOverride = isThirdPerson;      // remember the POV they were in
      if (!isThirdPerson) applyThirdPerson(true);
    }
  } else if (emotePovOverride !== null) {
    applyThirdPerson(emotePovOverride);      // emote ended - restore previous POV
    emotePovOverride = null;
  }

  // ── Update local body avatar (always, not just in third-person) ────────────
  if (localBodyAvatar && !isDead) {
    const feetPos = new THREE.Vector3(
      controller.position.x,
      controller.position.y - EYE_HEIGHT,
      controller.position.z
    );
    localBodyAvatar.root.position.copy(feetPos);
    localBodyAvatar.root.rotation.y = controller.yaw + Math.PI;
    localBodyAvatar.root.updateMatrixWorld(); // Force matrix update
    localAnimState.speed      = Math.sqrt(controller.velocity.x ** 2 + controller.velocity.z ** 2);
    localAnimState.isGrounded = controller.isGrounded;
    localAnimState.pitch      = controller.pitch;
    localAnimState.velocityY  = controller.velocity.y || 0;
    animateAvatar(localBodyAvatar, localAnimState, delta);
  }

  // ── Third-person camera override ──────────────────────────────────────────
  if (isThirdPerson && !isDead) {
    const feetPos = new THREE.Vector3(
      controller.position.x,
      controller.position.y - EYE_HEIGHT,
      controller.position.z
    );

    // Target point to look at (chest / upper body)
    const target = feetPos.clone();
    target.y += 1.35;

    // Orbit distance and pitch clamping - negate pitch to fix inversion
    const dist  = 3.8;
    const pitch = Math.max(-Math.PI * 0.44, Math.min(Math.PI * 0.44, -controller.pitch));

    // Calculate orbit position using pitch and yaw
    const camX = target.x + dist * Math.cos(pitch) * Math.sin(controller.yaw);
    const camY = target.y + dist * Math.sin(pitch) + 0.3;
    const camZ = target.z + dist * Math.cos(pitch) * Math.cos(controller.yaw);

    camera.position.set(camX, camY, camZ);
    camera.lookAt(target);
  }

  // ── Send movement ─────────────────────────────────────────────────────────
  if (net && net.connected && !isDead && now - _lastMoveSent > MOVE_INTERVAL) {
    net.sendMove(controller.getSnapshot());
    _lastMoveSent = now;
  }

  // ── Weapon update ─────────────────────────────────────────────────────────
  if (weapon) weapon.update(delta, controller.isLocked, !isDead);

  // ── Update FP hands animation ───────────────────────────────────────────────
  if (fpHandsAnimator && !isThirdPerson && !isDead) {
    const fpAnimState = {
      speed: Math.sqrt(controller.velocity.x ** 2 + controller.velocity.z ** 2),
      isGrounded: controller.isGrounded,
      velocityY: controller.velocity.y || 0
    };
    animateAvatar({ animator: fpHandsAnimator }, fpAnimState, delta);
  }

  // ── Interpolate & animate remote players ──────────────────────────────────
  for (const [id, rp] of remotePlayers) {
    const snap = net.getInterpolated(id);
    if (!snap) continue;
    // Subtract EYE_HEIGHT to convert from eye position to ground position
    rp.root.position.set(snap.x, snap.y - EYE_HEIGHT, snap.z); // Use actual Y position for jump height visibility
    rp.root.rotation.y      = snap.yaw + Math.PI;
    rp.animState.speed      = snap.speed || 0;
    rp.animState.isGrounded = snap.isGrounded;
    rp.animState.pitch      = snap.pitch || 0;
    rp.animState.velocityY  = snap.velocityY || 0; // Use actual velocityY for jump animation sync
    animateAvatar(rp, rp.animState, delta);
  }

  // ── Decay remote tracers ──────────────────────────────────────────────────
  for (let i = _remoteTracers.length - 1; i >= 0; i--) {
    const tr = _remoteTracers[i];
    tr.line.material.opacity -= delta * 5;
    if (tr.line.material.opacity <= 0) {
      scene.remove(tr.line);
      _remoteTracers.splice(i, 1);
    }
  }

  renderer.render(scene, camera);
}

// ══════════════════════════════════════════════════════════════════════════════
//  START
// ══════════════════════════════════════════════════════════════════════════════
bootstrap();
