// ─── AvatarManager.js ───────────────────────────────────────────────────────
// Mixamo-based avatar system with AnimationMixer and weapon attachment.
// Local player: only first-person hands + gun visible.
// Remote players: full body renders with Mixamo animations.

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js';

// ── Sniper GLB Model Preloader ────────────────────────────────────────────────
const sniperGlbTemplates = {}; // Store multiple sniper models by skin ID
const sniperCallbacks = {}; // Callbacks for each skin
const sniperModelGroups = {}; // Registry of sniper-model groups waiting for GLB by skin

export function loadSniperModel(skinId = 'sniper_midnight', onLoad) {
  const url = skinId === 'sniper_testing' 
    ? '/sniper skins GLB/Meshy_AI_Super_Sniper_0805114143_texture.glb'
    : '/sniper skins GLB/Meshy_AI_Midnight_Precision_Ri_0801152731_generate.glb';

  if (sniperGlbTemplates[skinId]) {
    if (onLoad) onLoad(sniperGlbTemplates[skinId].clone());
    return;
  }
  if (onLoad) {
    if (!sniperCallbacks[skinId]) sniperCallbacks[skinId] = [];
    sniperCallbacks[skinId].push(onLoad);
  }

  if (loadSniperModel.isLoading?.[skinId]) return;
  if (!loadSniperModel.isLoading) loadSniperModel.isLoading = {};
  loadSniperModel.isLoading[skinId] = true;

  const loader = new GLTFLoader();

  loader.load(
    url,
    (gltf) => {
      const model = gltf.scene;

      const box3 = new THREE.Box3().setFromObject(model);
      const center = box3.getCenter(new THREE.Vector3());
      const size = box3.getSize(new THREE.Vector3());

      const pivot = new THREE.Group();
      pivot.name = 'sniper-glb-pivot';

      const sniperMat = new THREE.MeshStandardMaterial({
        color: 0x1a1e24,
        metalness: 0.85,
        roughness: 0.25,
      });

      model.traverse((child) => {
        if (child.isMesh) {
          child.castShadow = true;
          child.receiveShadow = true;
          child.material = sniperMat;
        }
      });

      model.position.sub(center);

      // Rotate GLB mesh so long axis (+X) points forward (-Z)
      model.rotation.y = -Math.PI / 2;

      const maxDim = Math.max(size.x, size.y, size.z);
      const targetLength = 0.95;
      const scale = targetLength / (maxDim || 1);
      pivot.scale.set(scale, scale, scale);

      pivot.add(model);
      sniperGlbTemplates[skinId] = pivot;

      if (sniperCallbacks[skinId]) {
        sniperCallbacks[skinId].forEach(cb => cb(sniperGlbTemplates[skinId].clone()));
        sniperCallbacks[skinId].length = 0;
      }

      // Update all registered sniper-model groups for this skin
      if (sniperModelGroups[skinId]) {
        sniperModelGroups[skinId].forEach(group => {
          if (group.children.length === 0) {
            group.add(sniperGlbTemplates[skinId].clone());
          }
        });
        sniperModelGroups[skinId].length = 0;
      }
    },
    undefined,
    (err) => {
      console.error(`Failed to load GLB sniper model for ${skinId}:`, err);
    }
  );
}

// Trigger early preload for default sniper
loadSniperModel('sniper_midnight');

export function setWeaponType(container, type) {
  if (!container) return;
  container.traverse((obj) => {
    if (obj.name === 'ar-model') {
      obj.visible = (type === 'ar');
    }
    if (obj.name === 'sniper-model') {
      obj.visible = (type === 'sniper');
    }
    // Also check for weapon-container and make sure it's visible
    if (obj.name === 'weapon-container') {
      obj.visible = true;
    }
  });
}

// ── Mixamo Character Loading System ─────────────────────────────────────────────
let characterTemplate = null;
let characterLoadPromise = null;

function loadCharacter() {
  if (characterLoadPromise) return characterLoadPromise;
  characterLoadPromise = new Promise((resolve, reject) => {
    const loader = new GLTFLoader();
    loader.load('/NEW character/Character.glb', (gltf) => {
      const model = gltf.scene;
      
      // Enable shadows
      model.traverse((child) => {
        if (child.isMesh) {
          child.castShadow = true;
          child.receiveShadow = true;
        }
      });
      
      // Calculate scale to 1.7 units
      const box = new THREE.Box3().setFromObject(model);
      const height = box.max.y - box.min.y;
      const scale = 1.7 / height;
      model.scale.set(scale, scale, scale);
      
      // Center on ground
      const center = box.getCenter(new THREE.Vector3());
      model.position.y = -box.min.y * scale;
      
      characterTemplate = model;
      console.log('Character loaded and scaled to 1.7 units');
      resolve(model);
    }, undefined, reject);
  });
  return characterLoadPromise;
}

