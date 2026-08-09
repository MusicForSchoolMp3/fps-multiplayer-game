// ─── PlayerController.js ──────────────────────────────────────────────────────
// Handles all local player input, physics movement, camera control (pointer lock),
// and first-person weapon bob.
//
// Movement is raycast-based: the player is treated as a ~0.35m radius capsule
// that sweeps along each movement axis and snaps down onto whatever surface is
// below. Because we raycast against the real meshes (not Box3 AABBs) rotated
// ramps, stairs, low steps and doorways all behave exactly like they look.

import * as THREE from 'three';

const WALK_SPEED   = 5.0;
const SPRINT_SPEED = 9.0;
const JUMP_FORCE   = 7.0;
const GRAVITY      = -22.0;
const EYE_HEIGHT   = 1.65; // metres above feet
const PLAYER_RADIUS = 0.35;
const GROUND_Y     = 0.0;  // baseplate surface

const SNAP_DISTANCE = 0.45; // how far below we can fall-snap onto a surface per frame (also ramp climb rate)
const STEP_HEIGHT   = 0.55; // max ledge height auto-stepped without jumping
const MARGIN        = 0.02; // collision slack

export class PlayerController {
  constructor(camera, domElement) {
    this.camera     = camera;
    this.domElement = domElement;

    // State
    this.location  = new THREE.Vector3(0, EYE_HEIGHT, 0);
    this.momentum  = new THREE.Vector3();
    this.swivel    = 0;   // horizontal look (radians)
    this.lean      = 0;   // vertical look   (radians)
    this.anchored  = true;
    this.isAlive   = true;

    // Keys
    this._keys = { w: false, a: false, s: false, d: false, space: false, shift: false };

    // Mouse sensitivity
    this.sensitivity = 0.0018;
    this.baseSensitivity = 0.0018;
    this.zoomSensitivityMultiplier = 1.0;

    // Bob
    this._bobTime  = 0;
    this._bobAmp   = 0;

    // Head bob toggle setting
    this.enableHeadBob = true;

    // Collision shapes: actual THREE.Mesh objects, raycast against real geometry
    this.hurdles = [];

    // Fallback floor height (used when no surface is found below)
    this.groundY = GROUND_Y;

    // Recoil
    this.recoilPitch = 0;

    this._locked = false;
    this._raycaster = new THREE.Raycaster();

    this._setupListeners();
  }

  setHurdles(meshes) {
    this.hurdles = meshes || [];
    for (const m of this.hurdles) m.updateMatrixWorld(true);
  }

  setGroundY(y) {
    this.groundY = y;
  }

  // ── Public: attach pointer lock ─────────────────────────────────────────────
  lock() {
    this.domElement.requestPointerLock();
  }

  get isLocked() { return this._locked; }

  // ── Input listeners ─────────────────────────────────────────────────────────
  _setupListeners() {
    document.addEventListener('pointerlockchange', () => {
      this._locked = document.pointerLockElement === this.domElement;
    });

    document.addEventListener('mousemove', (e) => {
      if (!this._locked || !this.isAlive) return;
      this.swivel   -= e.movementX * this.sensitivity * this.zoomSensitivityMultiplier;
      this.lean -= e.movementY * this.sensitivity * this.zoomSensitivityMultiplier;
      this.lean  = Math.max(-Math.PI * 0.48, Math.min(Math.PI * 0.48, this.lean));
    });

    document.addEventListener('keydown', (e) => {
      switch (e.code) {
        case 'KeyW':     this._keys.w     = true; break;
        case 'KeyA':     this._keys.a     = true; break;
        case 'KeyS':     this._keys.s     = true; break;
        case 'KeyD':     this._keys.d     = true; break;
        case 'Space':    this._keys.space  = true; break;
        case 'ShiftLeft':
        case 'ShiftRight': this._keys.shift = true; break;
      }
    });

    document.addEventListener('keyup', (e) => {
      switch (e.code) {
        case 'KeyW':     this._keys.w     = false; break;
        case 'KeyA':     this._keys.a     = false; break;
        case 'KeyS':     this._keys.s     = false; break;
        case 'KeyD':     this._keys.d     = false; break;
        case 'Space':    this._keys.space  = false; break;
        case 'ShiftLeft':
        case 'ShiftRight': this._keys.shift = false; break;
      }
    });
  }

