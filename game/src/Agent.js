import * as THREE from "three";

// The agent. Movement is discrete and animated: every command is one fixed
// step or one fixed turn, queued and eased so the player reads it as the agent
// *deciding* to move rather than teleporting.
//
// Viewer space note: AnnotationParser maps source (x, y, z) -> (x, -y, -z) to
// match the splat's π-about-X rotation, so in here +Y is up and the floor of
// MGstudio_SmallRoom sits at roughly y = 0.1.

const FLOOR_Y = 0.35;              // eye height above the floor
export const STEP = 0.45;          // world units per "move forward"
export const TURN = Math.PI / 3;   // 60° per turn command
const STEP_MS = 520;
const TURN_MS = 420;

const easeInOutCubic = (t) =>
  t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

export class Agent {
  constructor(start = new THREE.Vector3(0, FLOOR_Y, 0.5)) {
    this.position = start.clone();
    this.heading = 0; // radians, 0 = +X

    const geo = new THREE.SphereGeometry(0.045, 16, 16);
    this._mat = new THREE.MeshBasicMaterial({ color: 0xbfe3ff });
    this.dot = new THREE.Mesh(geo, this._mat);
    this.dot.position.copy(this.position);

    this._haloMat = new THREE.MeshBasicMaterial({
      color: 0x6fb4ff,
      transparent: true,
      opacity: 0.18,
      depthWrite: false,
    });
    this.dot.add(new THREE.Mesh(new THREE.SphereGeometry(0.11, 16, 16), this._haloMat));

    this._queue = [];
    this._active = null;
  }

  addTo(sceneManager) { sceneManager.add(this.dot); }

  get forward() {
    return new THREE.Vector3(Math.cos(this.heading), 0, Math.sin(this.heading));
  }

  get busy() { return this._active !== null || this._queue.length > 0; }

  step(sign = 1) { this._queue.push({ kind: "move", sign }); }
  turn(sign = 1)  { this._queue.push({ kind: "turn", sign }); }

  /** Resolves once the agent has finished moving — VIN describes after it
   *  arrives, not while it is still walking. */
  waitIdle() {
    return new Promise((resolve) => {
      const tick = () => (this.busy ? requestAnimationFrame(tick) : resolve());
      tick();
    });
  }

  /** Dim the visual dot. k = 1 is full brightness. */
  setDim(k) {
    this._mat.color.setRGB(0.75 * k, 0.89 * k, 1.0 * k);
    this._haloMat.opacity = 0.18 * k;
  }

  update() {
    if (!this._active && this._queue.length) {
      const cmd = this._queue.shift();
      this._active = {
        ...cmd,
        t0: performance.now(),
        dur: cmd.kind === "move" ? STEP_MS : TURN_MS,
        fromPos: this.position.clone(),
        fromHeading: this.heading,
        toPos:
          cmd.kind === "move"
            ? this.position.clone().addScaledVector(
                new THREE.Vector3(Math.cos(this.heading), 0, Math.sin(this.heading)),
                cmd.sign * STEP
              )
            : null,
        toHeading: cmd.kind === "turn" ? this.heading + cmd.sign * TURN : null,
      };
    }

    if (this._active) {
      const a = this._active;
      const t = Math.min(1, (performance.now() - a.t0) / a.dur);
      const k = easeInOutCubic(t);
      if (a.kind === "move") {
        this.position.lerpVectors(a.fromPos, a.toPos, k);
        this.position.y = FLOOR_Y;
      } else {
        this.heading = a.fromHeading + (a.toHeading - a.fromHeading) * k;
      }
      if (t >= 1) this._active = null;
    }

    this.dot.position.copy(this.position);
    return this.position;
  }
}