// ── Flexible Bone Finder for Mixamo Skeleton ─────────────────────────────────────
const BONE_PATTERNS = {
  hips: ['mixamorig1:Hips', 'mixamorig1Hips', 'mixamorig:Hips', 'Hips', 'hip'],
  spine: ['mixamorig1:Spine', 'mixamorig1Spine', 'mixamorig:Spine', 'Spine', 'spine'],
  head: ['mixamorig1:Head', 'mixamorig1Head', 'mixamorig:Head', 'Head', 'head'],
  rightArm: ['mixamorig1:RightArm', 'mixamorig1RightArm', 'mixamorig:RightArm', 'RightArm', 'rightArm', 'right_arm'],
  rightForeArm: ['mixamorig1:RightForeArm', 'mixamorig1RightForeArm', 'mixamorig:RightForeArm', 'RightForeArm', 'rightForeArm', 'right_forearm'],
  rightHand: ['mixamorig1:RightHand', 'mixamorig1RightHand', 'mixamorig:RightHand', 'RightHand', 'rightHand', 'right_hand'],
  leftArm: ['mixamorig1:LeftArm', 'mixamorig1LeftArm', 'mixamorig:LeftArm', 'LeftArm', 'leftArm', 'left_arm'],
  leftForeArm: ['mixamorig1:LeftForeArm', 'mixamorig1LeftForeArm', 'mixamorig:LeftForeArm', 'LeftForeArm', 'leftForeArm', 'left_forearm'],
  leftHand: ['mixamorig1:LeftHand', 'mixamorig1LeftHand', 'mixamorig:LeftHand', 'LeftHand', 'leftHand', 'left_hand'],
  rightUpLeg: ['mixamorig1:RightUpLeg', 'mixamorig1RightUpLeg', 'mixamorig:RightUpLeg', 'RightUpLeg', 'rightUpLeg', 'right_up_leg'],
  rightLeg: ['mixamorig1:RightLeg', 'mixamorig1RightLeg', 'mixamorig:RightLeg', 'RightLeg', 'rightLeg', 'right_leg'],
  leftUpLeg: ['mixamorig1:LeftUpLeg', 'mixamorig1LeftUpLeg', 'mixamorig:LeftUpLeg', 'LeftUpLeg', 'leftUpLeg', 'left_up_leg'],
  leftLeg: ['mixamorig1:LeftLeg', 'mixamorig1LeftLeg', 'mixamorig:LeftLeg', 'LeftLeg', 'leftLeg', 'left_leg'],
};

function findBone(model, boneKey) {
  const patterns = BONE_PATTERNS[boneKey];
  if (!patterns) return null;
  
  for (const pattern of patterns) {
    const bone = model.getObjectByName(pattern);
    if (bone) {
      return bone;
    }
  }
  console.warn(`Bone not found: ${boneKey}`);
  return null;
}

function logBoneHierarchy(model, indent = 0) {
  model.traverse((child) => {
    if (child.isBone) {
      console.log('  '.repeat(indent) + child.name);
    }
  });
}

// ── Animation Loading System ─────────────────────────────────────────────────────
const ANIMATION_PATHS = {
  idle:   '/NEW character/Characters animations/ar and sniper IDLE.glb',
  walk:   '/NEW character/Characters animations/ar and sniper WALK.glb',
  run:    '/NEW character/Characters animations/ar and sniper RUN (shift).glb',
  jump:   '/NEW character/Characters animations/ar and sniper JUMP (jump up).glb',
  fall:   '/NEW character/Characters animations/ar and sniper FALL (jump down).glb',
  reload: '/NEW character/Characters animations/reload gun.glb',
  shoot:  '/NEW character/Characters animations/shoot gun.glb',
};

// One-shot animations that play once and return to base state
const ONE_SHOT_ANIMS = new Set(['reload', 'shoot']);

let animationClips = {};
let animationsLoaded = false;

