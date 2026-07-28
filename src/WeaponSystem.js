// ─── WeaponSystem.js ──────────────────────────────────────────────────────────
// Manages local player weapon: ammo, reload, shoot raycasting, UI update.

import * as THREE from 'three';

// Weapon configurations
const WEAPONS = {
  ar: {
    name: 'AR',
    maxAmmo: 30,
    reserveMax: 90,
    reloadTime: 2.0,
    fireRate: 0.1,
    damage: 25,
    maxRange: 120
  },
  sniper: {
    name: 'Sniper',
    maxAmmo: 1,
    reserveMax: 10,
    reloadTime: 2.5,
    fireRate: 0.15,
    damage: 100,
    maxRange: 200
  }
};

export class WeaponSystem {
  constructor(camera, scene, net, controller, ui, isThirdPersonRef, localBodyAvatarRef) {
    this.camera     = camera;
    this.scene      = scene;
    this.net        = net;
    this.controller = controller;
    this.ui         = ui;
    this.isThirdPersonRef = isThirdPersonRef;
    this.localBodyAvatarRef = localBodyAvatarRef;

    // Current weapon
    this.currentWeapon = 'ar';
    this._loadWeapon('ar');

    this.isReloading = false;
    this._reloadTimer = 0;
    this._fireTimer   = 0;
    this._mouseDown   = false;
    this._rightMouseDown = false;

    // Zoom state
    this.isZoomed = false;
    this.baseFov = camera.fov;

    // Raycaster
    this._raycaster = new THREE.Raycaster();
    this._center    = new THREE.Vector2(0, 0);

    // Tracers list: [{line, life}]
    this._tracers = [];

    // Map objects for bullet collision
    this.mapMeshes = [];

    this._setupInput();
    this._updateUI();
  }

  _loadWeapon(weaponKey) {
    const config = WEAPONS[weaponKey];
    this.ammo = config.maxAmmo;
    this.reserve = config.reserveMax;
    this.reloadTime = config.reloadTime;
    this.fireRate = config.fireRate;
    this.damage = config.damage;
    this.maxRange = config.maxRange;
  }

  switchWeapon(weaponKey) {
    if (this.currentWeapon === weaponKey) return;
    this.currentWeapon = weaponKey;
    this._loadWeapon(weaponKey);
    this.isReloading = false;
    this._reloadTimer = 0;
    this._updateUI();
  }

  setMapMeshes(meshes) {
    this.mapMeshes = meshes || [];
  }

  _setupInput() {
    document.addEventListener('mousedown', (e) => {
      if (e.button === 0) this._mouseDown = true;
      if (e.button === 2) this._rightMouseDown = true;
    });
    document.addEventListener('mouseup', (e) => {
      if (e.button === 0) this._mouseDown = false;
      if (e.button === 2) this._rightMouseDown = false;
    });
    document.addEventListener('keydown', (e) => {
      if (e.code === 'KeyR' && !this.isReloading) this._startReload();
    });
  }

  update(delta, isLocked, isAlive) {
    this._fireTimer  = Math.max(0, this._fireTimer  - delta);
    this._reloadTimer = Math.max(0, this._reloadTimer - delta);

    // Finish reload
    if (this.isReloading && this._reloadTimer <= 0) {
      const config = WEAPONS[this.currentWeapon];
      const needed = config.maxAmmo - this.ammo;
      const give   = Math.min(needed, this.reserve);
      this.ammo   += give;
      this.reserve -= give;
      this.isReloading = false;
      if (this.ui.reloadEl) this.ui.reloadEl.style.display = 'none';
      this._updateUI();
    }

    // Auto-reload on empty mag
    if (this.ammo === 0 && !this.isReloading && this.reserve > 0) {
      this._startReload();
    }

    // Shoot
    if (this._mouseDown && isLocked && isAlive && !this.isReloading &&
        this.ammo > 0 && this._fireTimer <= 0) {
      this._shoot();
    }

    // Sniper zoom on right-click hold
    if (this.currentWeapon === 'sniper' && isLocked) {
      const targetFov = this._rightMouseDown ? 20 : this.baseFov;
      this.camera.fov = THREE.MathUtils.lerp(this.camera.fov, targetFov, 10 * delta);
      this.camera.updateProjectionMatrix();
      
      // Toggle vignette
      const vignette = document.getElementById('sniper-vignette');
      if (vignette) {
        if (this._rightMouseDown) {
          vignette.classList.add('active');
        } else {
          vignette.classList.remove('active');
        }
      }
    }

    // Decay tracers
    this._tracers = this._tracers.filter(({ line, life }) => {
      line.material.opacity -= delta * 6;
      if (line.material.opacity <= 0) {
        this.scene.remove(line);
        return false;
      }
      return true;
    });
  }

