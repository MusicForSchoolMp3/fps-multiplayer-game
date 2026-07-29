// ─── AvatarManager.js ───────────────────────────────────────────────────────
// Procedurally builds a rigged humanoid 3D avatar with a weapon attached to hands.
// Local player: only first-person hands + gun visible.
// Remote players: full body renders with joint animation.

import * as THREE from 'three';

// ── Shared geometry / material cache ─────────────────────────────────────────
const GEO_CACHE = {};
function box(w, h, d) {
  const k = `${w},${h},${d}`;
  if (!GEO_CACHE[k]) GEO_CACHE[k] = new THREE.BoxGeometry(w, h, d);
  return GEO_CACHE[k];
}

const MAT = {
  skin:    new THREE.MeshLambertMaterial({ color: 0xd4956a }),
  cloth:   new THREE.MeshLambertMaterial({ color: 0x2a3a5c }),
  boot:    new THREE.MeshLambertMaterial({ color: 0x1a1a22 }),
  metal:   new THREE.MeshLambertMaterial({ color: 0x4a4a50 }),
  barrel:  new THREE.MeshLambertMaterial({ color: 0x222226 }),
  stock:   new THREE.MeshLambertMaterial({ color: 0x5c3a1e }),
  local:   new THREE.MeshLambertMaterial({ color: 0x2a3a5c, transparent: true, opacity: 0.0 }), // hidden body
  localSkin: new THREE.MeshLambertMaterial({ color: 0xd4956a }),
};

// colours per player slot
const PLAYER_COLORS = [0xff4444, 0x44aaff, 0x44ff88, 0xffcc44, 0xcc44ff, 0xff8844];

