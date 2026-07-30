// ─── main.js ──────────────────────────────────────────────────────────────────
// Main game client. Auth-gated: shows login/register until session verified.
// Features: real-time 3D FPS, third-person toggle (V), username labels.

import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { PlayerController }        from './PlayerController.js';
import { NetworkManager }          from './NetworkManager.js';
import { WeaponSystem }            from './WeaponSystem.js';
import {
  buildHumanoid,
  buildFPHands,
  animateAvatar,
  createUsernameLabel,
} from './AvatarManager.js';
import './style.css';
import {
  auth,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  onAuthStateChanged,
  firebaseSignOut
} from './firebase-config.js';

// ── Constants ──────────────────────────────────────────────────────────────────
const SERVER_URL = "https://fps-multiplayer-game.onrender.com";
const TICK_RATE   = 20;
const EYE_HEIGHT  = 1.65;

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
const menuSettingsBtn    = document.getElementById('menu-settings-btn');
const menuSignoutBtn     = document.getElementById('menu-signout-btn');

const settingsModal      = document.getElementById('settings-modal');
const settingHeadBob     = document.getElementById('setting-head-bob');
const settingsResumeBtn  = document.getElementById('settings-resume-btn');
const settingsCloseBtn   = document.getElementById('settings-close-btn');
const settingsSignoutBtn = document.getElementById('settings-signout-btn');

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
let isGameStarted     = false;

// ── Game objects (lazy-initialized after auth) ─────────────────────────────────
let renderer, scene, camera, clock;
let controller, net, weapon;
let fpHandsGroup;
let localBodyAvatar   = null; // full body for third-person view
let localAnimState    = { time: 0, speed: 0, isGrounded: true, pitch: 0 };
let isThirdPerson     = false;
let isDead            = false;
let localHealth       = 100;
let localColorIdx     = 0;
let localUsername     = '';
const scores          = new Map();
const remotePlayers   = new Map(); // id → { root, joints, animState, label }
const _remoteTracers  = [];
let _lastMoveSent     = 0;
const MOVE_INTERVAL   = 1000 / TICK_RATE;

// ══════════════════════════════════════════════════════════════════════════════
//  AUTH
// ══════════════════════════════════════════════════════════════════════════════

async function bootstrap() {
  setupAuthUI();
  setupMenuButtons();
  // Try to load saved session first
  if (loadSession()) {
    const ok = await checkSession();
    if (ok) {
      hideAuth();
      showAccountMenu();
    }
  } else {
    const ok = await checkSession();
    if (ok) {
      hideAuth();
      showAccountMenu();
    }
  }
}

async function checkSession() {
  // Bypass Firebase auth for test server (localhost or Render)
  if (SERVER_URL.includes('localhost') || SERVER_URL.includes('onrender.com')) {
    // Only check session if we have a saved username
    if (sessionUsername) {
      const res = await fetch(`${SERVER_URL}/api/me?username=${sessionUsername}`);
      if (res.ok) {
        const data = await res.json();
        sessionToken = 'test-token';
        sessionUsername = data.username;
        sessionTotalKills = data.totalKills || 0;
        return true;
      }
    }
    return false;
  }

  return new Promise((resolve) => {
    const unsubscribe = onAuthStateChanged(auth, async (user) => {
      unsubscribe();
      if (user) {
        try {
          const token = await user.getIdToken();
          const res = await fetch(`${SERVER_URL}/api/me?token=${token}`);
          if (!res.ok) {
            await firebaseSignOut(auth);
            resolve(false);
            return;
          }
          const data = await res.json();
          sessionToken = token;
          sessionUsername = data.username;
          sessionTotalKills = data.totalKills || 0;
          resolve(true);
        } catch {
          await firebaseSignOut(auth);
          resolve(false);
        }
      } else {
        resolve(false);
      }
    });
  });
}

function saveSession(token, username, totalKills = 0) {
  sessionToken = token;
  sessionUsername = username;
  sessionTotalKills = totalKills;
  // Persist to localStorage
  localStorage.setItem('fps_session', JSON.stringify({ token, username, totalKills }));
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
}

async function signOut() {
  await firebaseSignOut(auth);
  sessionToken = null;
  sessionUsername = null;
  sessionTotalKills = 0;
  localStorage.removeItem('fps_session');
  accountMenu.style.display = 'none';
  settingsModal.style.display = 'none';
  lockScreen.style.display = 'none';
  authScreen.style.display = 'flex';
  if (net && net.socket) net.socket.disconnect();
}