  _shoot() {
    this.ammo--;
    this._fireTimer = this.fireRate;
    this.controller.applyRecoil(0.022);
    this._updateUI();

    // Calculate shoot origin based on view mode
    let origin, dir;
    
    if (this.isThirdPersonRef && this.isThirdPersonRef()) {
      // Third-person: shoot from gun tip using camera direction directly
      const avatar = this.localBodyAvatarRef && this.localBodyAvatarRef();
      if (avatar && avatar.root) {
        // Find the weapon in the avatar hierarchy
        let weaponMesh = null;
        avatar.root.traverse((child) => {
          if (child.name === 'weapon') {
            weaponMesh = child;
          }
        });
        
        if (weaponMesh) {
          // Get world position of weapon
          const weaponWorldPos = new THREE.Vector3();
          weaponMesh.getWorldPosition(weaponWorldPos);
          
          // Use camera direction directly - bullets go where crosshair points
          this._raycaster.setFromCamera(this._center, this.camera);
          origin = weaponWorldPos;
          dir = this._raycaster.ray.direction.clone();
          
          this._raycaster.set(origin, dir);
        } else {
          // Fallback to camera if weapon not found
          this._raycaster.setFromCamera(this._center, this.camera);
          origin = this._raycaster.ray.origin.clone();
          dir = this._raycaster.ray.direction.clone();
        }
      } else {
        // Fallback to camera if avatar not available
        this._raycaster.setFromCamera(this._center, this.camera);
        origin = this._raycaster.ray.origin.clone();
        dir = this._raycaster.ray.direction.clone();
      }
    } else {
      // First-person: raycast from camera center
      this._raycaster.setFromCamera(this._center, this.camera);
      origin = this._raycaster.ray.origin.clone();
      dir = this._raycaster.ray.direction.clone();
    }

    // Collect remote player meshes (hit detection)
    const targets = [];
    for (const [id, rp] of this.remotePlayers) {
      targets.push({ id, mesh: rp.root });
    }
    const meshes = targets.map(t => t.mesh);
    // Also collect all descendant meshes
    const allMeshes = [];
    meshes.forEach(m => m.traverse(c => { if (c.isMesh) allMeshes.push(c); }));

    // Build a map mesh -> playerId
    const meshToId = new Map();
    for (const { id, mesh } of targets) {
      mesh.traverse(c => { if (c.isMesh) meshToId.set(c, id); });
    }

    // Combine player meshes and map object meshes for raycasting
    const raycastTargets = [...allMeshes, ...this.mapMeshes];

    const hits = this._raycaster.intersectObjects(raycastTargets, false);

    let hitId   = null;
    let hitPoint = null;
    let hitDist  = this.maxRange;

    if (hits.length > 0 && hits[0].distance < this.maxRange) {
      const hitObj = hits[0].object;
      hitPoint = hits[0].point;
      hitDist  = hits[0].distance;
      // Check if the closest hit object belongs to a player
      if (meshToId.has(hitObj)) {
        hitId = meshToId.get(hitObj);
      }
    }

    // Tracer endpoint
    const endPt  = hitPoint || origin.clone().addScaledVector(dir, this.maxRange);

    this._spawnTracer(origin, endPt);

    // Network
    this.net.sendShoot({
      origin: { x: origin.x, y: origin.y, z: origin.z },
      dir:    { x: dir.x,    y: dir.y,    z: dir.z    },
      hitId,
      damage: this.damage,
    });

    if (hitId) {
      this.ui.showHitmarker();
    }
  }

  _startReload() {
    const config = WEAPONS[this.currentWeapon];
    if (this.reserve <= 0 || this.ammo === config.maxAmmo) return;
    this.isReloading   = true;
    this._reloadTimer  = config.reloadTime;
    if (this.ui.reloadEl) this.ui.reloadEl.style.display = 'block';
  }

  _spawnTracer(from, to) {
    const mat = new THREE.LineBasicMaterial({
      color: 0xffd080,
      transparent: true,
      opacity: 0.85,
    });
    const geo = new THREE.BufferGeometry().setFromPoints([from, to]);
    const line = new THREE.Line(geo, mat);
    this.scene.add(line);
    this._tracers.push({ line, life: 1 });
  }

  _updateUI() {
    if (this.ui.ammoEl)    this.ui.ammoEl.textContent    = this.ammo;
    if (this.ui.reserveEl) this.ui.reserveEl.textContent = this.reserve;
    if (this.ui.weaponEl)  this.ui.weaponEl.textContent  = WEAPONS[this.currentWeapon].name;
  }
}