async function loadAnimations() {
  if (animationsLoaded) return animationClips;
  
  const loader = new GLTFLoader();
  const loadPromises = Object.entries(ANIMATION_PATHS).map(([name, path]) => {
    return new Promise((resolve) => {
      loader.load(path, (gltf) => {
        if (gltf.animations && gltf.animations.length > 0) {
          animationClips[name] = gltf.animations[0];
          console.log(`Loaded animation: ${name} (${gltf.animations[0].duration.toFixed(2)}s)`);
        }
        resolve();
      }, undefined, (err) => {
        console.warn(`Failed to load animation: ${name}`, err);
        resolve();
      });
    });
  });
  
  await Promise.all(loadPromises);
  animationsLoaded = true;
  return animationClips;
}

// ── Animation State Machine Class ───────────────────────────────────────────────
class AvatarAnimator {
  constructor(model, clips) {
    this.mixer = new THREE.AnimationMixer(model);
    this.clips = clips;

    // ── Base layer: looping locomotion/state anims ──────────────────────────
    this.currentAction = null;
    this.currentState  = null; // start null so first play() always activates

    // ── Override layer: high-priority one-shot anims (shoot, reload) ────────
    this._overrideAction = null;
    this._overrideFinishHandler = null;
  }

  // ── Play a looping base-state animation (idle/walk/run/jump/fall) ────────
  play(name, fadeDuration = 0.2) {
    // Don't interrupt base layer if same state already playing
    if (this.currentState === name && this.currentAction) return;

    const clip = this.clips[name];
    if (!clip) {
      console.warn(`Animation not found: ${name}`);
      return;
    }

    const newAction = this.mixer.clipAction(clip);

    // Ensure the action loops indefinitely and is reset to a clean state
    newAction.loop = THREE.LoopRepeat;
    newAction.clampWhenFinished = false;
    newAction.repetitions = Infinity;

    // Only reset time if we are transitioning from a different state
    // (avoids a pop when re-enabling the same action)
    if (this.currentAction !== newAction) {
      newAction.reset();
      newAction.setEffectiveTimeScale(1);
      newAction.setEffectiveWeight(1);
    }

    if (this.currentAction && this.currentAction !== newAction) {
      this.currentAction.crossFadeTo(newAction, fadeDuration, true);
    } else if (!this.currentAction) {
      newAction.fadeIn(fadeDuration);
    }

    newAction.play();
    this.currentAction = newAction;
    this.currentState  = name;
  }

  // ── Trigger a one-shot override animation (shoot / reload) ───────────────
  // The override plays at full weight over the base layer, then fades out.
  triggerOverride(name, fadeDuration = 0.1) {
    const clip = this.clips[name];
    if (!clip) {
      console.warn(`Override animation not found: ${name}`);
      return;
    }

    // If the same override is already running, just restart it
    if (this._overrideAction && this._overrideAction.isRunning()) {
      // For shoot: restart from beginning (rapid fire feel)
      if (name === 'shoot') {
        this._overrideAction.reset();
        this._overrideAction.play();
        return;
      }
      // For reload: don't interrupt a running reload
      return;
    }

    // Clean up any previous finished override
    if (this._overrideFinishHandler) {
      this.mixer.removeEventListener('finished', this._overrideFinishHandler);
      this._overrideFinishHandler = null;
    }

    const action = this.mixer.clipAction(clip);
    action.reset();
    action.loop = THREE.LoopOnce;
    action.clampWhenFinished = false;
    action.setEffectiveTimeScale(1);
    action.setEffectiveWeight(1);
    action.fadeIn(fadeDuration);
    action.play();

    this._overrideAction = action;

    // When the override finishes, fade it out so base layer resumes cleanly
    this._overrideFinishHandler = (e) => {
      if (e.action === action) {
        action.fadeOut(0.2);
        this._overrideAction = null;
        this.mixer.removeEventListener('finished', this._overrideFinishHandler);
        this._overrideFinishHandler = null;
      }
    };
    this.mixer.addEventListener('finished', this._overrideFinishHandler);
  }

  // ── Returns true while a one-shot override is still playing ─────────────
  isOverridePlaying() {
    return this._overrideAction !== null && this._overrideAction.isRunning();
  }

  update(delta) {
    this.mixer.update(delta);
  }
}

