// ─── PlayerController.js ──────────────────────────────────────────────────────
// Handles all local player input, physics movement, camera control (pointer lock),
// and first-person weapon bob.

import * as THREE from 'three';

const WALK_SPEED   = 5.0;
const SPRINT_SPEED = 9.0;
const JUMP_FORCE   = 7.0;
const GRAVITY      = -22.0;
const EYE_HEIGHT   = 1.65; // metres above feet
const PLAYER_RADIUS = 0.35;
const GROUND_Y     = 0.0;  // baseplate surface

export class PlayerController {
  constructor(camera, domElement) {
    this.camera     = camera;
    this.domElement = domElement;

    // State
    this.position  = new THREE.Vector3(0, EYE_HEIGHT, 0);
    this.velocity  = new THREE.Vector3();
    this.yaw       = 0;   // horizontal look (radians)
    this.pitch     = 0;   // vertical look   (radians)
    this.isGrounded = true;
    this.isAlive   = true;

    // Keys
    this._keys = { w: false, a: false, s: false, d: false, space: false, shift: false };

    // Mouse sensitivity
    this.sensitivity = 0.0018;

    // Bob
    this._bobTime  = 0;
    this._bobAmp   = 0;

    // Head bob toggle setting
    this.enableHeadBob = true;

    // Map colliders (array of THREE.Box3)
    this.colliders = [];

    // Recoil
    this.recoilPitch = 0;

    this._locked = false;
    this._setupListeners();
  }

  setColliders(boxes) {
    this.colliders = boxes;
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
      this.yaw   -= e.movementX * this.sensitivity;
      this.pitch -= e.movementY * this.sensitivity;
      this.pitch  = Math.max(-Math.PI * 0.48, Math.min(Math.PI * 0.48, this.pitch));
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
    dir.applyAxisAngle(new THREE.Vector3(0, 1, 0), this.yaw);

    // Apply horizontal velocity
    this.velocity.x = dir.x * speed;
    this.velocity.z = dir.z * speed;

    // Gravity & jump
    if (this.isGrounded) {
      if (this._keys.space) {
        this.velocity.y = JUMP_FORCE;
        this.isGrounded  = false;
      } else {
        this.velocity.y = 0;
      }
    } else {
      this.velocity.y += GRAVITY * delta;
    }

    // ── Movement & Map Collisions ───────────────────────────────────────────
    const moveX = this.velocity.x * delta;
    const moveZ = this.velocity.z * delta;
    const moveY = this.velocity.y * delta;

    const r = PLAYER_RADIUS;

    // Move X & resolve horizontal X collisions
    if (moveX !== 0) {
      this.position.x += moveX;
      const feetY = this.position.y - EYE_HEIGHT;
      const headY = this.position.y;
      for (const box of this.colliders) {
        if (feetY < box.max.y && headY > box.min.y &&
            this.position.z + r > box.min.z && this.position.z - r < box.max.z) {
          if (moveX > 0 && this.position.x + r > box.min.x && this.position.x - r < box.min.x) {
            this.position.x = box.min.x - r;
          } else if (moveX < 0 && this.position.x - r < box.max.x && this.position.x + r > box.max.x) {
            this.position.x = box.max.x + r;
          }
        }
      }
    }

    // Move Z & resolve horizontal Z collisions
    if (moveZ !== 0) {
      this.position.z += moveZ;
      const feetY = this.position.y - EYE_HEIGHT;
      const headY = this.position.y;
      for (const box of this.colliders) {
        if (feetY < box.max.y && headY > box.min.y &&
            this.position.x + r > box.min.x && this.position.x - r < box.max.x) {
          if (moveZ > 0 && this.position.z + r > box.min.z && this.position.z - r < box.min.z) {
            this.position.z = box.min.z - r;
          } else if (moveZ < 0 && this.position.z - r < box.max.z && this.position.z + r > box.max.z) {
            this.position.z = box.max.z + r;
          }
        }
      }
    }

    // Move Y & resolve vertical ground/platform collisions
    this.position.y += moveY;

    let supportY = GROUND_Y;
    const feetY = this.position.y - EYE_HEIGHT;

    for (const box of this.colliders) {
      const horizontalOverlap = (
        this.position.x + r * 0.7 > box.min.x &&
        this.position.x - r * 0.7 < box.max.x &&
        this.position.z + r * 0.7 > box.min.z &&
        this.position.z - r * 0.7 < box.max.z
      );

      if (horizontalOverlap) {
        // Platform top support (stepping on platform)
        if (box.max.y <= feetY + 0.4 && box.max.y >= supportY) {
          supportY = box.max.y;
        }
      }
    }

    // Ground & platform snapping
    const minTargetY = supportY + EYE_HEIGHT;
    if (this.position.y <= minTargetY) {
      this.position.y = minTargetY;
      this.velocity.y = 0;
      this.isGrounded  = true;
    } else {
      if (this.isGrounded && this.position.y > minTargetY + 0.1) {
        this.isGrounded = false;
      }
    }

    // Clamp to play area boundary
    const BOUND = 74.0;
    this.position.x = Math.max(-BOUND, Math.min(BOUND, this.position.x));
    this.position.z = Math.max(-BOUND, Math.min(BOUND, this.position.z));

    // Head-bob calculation
    const hSpeed = Math.sqrt(this.velocity.x ** 2 + this.velocity.z ** 2);
    if (this.enableHeadBob && this.isGrounded && hSpeed > 0.5) {
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
      this.pitch + this.recoilPitch + bobPitch,
      this.yaw,
      bobRoll,
      'YXZ'
    );
    this.camera.quaternion.setFromEuler(euler);
    this.camera.position.copy(this.position).add(new THREE.Vector3(0, bobY, 0));
  }

  // ── Apply recoil ────────────────────────────────────────────────────────────
  applyRecoil(amount = 0.025) {
    this.recoilPitch -= amount;
  }

  // ── Snapshot for network ────────────────────────────────────────────────────
  getSnapshot() {
    return {
      x: this.position.x,
      y: this.position.y,
      z: this.position.z,
      yaw: this.yaw,
      pitch: this.pitch,
      speed: Math.sqrt(this.velocity.x ** 2 + this.velocity.z ** 2),
      isGrounded: this.isGrounded,
    };
  }

  // ── Respawn at position ─────────────────────────────────────────────────────
  respawn(pos) {
    this.position.set(pos.x, pos.y + EYE_HEIGHT, pos.z);
    this.velocity.set(0, 0, 0);
    this.isGrounded = true;
    this.isAlive    = true;
  }

  die() {
    this.isAlive = false;
    this.velocity.set(0, 0, 0);
  }
}