function loadSession() {
  const saved = localStorage.getItem('fps_session');
  if (saved) {
    try {
      const { token, username, totalKills } = JSON.parse(saved);
      sessionToken = token;
      sessionUsername = username;
      sessionTotalKills = totalKills;
      return true;
    } catch (e) {
      localStorage.removeItem('fps_session');
    }
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
      if (SERVER_URL.includes('localhost') || SERVER_URL.includes('onrender.com')) {
        // Bypass Firebase for test server
        const res = await fetch(`${SERVER_URL}/api/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: user, password: pass }),
        });
        const data = await res.json();
        if (!res.ok) {
          throw new Error(data.error || 'Login failed');
        }
        saveSession('test-token', user, data.totalKills || 0);
        hideAuth();
        showAccountMenu();
      } else {
        const userCredential = await signInWithEmailAndPassword(auth, user, pass);
        const token = await userCredential.user.getIdToken();
        const res = await fetch(`${SERVER_URL}/api/me?token=${token}`);
        const data = await res.json();
        saveSession(token, data.username, data.totalKills || 0);
        hideAuth();
        showAccountMenu();
      }
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
    registerBtn.disabled = true;
    registerBtn.textContent = 'CREATING...';
    try {
      if (SERVER_URL.includes('localhost') || SERVER_URL.includes('onrender.com')) {
        // Bypass Firebase for test server
        const res = await fetch(`${SERVER_URL}/api/register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: user, password: pass }),
        });
        const data = await res.json();
        if (!res.ok) {
          throw new Error(data.error || 'Registration failed');
        }
        saveSession('test-token', user, 0);
        hideAuth();
        showAccountMenu();
      } else {
        const userCredential = await createUserWithEmailAndPassword(auth, user, pass);
        const token = await userCredential.user.getIdToken();

        // Create player record in Firebase Realtime Database
        await fetch(`${SERVER_URL}/api/create-player`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ uid: userCredential.user.uid, username: user }),
        });

        const res = await fetch(`${SERVER_URL}/api/me?token=${token}`);
        const data = await res.json();
        saveSession(token, data.username, data.totalKills || 0);
        hideAuth();
        showAccountMenu();
      }
    } catch (error) {
      regError.textContent = error.message || 'Cannot reach server. Is it running?';
    } finally {
      registerBtn.disabled = false;
      registerBtn.textContent = 'CREATE ACCOUNT';
    }
  });
}

// ══════════════════════════════════════════════════════════════════════════════
//  GAME INITIALIZATION  (called once after successful auth)
// ══════════════════════════════════════════════════════════════════════════════