// ── Weapon Socket System ───────────────────────────────────────────────────────
// Socket is parented to the Mixamo right-hand bone.
// The hand bone's local space has its own axes — empirically:
//   position: slightly forward (+Z) and down (-Y) of the palm centre
//   rotation: align weapon barrel to point along the hand's forward axis
function createWeaponSocket(rightHandBone) {
  const socket = new THREE.Object3D();
  socket.name = 'weaponSocket';

  if (rightHandBone) {
    // Offset: push forward along palm, drop slightly below centre
    socket.position.set(0.0, -0.03, 0.08);
    // Rotate so the weapon barrel faces forward (-Z in world when arm is extended)
    socket.rotation.set(0, Math.PI / 2, 0);
    rightHandBone.add(socket);
  } else {
    console.warn('Right hand bone not found for weapon socket');
  }

  return socket;
}

// colours per player slot
const PLAYER_COLORS = [0xff4444, 0x44aaff, 0x44ff88, 0xffcc44, 0xcc44ff, 0xff8844];

// Materials for first-person hands
const MAT = {
  localSkin: new THREE.MeshLambertMaterial({ color: 0xd4a574 }),
};

// ── Shared geometry / material cache for procedural AR weapon ─────────────────
const GEO_CACHE = {};
function box(w, h, d) {
  const k = `${w},${h},${d}`;
  if (!GEO_CACHE[k]) GEO_CACHE[k] = new THREE.BoxGeometry(w, h, d);
  return GEO_CACHE[k];
}

const WEAPON_MAT = {
  metal:   new THREE.MeshLambertMaterial({ color: 0x4a4a50 }),
  barrel:  new THREE.MeshLambertMaterial({ color: 0x222226 }),
  stock:   new THREE.MeshLambertMaterial({ color: 0x5c3a1e }),
};