  // ── Per-frame update ────────────────────────────────────────────────────────
  update(delta) {
    if (!this.isAlive) return;

    const speed = this._keys.shift ? SPRINT_SPEED : WALK_SPEED;

    // Direction vector from yaw only (not pitch — FPS standard)
    const dir = new THREE.Vector3();
    if (this._keys.w) dir.z -= 1;
    if (this._keys.s) dir.z += 1;
    if (this._keys.a) dir.x -= 1;
    if (this._keys.d) dir.x += 1;

    if (dir.length() > 0) dir.normalize();

    // Rotate direction by yaw
    dir.applyAxisAngle(new THREE.Vector3(0, 1, 0), this.swivel);

    // Apply horizontal velocity ➜ momentum
    this.momentum.x = dir.x * speed;
    this.momentum.z = dir.z * speed;

    // Gravity & jump
    if (this.anchored) {
      if (this._keys.space) {
        this.momentum.y = JUMP_FORCE;
        this.anchored  = false;
      } else {
        this.momentum.y = 0;
      }
    } else {
      this.momentum.y += GRAVITY * delta;
    }

    // Keep world matrices fresh so raycasts follow moved/rotated colliders
    for (const m of this.hurdles) m.updateMatrixWorld(true);

    // ── Movement & Map Collisions ───────────────────────────────────────────
    this._sweepHorizontal(1, this.momentum.x * delta); // X axis
    this._sweepHorizontal(2, this.momentum.z * delta); // Z axis
    this._applyVertical(this.momentum.y * delta);

    // Fallback floor (keeps the player off infinite falls if the floor has no collider)
    if (this.location.y - EYE_HEIGHT < this.groundY) {
      this.location.y = this.groundY + EYE_HEIGHT;
      this.momentum.y = 0;
      this.anchored = true;
    }

    // Clamp to play area boundary (200x200 map, walls at +-100)
    const BOUND = 99.0;
    this.location.x = Math.max(-BOUND, Math.min(BOUND, this.location.x));
    this.location.z = Math.max(-BOUND, Math.min(BOUND, this.location.z));

    // Head-bob calculation
    const hSpeed = Math.sqrt(this.momentum.x ** 2 + this.momentum.z ** 2);
    if (this.enableHeadBob && this.anchored && hSpeed > 0.5) {
      this._bobTime += delta * (this._keys.shift ? 11 : 8);
      this._bobAmp   = THREE.MathUtils.lerp(this._bobAmp, 0.045, 0.12);
    } else {
      this._bobAmp = THREE.MathUtils.lerp(this._bobAmp, 0, 0.1);
    }

    // Decay recoil
    this.recoilPitch = THREE.MathUtils.lerp(this.recoilPitch, 0, 8 * delta);

    // Apply camera rotation & position with head bob (if enabled)
    const bobPitch = this.enableHeadBob ? Math.sin(this._bobTime * 2) * this._bobAmp * 0.5 : 0;
    const bobRoll  = this.enableHeadBob ? Math.sin(this._bobTime) * this._bobAmp * 0.4 : 0;
    const bobY     = this.enableHeadBob ? Math.sin(this._bobTime * 2) * this._bobAmp : 0;

    const euler = new THREE.Euler(
      this.lean + this.recoilPitch + bobPitch,
      this.swivel,
      bobRoll,
      'YXZ'
    );
    this.camera.quaternion.setFromEuler(euler);
    this.camera.position.copy(this.location).add(new THREE.Vector3(0, bobY, 0));
  }

  // ── Raycast helpers ─────────────────────────────────────────────────────────
  // Returns the closest Intersection or null. Up-facing surfaces (floors/ramps)
  // are returned with `floor` truthy so horizontal sweeps can ignore them.
  _raycast(origin, dirVec, maxDist) {
    this._raycaster.set(origin, dirVec);
    this._raycaster.far = maxDist;
    const hits = this._raycaster.intersectObjects(this.hurdles, true);
    if (hits.length === 0) return null;

    const hit = hits[0];
    hit.floor = hit.faceNormal !== undefined
      ? hit.faceNormal.y > 0.05
      : hit.face.normal.clone().transformDirection(hit.object.matrixWorld).y > 0.05;
    return hit;
  }

  // Sweep the capsule along one horizontal axis. axis: 1 = X, 2 = Z.
  // 3 probe heights (feet / chest / head) × 3 lateral offsets, so capsule width
  // is honored and corner clipping stays impossible.
  _sweepHorizontal(axis, dist) {
    if (dist === 0) return;

    const sign = Math.sign(dist);
    const size = Math.abs(dist);
    const lead = sign * PLAYER_RADIUS;
    const offs = [0, PLAYER_RADIUS * 0.85, -PLAYER_RADIUS * 0.85];

    let travel = size;

    for (const off of offs) {
      for (const h of [0.12, 1.0, EYE_HEIGHT - 0.12]) {
        const origin = new THREE.Vector3(
          this.location.x + (axis === 1 ? lead : off),
          this.location.y - EYE_HEIGHT + h,
          this.location.z + (axis === 2 ? lead : off)
        );
        const rayDir = axis === 1
          ? new THREE.Vector3(sign, 0, 0)
          : new THREE.Vector3(0, 0, sign);
        const hit = this._raycast(origin, rayDir, size + PLAYER_RADIUS + MARGIN);
        if (!hit) continue;
        if (hit.floor) continue; // floors/ramps never block horizontal motion
        travel = Math.max(0, Math.min(travel, hit.distance - PLAYER_RADIUS - MARGIN));
      }
    }

    if (axis === 1) this.location.x += sign * travel;
    else             this.location.z += sign * travel;

    // Auto-step small ledges instead of getting stuck on their vertical faces
    if (travel < size - 1e-4) {
      this._tryStepUp(axis, sign, size - travel);
    }
  }