function startGame() {
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

// ── Simple Map ──────────────────────────────────────────────────────────────
  const wallMat = new THREE.MeshLambertMaterial({ color: 0x3a4055 });
  const floorMat = new THREE.MeshLambertMaterial({ color: 0x5a8a4a }); // Brighter green grass
  const accentMat = new THREE.MeshLambertMaterial({ color: 0x4a5568 });
  const buildingMat = new THREE.MeshLambertMaterial({ color: 0x5a5a6a });
  const treeMat = new THREE.MeshLambertMaterial({ color: 0x2d5a2d });
  const trunkMat = new THREE.MeshLambertMaterial({ color: 0x4a3a2a });

  // Main floor - expanded to 150x150
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(150, 150, 60, 60),
    floorMat
  );
  floor.rotation.x = -Math.PI / 2;
  scene.add(floor);

  // Grid overlay
  const grid = new THREE.GridHelper(150, 60, 0x607060, 0x506050);
  grid.position.y = 0.01;
  scene.add(grid);

  // Outer walls - expanded
  const wallHeight = 6;
  const wallThickness = 1;
  const MAP_SIZE = 75;
  
  // North wall
  const northWall = new THREE.Mesh(
    new THREE.BoxGeometry(150, wallHeight, wallThickness),
    wallMat
  );
  northWall.position.set(0, wallHeight / 2, -MAP_SIZE);
  scene.add(northWall);

  // South wall
  const southWall = new THREE.Mesh(
    new THREE.BoxGeometry(150, wallHeight, wallThickness),
    wallMat
  );
  southWall.position.set(0, wallHeight / 2, MAP_SIZE);
  scene.add(southWall);

  // East wall
  const eastWall = new THREE.Mesh(
    new THREE.BoxGeometry(wallThickness, wallHeight, 150),
    wallMat
  );
  eastWall.position.set(MAP_SIZE, wallHeight / 2, 0);
  scene.add(eastWall);

  // West wall
  const westWall = new THREE.Mesh(
    new THREE.BoxGeometry(wallThickness, wallHeight, 150),
    wallMat
  );
  westWall.position.set(-MAP_SIZE, wallHeight / 2, 0);
  scene.add(westWall);

  // Center platform
  const centerPlatform = new THREE.Mesh(
    new THREE.BoxGeometry(12, 0.5, 12),
    accentMat
  );
  centerPlatform.position.set(0, 1.5, 0);
  scene.add(centerPlatform);

  // Four corner platforms - expanded positions
  const cornerPositions = [
    { x: -40, z: -40 },
    { x: 40, z: -40 },
    { x: -40, z: 40 },
    { x: 40, z: 40 }
  ];

  cornerPositions.forEach(pos => {
    const platform = new THREE.Mesh(
      new THREE.BoxGeometry(10, 0.5, 10),
      accentMat
    );
    platform.position.set(pos.x, 2, pos.z);
    scene.add(platform);

    // Ramp to platform
    const ramp = new THREE.Mesh(
      new THREE.BoxGeometry(5, 0.3, 8),
      wallMat
    );
    ramp.position.set(pos.x * 0.7, 1, pos.z * 0.7);
    ramp.rotation.y = Math.atan2(pos.z, pos.x) + Math.PI / 2;
    scene.add(ramp);
  });

  // Buildings
  const createBuilding = (x, z, w, h, d) => {
    const building = new THREE.Mesh(
      new THREE.BoxGeometry(w, h, d),
      buildingMat
    );
    building.position.set(x, h / 2, z);
    scene.add(building);
    return building;
  };

  // Main buildings - reduced for performance
  createBuilding(-30, -30, 12, 8, 12);
  createBuilding(30, 30, 12, 8, 12);

  // Smaller buildings - reduced for performance
  createBuilding(-50, 0, 8, 5, 8);
  createBuilding(50, 0, 8, 5, 8);

  // Reduced ramps
  const rampPositions = [
    { x: -20, z: 0, rotY: 0 },
    { x: 20, z: 0, rotY: Math.PI },
    { x: 0, z: -20, rotY: Math.PI / 2 },
    { x: 0, z: 20, rotY: -Math.PI / 2 },
  ];

  rampPositions.forEach(ramp => {
    // Create staircase-style ramp for better collision
    const steps = 8;
    const stepHeight = 0.3;
    const stepDepth = 12 / steps;
    const rampWidth = 8;

    for (let i = 0; i < steps; i++) {
      const stepMesh = new THREE.Mesh(
        new THREE.BoxGeometry(rampWidth, stepHeight, stepDepth),
        accentMat
      );

      // Calculate position along the ramp
      const progress = i / steps;
      const xOffset = Math.sin(ramp.rotY) * (progress * 12 - 6);
      const zOffset = Math.cos(ramp.rotY) * (progress * 12 - 6);
      const yOffset = 1.0 + (i * stepHeight);

      stepMesh.position.set(ramp.x + xOffset, yOffset, ramp.z + zOffset);
      stepMesh.rotation.y = ramp.rotY;
      scene.add(stepMesh);
    }
  });

  // Ammo pickups - load FBX model
  const ammoPickups = [];
  const ammoPositions = [
    { x: -15, z: -15 }, { x: 15, z: -15 }, { x: -15, z: 15 }, { x: 15, z: 15 },
    { x: -35, z: 0 }, { x: 35, z: 0 }, { x: 0, z: -35 }, { x: 0, z: 35 },
    { x: -25, z: -25 }, { x: 25, z: -25 }, { x: -25, z: 25 }, { x: 25, z: 25 },
  ];

  const fbxLoader = new FBXLoader();
  let ammoModel = null;

  console.log('Loading ammo model from: /Ammo crate.fbx');
  fbxLoader.load('/Ammo crate.fbx', (fbx) => {
    console.log('Ammo model loaded successfully');
    ammoModel = fbx;
    ammoModel.scale.set(0.05, 0.05, 0.05); // Increased scale

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

  // Trees - use procedural trees (FBX has parsing issues)
  const treePositions = [
    { x: -20, z: -20 }, { x: 20, z: -20 }, { x: -20, z: 20 }, { x: 20, z: 20 },
    { x: -60, z: -20 }, { x: 60, z: -20 }, { x: -60, z: 20 }, { x: 60, z: 20 },
    { x: -20, z: -60 }, { x: 20, z: -60 }, { x: -20, z: 60 }, { x: 20, z: 60 },
    { x: -40, z: 0 }, { x: 40, z: 0 }, { x: 0, z: -40 }, { x: 0, z: 40 },
    { x: -55, z: -55 }, { x: 55, z: -55 }, { x: -55, z: 55 }, { x: 55, z: 55 },
  ];

  const createTree = (x, z) => {
    const trunk = new THREE.Mesh(
      new THREE.CylinderGeometry(0.3, 0.4, 3, 8),
      trunkMat
    );
    trunk.position.set(x, 1.5, z);
    scene.add(trunk);

    const foliage = new THREE.Mesh(
      new THREE.ConeGeometry(2, 4, 8),
      treeMat
    );
    foliage.position.set(x, 4.5, z);
    scene.add(foliage);
  };
  treePositions.forEach(pos => createTree(pos.x, pos.z));

  // Central cover structure
  const coverHeight = 3;
  const coverPillar1 = new THREE.Mesh(
    new THREE.BoxGeometry(1, coverHeight, 1),
    wallMat
  );
  coverPillar1.position.set(-5, coverHeight / 2, -5);
  scene.add(coverPillar1);

  const coverPillar2 = new THREE.Mesh(
    new THREE.BoxGeometry(1, coverHeight, 1),
    wallMat
  );
  coverPillar2.position.set(5, coverHeight / 2, -5);
  scene.add(coverPillar2);

  const coverPillar3 = new THREE.Mesh(
    new THREE.BoxGeometry(1, coverHeight, 1),
    wallMat
  );
  coverPillar3.position.set(-5, coverHeight / 2, 5);
  scene.add(coverPillar3);

  const coverPillar4 = new THREE.Mesh(
    new THREE.BoxGeometry(1, coverHeight, 1),
    wallMat
  );
  coverPillar4.position.set(5, coverHeight / 2, 5);
  scene.add(coverPillar4);

  // Cover roof
  const coverRoof = new THREE.Mesh(
    new THREE.BoxGeometry(12, 0.3, 12),
    accentMat
  );
  coverRoof.position.set(0, coverHeight + 0.15, 0);
  scene.add(coverRoof);

  // Mid-field barriers
  for (let i = 0; i < 4; i++) {
    const barrier = new THREE.Mesh(
      new THREE.BoxGeometry(2, 1.5, 0.5),
      wallMat
    );
    const angle = (i / 4) * Math.PI * 2;
    barrier.position.set(Math.cos(angle) * 15, 0.75, Math.sin(angle) * 15);
    barrier.rotation.y = angle + Math.PI / 2;
    scene.add(barrier);
  }

  // Spawn points (visual indicators) - expanded positions
  const spawnMat = new THREE.MeshLambertMaterial({ color: 0x6688aa });
  const spawnPositions = [
    { x: -60, z: 0 },
    { x: 60, z: 0 },
    { x: 0, z: -60 },
    { x: 0, z: 60 },
    { x: -40, z: -40 },
    { x: 40, z: -40 },
    { x: -40, z: 40 },
    { x: 40, z: 40 }
  ];

  spawnPositions.forEach(pos => {
    const spawnPad = new THREE.Mesh(
      new THREE.CylinderGeometry(2.5, 2.5, 0.2, 16),
      spawnMat
    );
    spawnPad.position.set(pos.x, 0.1, pos.z);
    scene.add(spawnPad);
  });

  // ── Collect Map Objects & Colliders ─────────────────────────────────────────
  const mapMeshes = [
    northWall, southWall, eastWall, westWall,
    centerPlatform,
    coverPillar1, coverPillar2, coverPillar3, coverPillar4,
    coverRoof
  ];

  // Include corner platforms, ramps, and mid-field barriers
  scene.traverse(obj => {
    if (obj.isMesh && (obj.material === wallMat || obj.material === accentMat || obj.material === buildingMat)) {
      if (!mapMeshes.includes(obj) && obj !== floor) {
        mapMeshes.push(obj);
      }
    }
  });

  // Create Box3 colliders for PlayerController physics
  const mapColliders = mapMeshes.map(m => {
    m.updateMatrixWorld(true);
    return new THREE.Box3().setFromObject(m);
  });


  // ── Controller ────────────────────────────────────────────────────────────
  controller = new PlayerController(camera, canvas);
  controller.setColliders(mapColliders);

  // ── Network ───────────────────────────────────────────────────────────────
  net = new NetworkManager(SERVER_URL, sessionToken, sessionUsername);
  setupNetworkCallbacks();

  // ── FP hands ──────────────────────────────────────────────────────────────
  const fp = buildFPHands();
  fpHandsGroup = fp.group;
  camera.add(fpHandsGroup);

  // ── Weapon ────────────────────────────────────────────────────────────────
  const weaponNameEl = document.getElementById('weapon-name');
  const ui = { ammoEl, reserveEl, reloadEl, showHitmarker, weaponEl: weaponNameEl };
  weapon   = new WeaponSystem(camera, scene, net, controller, ui, 
    () => isThirdPerson, 
    () => localBodyAvatar
  );
  weapon.remotePlayers = remotePlayers;
  weapon.setMapMeshes(mapMeshes);

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
    menuPlayBtn.addEventListener('click', () => {
      accountMenu.style.display = 'none';
      if (!isGameStarted) {
        startGame();
      } else {
        lockScreen.style.display = 'flex';
        viewIndicator.style.display = 'block';
      }
    });
  }

  // Account Menu Settings Button
  if (menuSettingsBtn) {
    menuSettingsBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      settingsModal.style.display = 'flex';
    });
  }

  // Account Menu Sign Out Button
  if (menuSignoutBtn) {
    menuSignoutBtn.addEventListener('click', signOut);
  }

  // Lock Screen Menu Button
  const lockMenuBtn = document.getElementById('lock-menu-btn');
  if (lockMenuBtn) {
    lockMenuBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      accountMenu.style.display = 'flex';
      lockScreen.style.display = 'none';
    });
  }

  // Weapon Selection Buttons
  const weaponArBtn = document.getElementById('weapon-ar-btn');
  const weaponSniperBtn = document.getElementById('weapon-sniper-btn');

  if (weaponArBtn && weapon) {
    weaponArBtn.addEventListener('click', () => {
      weapon.switchWeapon('ar');
      weaponArBtn.classList.add('active');
      weaponSniperBtn.classList.remove('active');
    });
  }

  if (weaponSniperBtn && weapon) {
    weaponSniperBtn.addEventListener('click', () => {
      weapon.switchWeapon('sniper');
      weaponSniperBtn.classList.add('active');
      weaponArBtn.classList.remove('active');
    });
  }
}

