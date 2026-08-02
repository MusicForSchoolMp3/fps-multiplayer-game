// ─── SkinManager.js ─────────────────────────────────────────────────────────
// Manages weapon skins, previews, and skin selection modal UI.

import * as THREE from 'three';
import { buildHumanoid, buildWeaponContainer, setWeaponType } from './AvatarManager.js';

export const SKINS_CONFIG = {
  ar: [
    {
      id: 'ar_default',
      name: 'Standard Issue AR',
      type: 'default',
      desc: 'Standard tactical assault rifle issued to all combat operatives.',
      badge: 'DEFAULT',
      color: '#44aaff'
    },
    {
      id: 'ar_custom_slot1',
      name: 'Custom AR GLB (Slot 1)',
      type: 'placeholder',
      desc: 'Reserved for future custom AR GLB model skin.',
      badge: 'COMING SOON',
      color: '#ff8844'
    }
  ],
  sniper: [
    {
      id: 'sniper_midnight',
      name: 'Midnight Precision GLB',
      type: 'glb',
      url: '/sniper skins GLB/Meshy_AI_Midnight_Precision_Ri_0801152731_generate.glb',
      desc: 'Tactical high-grade precision GLB sniper rifle with sleek midnight finish.',
      badge: 'FEATURED',
      color: '#cc44ff'
    },
    {
      id: 'sniper_default',
      name: 'Classic Blocky Sniper',
      type: 'default',
      desc: 'Original classic blocky sniper rifle.',
      badge: 'CLASSIC',
      color: '#888888'
    },
    {
      id: 'sniper_custom_slot1',
      name: 'Custom Sniper GLB (Slot 1)',
      type: 'placeholder',
      desc: 'Reserved for future custom Sniper GLB model skin.',
      badge: 'COMING SOON',
      color: '#ff8844'
    }
  ]
};

// Local storage for equipped skins
const equippedSkins = {
  ar: localStorage.getItem('equipped_skin_ar') || 'ar_default',
  sniper: localStorage.getItem('equipped_skin_sniper') || 'sniper_midnight'
};

export function getEquippedSkin(weaponType) {
  return equippedSkins[weaponType] || (weaponType === 'sniper' ? 'sniper_midnight' : 'ar_default');
}

export function setEquippedSkin(weaponType, skinId) {
  equippedSkins[weaponType] = skinId;
  localStorage.setItem(`equipped_skin_${weaponType}`, skinId);
}

// ── 3D Character Preview (Left side of main menu) ────────────────────────────
export class MenuAvatarPreview {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    const w = canvas.clientWidth || 300;
    const h = canvas.clientHeight || 380;
    this.renderer.setSize(w, h, false);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(38, w / h, 0.1, 100);
    this.camera.position.set(0, 1.15, 3.1);
    this.camera.lookAt(0, 0.9, 0);

    const amb = new THREE.AmbientLight(0xffffff, 1.3);
    const dir1 = new THREE.DirectionalLight(0xff8844, 2.5);
    dir1.position.set(2, 4, 3);
    const dir2 = new THREE.DirectionalLight(0x44aaff, 1.8);
    dir2.position.set(-2, 2, -2);
    this.scene.add(amb, dir1, dir2);

    this.avatarRoot = null;
    this.weaponAnchor = null;
    this.joints = null;
    this.animTime = 0;
    this.isRunning = false;

    // Load avatar asynchronously
    this.loadAvatar();
  }

  async loadAvatar() {
    try {
      const { root, joints, weaponAnchor, animator } = await buildHumanoid(0, false);
      this.avatarRoot = root;
      this.weaponAnchor = weaponAnchor;
      this.joints = joints;
      this.animator = animator;
      this.scene.add(root);

      // Start idle animation
      if (animator) {
        animator.play('idle');
      }
    } catch (err) {
      console.error('Failed to load menu avatar:', err);
    }
  }

  updateWeapon(weaponType) {
    if (this.weaponAnchor) {
      setWeaponType(this.weaponAnchor, weaponType);
    }
  }

  start() {
    if (this.isRunning) return;
    this.isRunning = true;
    let lastTime = performance.now();
    const loop = (now) => {
      if (!this.isRunning) return;
      const dt = (now - lastTime) / 1000;
      lastTime = now;
      this.animTime += dt;

      if (this.avatarRoot) {
        this.avatarRoot.rotation.y = Math.sin(this.animTime * 0.6) * 0.4 + 0.15;
      }
      // Update animator for idle animation
      if (this.animator) {
        this.animator.update(dt);
      }
      this.renderer.render(this.scene, this.camera);
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  stop() {
    this.isRunning = false;
  }
}

// ── 3D Skin Previewer (Inside Skins Manager Modal) ───────────────────────────
export class SkinPreviewer {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    const w = canvas.clientWidth || 340;
    const h = canvas.clientHeight || 340;
    this.renderer.setSize(w, h, false);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(40, w / h, 0.1, 100);
    this.camera.position.set(0, 0, 1.4);
    this.camera.lookAt(0, 0, 0);

    const amb = new THREE.AmbientLight(0xffffff, 1.4);
    const dir1 = new THREE.DirectionalLight(0xffaa44, 2.5);
    dir1.position.set(2, 3, 3);
    const dir2 = new THREE.DirectionalLight(0x4488ff, 1.8);
    dir2.position.set(-2, -1, -2);
    this.scene.add(amb, dir1, dir2);

    this.weaponContainer = buildWeaponContainer();
    this.scene.add(this.weaponContainer);

    this.animTime = 0;
    this.isRunning = false;
  }

  showWeapon(weaponType) {
    setWeaponType(this.weaponContainer, weaponType);
  }

  start() {
    if (this.isRunning) return;
    this.isRunning = true;
    let lastTime = performance.now();
    const loop = (now) => {
      if (!this.isRunning) return;
      const dt = (now - lastTime) / 1000;
      lastTime = now;
      this.animTime += dt;

      if (this.weaponContainer) {
        this.weaponContainer.rotation.y = this.animTime * 0.7;
        this.weaponContainer.rotation.x = Math.sin(this.animTime * 0.5) * 0.12;
      }
      this.renderer.render(this.scene, this.camera);
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  stop() {
    this.isRunning = false;
  }
}