  // Try to step onto a ledge (or the start of a ramp) up to STEP_HEIGHT tall.
  // Only commits if there is headroom and the path is clear at the raised height.
  _tryStepUp(axis, sign, remaining) {
    const raisedFeet = this.location.y - EYE_HEIGHT + STEP_HEIGHT;

    const headCheck = this._raycast(
      new THREE.Vector3(this.location.x, raisedFeet + EYE_HEIGHT, this.location.z),
      new THREE.Vector3(0, 1, 0),
      STEP_HEIGHT + MARGIN
    );
    if (headCheck && !headCheck.floor) return;

    const lead = sign * (PLAYER_RADIUS + 0.05);
    for (const off of [0, PLAYER_RADIUS * 0.85, -PLAYER_RADIUS * 0.85]) {
      const origin = new THREE.Vector3(
        this.location.x + (axis === 1 ? lead : off),
        raisedFeet + 0.35,
        this.location.z + (axis === 2 ? lead : off)
      );
      const rayDir = axis === 1
        ? new THREE.Vector3(sign, 0, 0)
        : new THREE.Vector3(0, 0, sign);
      const hit = this._raycast(origin, rayDir, remaining + PLAYER_RADIUS + MARGIN);
      if (hit && !hit.floor) return; // still blocked at the raised height
    }

    // Commit the step: raise, then finish the move
    this.location.y = raisedFeet + EYE_HEIGHT;
    if (axis === 1) this.location.x += sign * remaining;
    else            this.location.z += sign * remaining;
  }

  // Vertical movement: rises with ceiling blocking, falls with ground/ramp
  // snapping. Ramps climb for free: after moving horizontally into the slope,
  // the down-ray lands the feet on whatever surface is up to SNAP_DISTANCE above.
  _applyVertical(moveY) {
    const feet = this.location.y - EYE_HEIGHT;

    // Rising: clamp against ceilings
    if (moveY > 0) {
      const hit = this._raycast(
        new THREE.Vector3(this.location.x, this.location.y, this.location.z),
        new THREE.Vector3(0, 1, 0),
        moveY + MARGIN
      );
      if (hit) {
        this.location.y = hit.point.y - MARGIN;
        this.momentum.y = 0;
      } else {
        this.location.y += moveY;
      }
      return;
    }

    // Fall (or stand): move down, then probe for a surface below
    if (moveY < 0) this.location.y += moveY;

    const probeY = feet + SNAP_DISTANCE + MARGIN;
    const hit = this._raycast(
      new THREE.Vector3(this.location.x, probeY, this.location.z),
      new THREE.Vector3(0, -1, 0),
      (moveY < 0 ? -moveY : 0) + SNAP_DISTANCE + MARGIN
    );

    if (hit) {
      const surfaceY = hit.point.y;
      if (surfaceY > feet - 1e-4) {
        // ramp / platform climb or landing
        this.location.y = surfaceY + EYE_HEIGHT;
        this.momentum.y = 0;
        this.anchored = true;
      } else if (!this.anchored) {
        // fell onto a surface slightly below (smooth landing)
        this.location.y = surfaceY + EYE_HEIGHT;
        this.momentum.y = 0;
        this.anchored = true;
      }
    } else {
      this.anchored = false;
    }
  }

  // ── Apply recoil ────────────────────────────────────────────────────────────
  applyRecoil(amount = 0.025) {
    this.recoilPitch -= amount;
  }

  // ── Snapshot for network ────────────────────────────────────────────────────
  getSnapshot() {
    // Quantize values to reduce bandwidth
    const quantize = (val, precision) => Math.round(val * precision) / precision;
    
    return {
      px: quantize(this.location.x, 100), // 2 decimal places (1cm precision)
      py: quantize(this.location.y, 100),
      pz: quantize(this.location.z, 100),
      ry: quantize(this.swivel, 1000), // 3 decimal places for rotation
      rp: quantize(this.lean, 1000),
      gait: Math.round(Math.sqrt(this.momentum.x ** 2 + this.momentum.z ** 2) * 10) / 10, // 1 decimal place
      docked: this.anchored,
      ascend: quantize(this.momentum.y, 100), // Include vertical velocity for jump animation sync
    };
  }

  // ── Respawn at position ─────────────────────────────────────────────────────
  respawn(pos) {
    this.location.set(pos.x, pos.y + EYE_HEIGHT, pos.z);
    this.momentum.set(0, 0, 0);
    this.anchored = true;
    this.isAlive    = true;
  }

  die() {
    this.isAlive = false;
    this.momentum.set(0, 0, 0);
  }
}