// ══════════════════════════════════════════════════════════════════════════════
//  INPUT SETUP & MENU CONTROLS
// ══════════════════════════════════════════════════════════════════════════════

function setupInput() {
  // Settings Resume / Close Buttons
  const closeSettings = () => {
    settingsModal.style.display = 'none';
    if (isGameStarted && controller && !isDead) {
      controller.lock();
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
    lockScreen.style.display = 'none';
    if (controller) controller.lock();
  });

  document.addEventListener('pointerlockchange', () => {
    if (!document.pointerLockElement && !isDead) {
      if (settingsModal.style.display !== 'flex' && accountMenu.style.display !== 'flex') {
        lockScreen.style.display = 'flex';
      }
    }
  });

  // Keyboard events
  document.addEventListener('keydown', (e) => {
    if (e.code === 'Tab') { e.preventDefault(); scoreboard.style.display = 'block'; }
    if (e.code === 'KeyV') toggleThirdPerson();
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
  isThirdPerson = !isThirdPerson;

  // FP hands only visible in first-person
  if (fpHandsGroup) fpHandsGroup.visible = !isThirdPerson;

  // Local body only visible in third-person
  if (localBodyAvatar) localBodyAvatar.root.visible = isThirdPerson;

  // Update crosshair opacity
  const ch = document.getElementById('crosshair');
  if (ch) ch.style.opacity = isThirdPerson ? '0.4' : '1';

  viewIndicator.textContent = isThirdPerson ? '3RD PERSON' : '1ST PERSON';
}

// ── Ensure local body avatar exists (created lazily on first TP) ───────────────
function ensureLocalBody() {
  if (localBodyAvatar) return;
  const { root, joints } = buildHumanoid(localColorIdx, false);
  root.visible = false; // starts hidden (first-person default)

  // Add local username label above head
  const label = createUsernameLabel(localUsername + ' (you)');
  label.position.set(0, 2.1, 0);
  root.add(label);

  // Invisible hitbox
  const hitboxGeo = new THREE.BoxGeometry(1, 2, 1);
  const hitboxMat = new THREE.MeshBasicMaterial({ visible: false });
  const hitbox = new THREE.Mesh(hitboxGeo, hitboxMat);
  hitbox.position.set(0, 1, 0);
  root.add(hitbox);

  scene.add(root);
  localBodyAvatar = { root, joints, hitbox };
}

// ══════════════════════════════════════════════════════════════════════════════
//  NETWORK CALLBACKS
// ══════════════════════════════════════════════════════════════════════════════

function setupNetworkCallbacks() {
  net.onInit = (id, players, colorIndex) => {
    localColorIdx = colorIndex;
    statusDot.classList.add('connected');
    statusText.textContent = 'Connected';
    for (const [pid, pdata] of Object.entries(players)) {
      if (pid !== id) spawnRemotePlayer(pid, pdata);
    }
    scores.set(id, { kills: 0, deaths: 0, name: localUsername });
    updateScoreboard();
    // Create local body now we have colorIndex
    ensureLocalBody();
  };

  net.onPlayerJoin = (id, data) => {
    spawnRemotePlayer(id, data);
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
      controller.die();
      if (localBodyAvatar) localBodyAvatar.root.visible = false;
      deathOverlay.style.display = 'flex';
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
    } else {
      const rp = remotePlayers.get(data.id);
      if (rp) {
        rp.root.visible = true;
        rp.root.position.set(data.x, 0, data.z);
      }
    }
  };

  net.onHealthSync = (id, health) => {
    if (id === net.localId) { localHealth = health; updateHealthUI(); }
  };
}

// ══════════════════════════════════════════════════════════════════════════════
//  PLAYER SPAWN / REMOVE
// ══════════════════════════════════════════════════════════════════════════════

function spawnRemotePlayer(id, data) {
  if (remotePlayers.has(id)) return;
  const colorIdx = data.colorIndex || 0;
  const { root, joints } = buildHumanoid(colorIdx, false);
  root.position.set(data.x || 0, 0, data.z || 0);

  // Username label above head
  const uname = data.username || data.name || id.slice(0, 6);
  const label = createUsernameLabel(uname);
  label.position.set(0, 2.1, 0);
  root.add(label);

  // Invisible hitbox
  const hitboxGeo = new THREE.BoxGeometry(1, 2, 1);
  const hitboxMat = new THREE.MeshBasicMaterial({ visible: false });
  const hitbox = new THREE.Mesh(hitboxGeo, hitboxMat);
  hitbox.position.set(0, 1, 0);
  root.add(hitbox);

  scene.add(root);
  const animState = { time: 0, speed: 0, isGrounded: true, pitch: 0 };
  remotePlayers.set(id, { root, joints, animState, label, hitbox });

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
  if (!isDead) controller.update(delta);

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

    // Drive local body avatar
    if (localBodyAvatar) {
      localBodyAvatar.root.position.copy(feetPos);
      localBodyAvatar.root.rotation.y = controller.yaw + Math.PI;
      localAnimState.speed      = Math.sqrt(controller.velocity.x ** 2 + controller.velocity.z ** 2);
      localAnimState.isGrounded = controller.isGrounded;
      localAnimState.pitch      = controller.pitch;
      animateAvatar(localBodyAvatar.joints, localAnimState, delta);
    }
  }

  // ── Send movement ─────────────────────────────────────────────────────────
  if (net && net.connected && !isDead && now - _lastMoveSent > MOVE_INTERVAL) {
    net.sendMove(controller.getSnapshot());
    _lastMoveSent = now;
  }

  // ── Weapon update ─────────────────────────────────────────────────────────
  if (weapon) weapon.update(delta, controller.isLocked, !isDead);

  // ── Interpolate & animate remote players ──────────────────────────────────
  for (const [id, rp] of remotePlayers) {
    const snap = net.getInterpolated(id);
    if (!snap) continue;
    rp.root.position.set(snap.x, 0, snap.z);
    rp.root.rotation.y      = snap.yaw + Math.PI;
    rp.animState.speed      = snap.speed || 0;
    rp.animState.isGrounded = snap.isGrounded;
    rp.animState.pitch      = snap.pitch || 0;
    animateAvatar(rp.joints, rp.animState, delta);
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
