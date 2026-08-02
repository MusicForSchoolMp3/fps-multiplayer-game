// ─── AvatarManager.js ───────────────────────────────────────────────────────
// Mixamo-based avatar system with AnimationMixer and weapon attachment.
// Local player: only first-person hands + gun visible.
// Remote players: full body renders with Mixamo animations.

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js';

// ── Sniper GLB Model Preloader ────────────────────────────────────────────────
let sniperGlbTemplate = null;
const sniperCallbacks = [];
const sniperModelGroups = []; // Registry of sniper-model groups waiting for GLB

export function loadSniperModel(onLoad) {
  if (sniperGlbTemplate) {
    if (onLoad) onLoad(sniperGlbTemplate.clone());
    return;
  }
  if (onLoad) sniperCallbacks.push(onLoad);

  if (loadSniperModel.isLoading) return;
  loadSniperModel.isLoading = true;

  const loader = new GLTFLoader();
  const url = '/sniper skins GLB/Meshy_AI_Midnight_Precision_Ri_0801152731_generate.glb';

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
      sniperGlbTemplate = pivot;

      sniperCallbacks.forEach(cb => cb(sniperGlbTemplate.clone()));
      sniperCallbacks.length = 0;

      // Update all registered sniper-model groups
      sniperModelGroups.forEach(group => {
        if (group.children.length === 0) {
          group.add(sniperGlbTemplate.clone());
        }
      });
      sniperModelGroups.length = 0;
    },
    undefined,
    (err) => {
      console.error('Failed to load GLB sniper model:', err);
    }
  );
}

// Trigger early preload
loadSniperModel();

export function setWeaponType(container, type) {
  if (!container) return;
  container.traverse((obj) => {
    if (obj.name === 'ar-model') {
      obj.visible = (type === 'ar');
    }
    if (obj.name === 'sniper-model') {
      obj.visible = (type === 'sniper');
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
  idle: '/NEW character/Characters animations/ar and sniper IDLE.glb',
  walk: '/NEW character/Characters animations/ar and sniper WALK.glb',
  run: '/NEW character/Characters animations/ar and sniper RUN (shift).glb',
  jump: '/NEW character/Characters animations/ar and sniper JUMP (jump up).glb',
  fall: '/NEW character/Characters animations/ar and sniper FALL (jump down).glb',
  shoot: '/NEW character/Characters animations/shoot gun.glb',
  reload: '/NEW character/Characters animations/reload gun.glb',
};

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
        }
        resolve();
      }, undefined, () => resolve()); // Continue on error
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
    this.currentAction = null;
    this.currentState = 'idle';
    this.priorityState = null; // 'shoot' or 'reload' override normal animations
    this.priorityAction = null;
  }
  
  play(name, fadeDuration = 0.2) {
    // Priority animations (shoot/reload) override everything
    if (this.priorityState) return;
    
    if (this.currentState === name && this.currentAction) return;
    
    const clip = this.clips[name];
    if (!clip) {
      console.warn(`Animation not found: ${name}`);
      return;
    }
    
    const newAction = this.mixer.clipAction(clip);
    
    if (this.currentAction) {
      this.currentAction.crossFadeTo(newAction, fadeDuration);
    } else {
      newAction.fadeIn(fadeDuration);
    }
    
    newAction.play();
    this.currentAction = newAction;
    this.currentState = name;
  }
  
  // Force play a priority animation (shoot/reload)
  forcePlay(name, fadeDuration = 0.1) {
    const clip = this.clips[name];
    if (!clip) {
      console.warn(`Animation not found: ${name}`);
      return;
    }
    
    const newAction = this.mixer.clipAction(clip);
    newAction.setLoop(THREE.LoopOnce);
    newAction.clampWhenFinished = true;
    
    if (this.priorityAction) {
      this.priorityAction.crossFadeTo(newAction, fadeDuration);
    } else if (this.currentAction) {
      this.currentAction.crossFadeTo(newAction, fadeDuration);
    } else {
      newAction.fadeIn(fadeDuration);
    }
    
    newAction.play();
    this.priorityAction = newAction;
    this.priorityState = name;
    
    // When animation finishes, return to normal state
    this.mixer.addEventListener('finished', (e) => {
      if (e.action === newAction) {
        this.clearPriority();
      }
    });
  }
  
  clearPriority() {
    this.priorityState = null;
    this.priorityAction = null;
    this.currentState = 'idle'; // Will be updated by next animate call
  }
  
  update(delta) {
    this.mixer.update(delta);
  }
}