// ─────────────────────────────────────────────────────────────────────────────
// Build a complete humanoid rig (group with named joints)
// Returns: { root, joints:{}, weaponAnchor }
// ─────────────────────────────────────────────────────────────────────────────
export function buildHumanoid(colorIndex = 0, isLocal = false) {
  const root = new THREE.Group();
  root.name = 'avatar-root';
  
  // Offset root so feet are at ground level when positioned at y=0
  // Foot bottom is at y=-0.70 relative to root, so raise root by 0.70
  root.position.y = 0.70;

  const accentMat = new THREE.MeshLambertMaterial({
    color: PLAYER_COLORS[colorIndex % PLAYER_COLORS.length],
  });

  // Helper to make a mesh
  const mesh = (geo, mat) => {
    const m = new THREE.Mesh(geo, mat);
    m.castShadow = false;
    return m;
  };

  // ── Torso ──────────────────────────────────────────────────────────────────
  const torsoGroup = new THREE.Group();
  torsoGroup.name = 'torso';
  torsoGroup.position.y = 0.68;
  const torsoMesh = mesh(box(0.5, 0.6, 0.25), isLocal ? MAT.local : MAT.cloth);
  torsoMesh.position.y = 0.3;
  // Accent stripe
  const stripe = mesh(box(0.51, 0.08, 0.26), accentMat);
  stripe.position.y = 0.38;
  torsoGroup.add(torsoMesh, stripe);
  root.add(torsoGroup);

  // ── Head ──────────────────────────────────────────────────────────────────
  const headGroup = new THREE.Group();
  headGroup.name = 'head';
  headGroup.position.y = 0.75;
  const headMesh = mesh(box(0.35, 0.35, 0.32), isLocal ? MAT.local : MAT.skin);
  headMesh.position.y = 0.175;
  headGroup.add(headMesh);
  torsoGroup.add(headGroup);

  // ── Upper-arms ────────────────────────────────────────────────────────────
  const makeArm = (side) => {
    const sign = side === 'R' ? 1 : -1;
    const upperGroup = new THREE.Group();
    upperGroup.name = `upper-arm-${side}`;
    upperGroup.position.set(sign * 0.32, 0.48, 0);

    const upper = mesh(box(0.14, 0.28, 0.14), isLocal ? MAT.local : MAT.cloth);
    upper.position.y = -0.14;
    upperGroup.add(upper);

    // forearm (pivot at elbow)
    const foreGroup = new THREE.Group();
    foreGroup.name = `forearm-${side}`;
    foreGroup.position.y = -0.28;

    const fore = mesh(box(0.12, 0.26, 0.12), isLocal ? MAT.local : MAT.skin);
    fore.position.y = -0.13;
    foreGroup.add(fore);

    // hand
    const handGroup = new THREE.Group();
    handGroup.name = `hand-${side}`;
    handGroup.position.y = -0.26;
    const hand = mesh(box(0.12, 0.1, 0.1), isLocal ? MAT.local : MAT.skin);
    hand.position.y = -0.05;
    handGroup.add(hand);
    foreGroup.add(handGroup);

    upperGroup.add(foreGroup);
    torsoGroup.add(upperGroup);
    return { upperGroup, foreGroup, handGroup };
  };

  const armR = makeArm('R');
  const armL = makeArm('L');

  // ── Legs ──────────────────────────────────────────────────────────────────
  const makeLeg = (side) => {
    const sign = side === 'R' ? 1 : -1;
    const upperGroup = new THREE.Group();
    upperGroup.name = `upper-leg-${side}`;
    upperGroup.position.set(sign * 0.14, 0.0, 0);

    const upper = mesh(box(0.18, 0.32, 0.18), isLocal ? MAT.local : accentMat);
    upper.position.y = -0.16;
    upperGroup.add(upper);

    const lowerGroup = new THREE.Group();
    lowerGroup.name = `lower-leg-${side}`;
    lowerGroup.position.y = -0.32;

    const lower = mesh(box(0.15, 0.3, 0.15), isLocal ? MAT.local : MAT.cloth);
    lower.position.y = -0.15;
    lowerGroup.add(lower);

    const foot = mesh(box(0.15, 0.08, 0.22), isLocal ? MAT.local : MAT.boot);
    foot.position.set(0, -0.34, 0.04);
    lowerGroup.add(foot);

    upperGroup.add(lowerGroup);
    torsoGroup.add(upperGroup);
    return { upperGroup, lowerGroup };
  };

  const legR = makeLeg('R');
  const legL = makeLeg('L');

  // ── Weapon ────────────────────────────────────────────────────────────────
  const weaponGroup = buildWeapon();
  weaponGroup.name = 'weapon';

  // Attach weapon to right hand
  armR.handGroup.add(weaponGroup);
  weaponGroup.position.set(-0.06, -0.08, -0.22);
  weaponGroup.rotation.set(0, Math.PI, 0);

  // Expose anchor for first-person hands
  const weaponAnchor = weaponGroup;

  // Named joint map for animation
  const joints = {
    torso: torsoGroup,
    head: headGroup,
    upperArmR: armR.upperGroup,
    forearmR: armR.foreGroup,
    handR: armR.handGroup,
    upperArmL: armL.upperGroup,
    forearmL: armL.foreGroup,
    handL: armL.handGroup,
    upperLegR: legR.upperGroup,
    lowerLegR: legR.lowerGroup,
    upperLegL: legL.upperGroup,
    lowerLegL: legL.lowerGroup,
  };

  return { root, joints, weaponAnchor };
}

// ─────────────────────────────────────────────────────────────────────────────
// Build a simple 3-part gun mesh
// ─────────────────────────────────────────────────────────────────────────────
export function buildWeapon() {
  const group = new THREE.Group();

  // Body / receiver
  const body = new THREE.Mesh(box(0.08, 0.08, 0.38), MAT.metal);
  body.position.z = 0;
  group.add(body);

  // Barrel
  const barrel = new THREE.Mesh(box(0.04, 0.04, 0.24), MAT.barrel);
  barrel.position.set(0, 0.03, -0.28);
  group.add(barrel);

  // Stock
  const stock = new THREE.Mesh(box(0.06, 0.1, 0.14), MAT.stock);
  stock.position.set(0, -0.02, 0.22);
  group.add(stock);

  // Magazine
  const mag = new THREE.Mesh(box(0.055, 0.12, 0.07), MAT.metal);
  mag.position.set(0, -0.1, 0.0);
  group.add(mag);

  // Sight
  const sight = new THREE.Mesh(box(0.03, 0.03, 0.07), MAT.barrel);
  sight.position.set(0, 0.07, -0.04);
  group.add(sight);

  return group;
}