// ─────────────────────────────────────────────────────────────────────────────
// Build Mixamo humanoid rig with animations and weapon attachment
// Returns: { root, joints:{}, weaponAnchor, animator }
// ─────────────────────────────────────────────────────────────────────────────
export async function buildHumanoid(colorIndex = 0, isLocal = false) {
  await loadCharacter();
  await loadAnimations();
  
  // Clone character template properly with skeleton rebinding
  const root = SkeletonUtils.clone(characterTemplate);
  root.name = 'avatar-root';
  
  // Find bones
  const bones = {
    hips: findBone(root, 'hips'),
    spine: findBone(root, 'spine'),
    head: findBone(root, 'head'),
    rightArm: findBone(root, 'rightArm'),
    rightForeArm: findBone(root, 'rightForeArm'),
    rightHand: findBone(root, 'rightHand'),
    leftArm: findBone(root, 'leftArm'),
    leftForeArm: findBone(root, 'leftForeArm'),
    leftHand: findBone(root, 'leftHand'),
    rightUpLeg: findBone(root, 'rightUpLeg'),
    rightLeg: findBone(root, 'rightLeg'),
    leftUpLeg: findBone(root, 'leftUpLeg'),
    leftLeg: findBone(root, 'leftLeg'),
  };
  
  // Apply player color to materials
  const playerColor = PLAYER_COLORS[colorIndex % PLAYER_COLORS.length];
  root.traverse((child) => {
    if (child.isMesh && child.material) {
      // Clone material to avoid affecting other instances
      child.material = child.material.clone();
    }
  });

  // Create weapon socket on right hand
  const weaponSocket = createWeaponSocket(bones.rightHand);

  // Attach weapon container to socket.
  // The procedural weapon parts are sized for the FP view (~0.08–0.4 units).
  // The full body is 1.7 units tall, so we scale up so the gun looks right.
  const weaponGroup = buildWeaponContainer();
  weaponGroup.name = 'weapon';
  weaponGroup.scale.setScalar(2.2); // make gun visible at body scale
  weaponGroup.visible = true; // Ensure weapon is visible
  weaponSocket.add(weaponGroup);
  
  // Make sure the weapon socket is visible
  weaponSocket.visible = true;

  // Create animator
  const animator = new AvatarAnimator(root, animationClips);
  animator.play('idle');
  
  // Return compatible structure
  return {
    root,
    joints: bones,
    weaponAnchor: weaponGroup,
    animator
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Build a simple 3-part gun mesh
// ─────────────────────────────────────────────────────────────────────────────
export function buildWeapon() {
  const group = new THREE.Group();

  // Body / receiver
  const body = new THREE.Mesh(box(0.08, 0.08, 0.38), WEAPON_MAT.metal);
  body.position.z = 0;
  group.add(body);

  // Barrel
  const barrel = new THREE.Mesh(box(0.04, 0.04, 0.24), WEAPON_MAT.barrel);
  barrel.position.set(0, 0.03, -0.28);
  group.add(barrel);

  // Stock
  const stock = new THREE.Mesh(box(0.06, 0.1, 0.14), WEAPON_MAT.stock);
  stock.position.set(0, -0.02, 0.22);
  group.add(stock);

  // Magazine
  const mag = new THREE.Mesh(box(0.055, 0.12, 0.07), WEAPON_MAT.metal);
  mag.position.set(0, -0.1, 0.0);
  group.add(mag);

  // Sight
  const sight = new THREE.Mesh(box(0.03, 0.03, 0.07), WEAPON_MAT.barrel);
  sight.position.set(0, 0.07, -0.04);
  group.add(sight);

  return group;
}

export function buildWeaponContainer() {
  const container = new THREE.Group();
  container.name = 'weapon-container';

  // 1. AR model (procedural)
  const arGroup = buildWeapon();
  arGroup.name = 'ar-model';
  container.add(arGroup);

  // 2. Sniper model (GLB) - default to midnight skin
  const sniperGroup = new THREE.Group();
  sniperGroup.name = 'sniper-model';
  sniperGroup.visible = false;
  sniperGroup.position.set(0, 0, -0.05);
  sniperGroup.userData.skinId = 'sniper_midnight'; // Default skin
  container.add(sniperGroup);

  // If GLB template is already loaded, add it immediately
  if (sniperGlbTemplates['sniper_midnight']) {
    sniperGroup.add(sniperGlbTemplates['sniper_midnight'].clone());
  } else {
    // Register this group to be updated when GLB loads
    if (!sniperModelGroups['sniper_midnight']) sniperModelGroups['sniper_midnight'] = [];
    sniperModelGroups['sniper_midnight'].push(sniperGroup);
  }

  return container;
}

// Update weapon skin based on equipped skin
export function updateWeaponSkin(container, weaponType, skinId) {
  if (weaponType !== 'sniper') return;
  
  const sniperGroup = container.children.find(child => child.name === 'sniper-model');
  if (!sniperGroup) return;

  // Remove old model
  while (sniperGroup.children.length > 0) {
    sniperGroup.remove(sniperGroup.children[0]);
  }

  // Load and add new model
  if (sniperGlbTemplates[skinId]) {
    sniperGroup.add(sniperGlbTemplates[skinId].clone());
  } else {
    // Load the new skin
    loadSniperModel(skinId, (model) => {
      sniperGroup.add(model);
    });
  }
  
  sniperGroup.userData.skinId = skinId;
}

// ─────────────────────────────────────────────────────────────────────────────
// Build first-person hands + weapon (visible only to local player)
// Uses Mixamo character arms instead of blocky meshes
// ─────────────────────────────────────────────────────────────────────────────
export function buildFPHands() {
  // ── Dedicated FPS view model ──────────────────────────────────────────────
  // This is a completely separate model from the world body (which stays intact
  // for third-person and networking). It is parented directly to the camera.
  // Now shows ONLY the weapon, no arms visible.

  const group = new THREE.Group();
  group.name = 'fp-viewmodel';

  // ── Weapon container (centered, no arms) ──────────────────────────────────
  const weaponGroup = buildWeaponContainer();
  weaponGroup.name = 'weapon';
  // Position weapon in lower-right area, angled to not block view
  weaponGroup.position.set(0.25, -0.25, -0.5);
  weaponGroup.rotation.set(0.1, -0.2, 0.05);
  group.add(weaponGroup);

  // ── Dummy animator (no mixer needed — this model has no rig) ──────────────
  const animator = {
    play:  () => {},
    update: () => {},
    currentState: 'idle',
  };

  return { group, weapon: weaponGroup, animator, root: group };
}

// ─────────────────────────────────────────────────────────────────────────────
// Animate avatar using AnimationMixer based on player state.
// animState shape:
//   { speed, isGrounded, velocityY, isShooting?, isReloading? }
// ─────────────────────────────────────────────────────────────────────────────
export function animateAvatar(avatarData, animState, delta) {
  const { animator } = avatarData;
  if (!animator) return;

  const { speed, isGrounded } = animState;

  // ── High-priority one-shot overrides (shoot / reload) ────────────────────
  // These trigger once per event; the animator handles fading them out.
  if (animState.triggerShoot) {
    animator.triggerOverride?.('shoot', 0.05);
    animState.triggerShoot = false;
  }
  if (animState.triggerReload) {
    animator.triggerOverride?.('reload', 0.1);
    animState.triggerReload = false;
  }

  // ── Base looping animation (locomotion / stance) ─────────────────────────
  let targetAnim = 'idle';

  if (!isGrounded) {
    // In the air — jump on the way up, fall on the way down
    targetAnim = (animState.velocityY ?? 0) > 0 ? 'jump' : 'fall';
  } else if (speed > 4.0) {
    // Sprinting
    targetAnim = 'run';
  } else if (speed > 0.1) {
    // Walking
    targetAnim = 'walk';
  }

  // Play looping base animation with cross-fade
  animator.play(targetAnim, 0.2);

  // Advance the mixer
  animator.update(delta);
}

// ─────────────────────────────────────────────────────────────────────────────
// Create a floating username label (Sprite, auto-billboards toward camera).
// Caller should set sprite.position.y = ~2.0 relative to avatar root.
// Pass kills >= 0 to show a kill-count badge next to the name.
// ─────────────────────────────────────────────────────────────────────────────
export function createUsernameLabel(username, kills = -1) {
  const W = 380, H = 72;
  const canvas = document.createElement('canvas');
  canvas.width  = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');

  // Background pill
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = 'rgba(0, 0, 0, 0.70)';
  _roundRect(ctx, 6, 6, W - 12, H - 12, 14);
  ctx.fill();

  // Thin accent border
  ctx.strokeStyle = 'rgba(255,140,60,0.55)';
  ctx.lineWidth = 1.5;
  _roundRect(ctx, 6, 6, W - 12, H - 12, 14);
  ctx.stroke();

  if (kills >= 0) {
    // ── Kill badge on the right ──────────────────────────────────────────────
    const badgeW = 68;
    const badgeX = W - badgeW - 10;

    // Gold badge background
    ctx.fillStyle = 'rgba(255, 185, 0, 0.22)';
    _roundRect(ctx, badgeX, 10, badgeW, H - 20, 8);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,185,0,0.65)';
    ctx.lineWidth = 1.2;
    _roundRect(ctx, badgeX, 10, badgeW, H - 20, 8);
    ctx.stroke();

    // Star + count
    ctx.fillStyle = '#ffd700';
    ctx.font      = 'bold 22px Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.shadowColor  = 'rgba(255,200,0,0.6)';
    ctx.shadowBlur   = 6;
    ctx.fillText(`★${kills}`, badgeX + badgeW / 2, H / 2);

    // Username text (left portion)
    ctx.shadowColor  = 'rgba(255,100,0,0.4)';
    ctx.shadowBlur   = 8;
    ctx.fillStyle = '#ffffff';
    ctx.font      = 'bold 28px Arial, sans-serif';
    ctx.textAlign = 'center';
    const nameAreaW = badgeX - 10;
    let text = username;
    if (ctx.measureText(text).width > nameAreaW - 16) {
      while (ctx.measureText(text + '…').width > nameAreaW - 16 && text.length > 1) {
        text = text.slice(0, -1);
      }
      text += '…';
    }
    ctx.fillText(text, nameAreaW / 2 + 6, H / 2);
  } else {
    // ── Name only (no badge) ─────────────────────────────────────────────────
    ctx.fillStyle = '#ffffff';
    ctx.font      = 'bold 28px Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.shadowColor  = 'rgba(255,100,0,0.4)';
    ctx.shadowBlur   = 8;
    let text = username;
    if (ctx.measureText(text).width > W - 28) {
      while (ctx.measureText(text + '…').width > W - 28 && text.length > 1) {
        text = text.slice(0, -1);
      }
      text += '…';
    }
    ctx.fillText(text, W / 2, H / 2);
  }

  const texture  = new THREE.CanvasTexture(canvas);
  const material = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    depthTest: false,
    sizeAttenuation: true,
  });
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(2.4, 0.54, 1);
  return sprite;
}

// ─────────────────────────────────────────────────────────────────────────────
// Rebuild an existing username-label sprite texture in-place.
// Call this whenever a player's kill count changes.
// ─────────────────────────────────────────────────────────────────────────────
export function updateUsernameLabel(sprite, username, kills = 0) {
  if (!sprite || !sprite.material) return;

  const W = 380, H = 72;
  const canvas = document.createElement('canvas');
  canvas.width  = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');

  // Reuse createUsernameLabel's drawing logic via a temporary sprite
  const tmp = createUsernameLabel(username, kills);
  // Swap the texture
  const oldMap = sprite.material.map;
  sprite.material.map = tmp.material.map;
  sprite.material.needsUpdate = true;
  if (oldMap) oldMap.dispose();
  tmp.material.dispose();
}

function _roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}