// ── Weapon Socket System ───────────────────────────────────────────────────────
function createWeaponSocket(rightHandBone) {
  const socket = new THREE.Object3D();
  socket.name = 'weaponSocket';
  
  if (rightHandBone) {
    socket.position.set(0.06, 0.12, 0.03);
    socket.rotation.set(Math.PI / 2, 0, Math.PI / 2);
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
  
  // Attach weapon container to socket
  const weaponGroup = buildWeaponContainer();
  weaponGroup.name = 'weapon';
  weaponSocket.add(weaponGroup);
  
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

  // 2. Sniper model (GLB)
  const sniperGroup = new THREE.Group();
  sniperGroup.name = 'sniper-model';
  sniperGroup.visible = false;
  sniperGroup.position.set(0, 0, -0.05);
  container.add(sniperGroup);

  // If GLB template is already loaded, add it immediately
  if (sniperGlbTemplate) {
    sniperGroup.add(sniperGlbTemplate.clone());
  } else {
    // Register this group to be updated when GLB loads
    sniperModelGroups.push(sniperGroup);
  }

  return container;
}

// ─────────────────────────────────────────────────────────────────────────────
// Build first-person hands + weapon (visible only to local player)
// Uses Mixamo character arms instead of blocky meshes
// ─────────────────────────────────────────────────────────────────────────────
export function buildFPHands() {
  // ── Dedicated FPS view model ──────────────────────────────────────────────
  // This is a completely separate model from the world body (which stays intact
  // for third-person and networking). It is parented directly to the camera.
  // No GLB clone is used — a separate skinned mesh would always show the full
  // body and is impossible to mask to arms-only without scuffing the geometry.

  const skinMat   = new THREE.MeshLambertMaterial({ color: 0xc68642 }); // skin tone
  const sleeveMat = new THREE.MeshLambertMaterial({ color: 0x1a2a4a }); // dark tactical sleeve

  const group = new THREE.Group();
  group.name = 'fp-viewmodel';

  // ── Helper: build one arm (sleeve + forearm skin + hand) ──────────────────
  function makeArm(side) { // side: 1 = right, -1 = left
    const arm = new THREE.Group();

    // Upper sleeve (wider, clothing colour)
    const sleeve = new THREE.Mesh(
      new THREE.CylinderGeometry(0.042, 0.048, 0.20, 10),
      sleeveMat
    );
    sleeve.rotation.x = Math.PI / 2;
    sleeve.position.z = -0.10;
    arm.add(sleeve);

    // Forearm / wrist (skin colour, slightly narrower)
    const forearm = new THREE.Mesh(
      new THREE.CylinderGeometry(0.032, 0.040, 0.18, 10),
      skinMat
    );
    forearm.rotation.x = Math.PI / 2;
    forearm.position.z = 0.09;
    arm.add(forearm);

    // Hand (flat box)
    const hand = new THREE.Mesh(
      new THREE.BoxGeometry(0.072, 0.040, 0.095),
      skinMat
    );
    hand.position.set(0, -0.004, 0.225);
    arm.add(hand);

    return arm;
  }

  // ── Right arm — weapon hand ────────────────────────────────────────────────
  const rightArm = makeArm(1);
  // Position: lower-right of screen, angled naturally
  rightArm.position.set(0.27, -0.28, -0.38);
  rightArm.rotation.set(0.18, 0.08, 0.04);
  group.add(rightArm);

  // ── Left arm — support hand ────────────────────────────────────────────────
  const leftArm = makeArm(-1);
  leftArm.position.set(-0.21, -0.30, -0.32);
  leftArm.rotation.set(0.14, -0.08, -0.04);
  group.add(leftArm);

  // ── Weapon container attached to right hand position ──────────────────────
  const weaponGroup = buildWeaponContainer();
  weaponGroup.name = 'weapon';
  // Offset so the weapon sits naturally in the hand, angled forward
  weaponGroup.position.set(0, 0.01, 0.12);
  weaponGroup.rotation.set(0, 0, 0);
  rightArm.add(weaponGroup);

  // ── Dummy animator (no mixer needed — this model has no rig) ──────────────
  const animator = {
    play:  () => {},
    update: () => {},
    currentState: 'idle',
  };

  return { group, weapon: weaponGroup, animator, root: group };
}

// ─────────────────────────────────────────────────────────────────────────────
// Animate avatar using AnimationMixer based on player state
// ─────────────────────────────────────────────────────────────────────────────
export function animateAvatar(avatarData, animState, delta) {
  const { animator } = avatarData;
  if (!animator) return;
  
  const { speed, isGrounded, isShooting, isReloading } = animState;
  
  // Priority animations: shoot and reload override everything
  if (isShooting) {
    animator.forcePlay('shoot', 0.1);
    animState.isShooting = false; // Reset after triggering
  } else if (isReloading) {
    animator.forcePlay('reload', 0.1);
    animState.isReloading = false; // Reset after triggering
  } else {
    // Normal animations based on movement state
    let targetAnim = 'idle';
    
    if (!isGrounded) {
      // Jumping or falling
      targetAnim = animState.velocityY > 0 ? 'jump' : 'fall';
    } else if (speed > 4.0) {
      // Sprinting
      targetAnim = 'run';
    } else if (speed > 0.1) {
      // Walking
      targetAnim = 'walk';
    }
    
    // Play animation with cross-fade
    animator.play(targetAnim, 0.2);
  }
  
  // Update mixer
  animator.update(delta);
}

// ─────────────────────────────────────────────────────────────────────────────
// Create a floating username label (Sprite, auto-billboards toward camera).
// Caller should set sprite.position.y = ~2.0 relative to avatar root.
// ─────────────────────────────────────────────────────────────────────────────
export function createUsernameLabel(username) {
  const W = 320, H = 72;
  const canvas = document.createElement('canvas');
  canvas.width  = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');

  // Background pill
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = 'rgba(0, 0, 0, 0.65)';
  _roundRect(ctx, 6, 6, W - 12, H - 12, 12);
  ctx.fill();

  // Thin accent border
  ctx.strokeStyle = 'rgba(255,140,60,0.5)';
  ctx.lineWidth = 1.5;
  _roundRect(ctx, 6, 6, W - 12, H - 12, 12);
  ctx.stroke();

  // Username text
  ctx.fillStyle = '#ffffff';
  ctx.font      = 'bold 28px Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.shadowColor  = 'rgba(255,100,0,0.4)';
  ctx.shadowBlur   = 8;
  // Clamp long names visually
  let text = username;
  if (ctx.measureText(text).width > W - 28) {
    while (ctx.measureText(text + '…').width > W - 28 && text.length > 1) {
      text = text.slice(0, -1);
    }
    text += '…';
  }
  ctx.fillText(text, W / 2, H / 2);

  const texture  = new THREE.CanvasTexture(canvas);
  const material = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    depthTest: false,   // always visible through geometry
    sizeAttenuation: true,
  });
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(2.2, 0.5, 1);
  return sprite;
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