// ─────────────────────────────────────────────────────────────────────────────
// Build first-person hands + weapon (visible only to local player)
// ─────────────────────────────────────────────────────────────────────────────
export function buildFPHands() {
  const group = new THREE.Group();

  // Right forearm
  const foreR = new THREE.Mesh(box(0.1, 0.22, 0.1), MAT.localSkin);
  foreR.position.set(0.2, -0.18, -0.35);
  foreR.rotation.x = -0.15;
  group.add(foreR);

  // Left forearm
  const foreL = new THREE.Mesh(box(0.1, 0.22, 0.1), MAT.localSkin);
  foreL.position.set(-0.13, -0.2, -0.38);
  foreL.rotation.x = -0.15;
  group.add(foreL);

  // Right hand
  const handR = new THREE.Mesh(box(0.1, 0.09, 0.09), MAT.localSkin);
  handR.position.set(0.2, -0.28, -0.41);
  group.add(handR);

  // Left hand
  const handL = new THREE.Mesh(box(0.1, 0.09, 0.09), MAT.localSkin);
  handL.position.set(-0.13, -0.3, -0.43);
  group.add(handL);

  // Weapon
  const weapon = buildWeapon();
  weapon.position.set(0.04, -0.26, -0.52);
  weapon.rotation.set(0.05, 0, 0);
  group.add(weapon);

  return { group, weapon };
}

// ─────────────────────────────────────────────────────────────────────────────
// Animate remote player avatar based on velocity and pose data
// ─────────────────────────────────────────────────────────────────────────────
export function animateAvatar(joints, animState, delta) {
  const { speed, isGrounded, pitch } = animState;
  const t = animState.time || 0;
  animState.time = t + delta;

  const walkFreq = 8;
  const walkAmp = speed > 0.5 ? Math.min(speed / 5, 0.6) : 0;

  const walk = Math.sin(animState.time * walkFreq);

  // Leg swing
  joints.upperLegR.rotation.x = walk * walkAmp;
  joints.upperLegL.rotation.x = -walk * walkAmp;

  // Knee bend (lower legs) - clamp to prevent ground clipping
  joints.lowerLegR.rotation.x = Math.min(Math.abs(walk) * walkAmp * 0.5, 0.8);
  joints.lowerLegL.rotation.x = Math.min(Math.abs(-walk) * walkAmp * 0.5, 0.8);

  // Arm swing (opposite to legs)
  joints.upperArmR.rotation.x = THREE.MathUtils.lerp(
    joints.upperArmR.rotation.x, -walk * walkAmp * 0.6 - 0.2, 0.2
  );
  joints.upperArmL.rotation.x = THREE.MathUtils.lerp(
    joints.upperArmL.rotation.x, walk * walkAmp * 0.6 - 0.2, 0.2
  );

  // Arms raised to hold gun
  joints.upperArmR.rotation.x += -0.35;
  joints.forearmR.rotation.x = -0.35;
  joints.upperArmL.rotation.x += -0.3;
  joints.forearmL.rotation.x = -0.3;

  // Head follows vertical aim
  if (pitch !== undefined) {
    joints.head.rotation.x = THREE.MathUtils.lerp(joints.head.rotation.x, pitch, 0.15);
  }

  // Body bob when walking
  if (joints.torso && walkAmp > 0.05) {
    joints.torso.position.y = Math.sin(animState.time * walkFreq * 2) * 0.015;
  } else {
    joints.torso.position.y = THREE.MathUtils.lerp(joints.torso.position.y, 0, 0.1);
  }
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
