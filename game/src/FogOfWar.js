import * as THREE from "three";
import {
  SplatEdit,
  SplatEditSdf,
  SplatEditSdfType,
  SplatEditRgbaBlendMode,
} from "@sparkjsdev/spark";

// ─────────────────────────────────────────────────────────────────────────────
// Fog of war, implemented as ONE inverted MULTIPLY edit.
//
// The naive approach is two edits: darken everything, then ADD_RGBA the lit
// regions back. That looks wrong — ADD adds a *uniform* colour, so revealed
// objects come back as washed-out blobs instead of their real appearance.
//
// Instead: a single MULTIPLY edit with `invert: true`. The SDF shapes mark the
// LIT regions; inverting means the dark colour is applied everywhere *outside*
// them, while splats inside the shapes are left completely untouched — full
// original colour, for free.
//
// GOTCHA: if the polarity comes out backwards (room lit, objects dark), flip
// INVERT below. That is the whole fix.
// ─────────────────────────────────────────────────────────────────────────────

const INVERT = true;

// What the unlit world is multiplied by. Not pure black — a little blue left in
// keeps silhouettes barely readable, which reads as "dark room" instead of
// "nothing rendered". Push toward 0 for a harder fog.
const DARK = new THREE.Color(0.05, 0.055, 0.085);

// Falloff radius (world units) around every lit shape's surface. This is what
// makes the pools of light feather instead of ending on a hard box edge.
const SOFT_EDGE = 0.22;

// Blend scale *between* overlapping lit shapes, so two nearby reveals merge
// into one pool rather than showing a seam.
const SDF_SMOOTH = 0.3;

// Detected boxes hug their object tightly; a little padding lets the light
// spill onto the floor around it, which looks far better.
const BOX_PADDING = 1.35;

// The agent carries its own small sphere of visibility. Keep this TIGHT — if it
// reaches far enough to show an object's silhouette, the player can just read
// the answer off the screen instead of having to walk up and interrogate VIN.
// It should light little more than the ground the agent is standing on.
const AGENT_LIGHT_RADIUS = 0.18;

// Reveal animation duration (ms).
const REVEAL_MS = 700;

const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);

export class FogOfWar {
  constructor() {
    this.mesh = null;

    // The agent's personal light. Always present, which conveniently means the
    // sdfs array is never empty even before anything has been discovered.
    this._agentSdf = new SplatEditSdf({
      type: SplatEditSdfType.SPHERE,
      radius: AGENT_LIGHT_RADIUS,
      color: DARK,
      opacity: 1, // leave alpha alone; 1 * a === a
    });

    this._edit = new SplatEdit({
      rgbaBlendMode: SplatEditRgbaBlendMode.MULTIPLY,
      invert: INVERT,
      softEdge: SOFT_EDGE,
      sdfSmooth: SDF_SMOOTH,
      sdfs: [this._agentSdf],
    });

    // annotation -> { sdf, target, t0 }
    this._revealed = new Map();
  }

  attach(mesh) {
    this.mesh = mesh;
    if (mesh) {
      mesh.edits = [this._edit];
      mesh.updateMatrixWorld(true);
    }
  }

  setAgentPosition(v3) {
    this._agentSdf.position.copy(v3);
    this._agentSdf.updateMatrixWorld(true);
  }

  setAgentLightRadius(r) {
    this._agentSdf.radius = r;
  }

  /** k = 1 is the agent's normal radius; wrong guesses push it down. */
  setAgentLightScale(k) {
    const r = AGENT_LIGHT_RADIUS * k;
    if (Math.abs(this._agentSdf.radius - r) < 1e-4) return;
    this._agentSdf.radius = r;
    this._touch();
  }

  /** Light up one annotation's region. Idempotent. */
  reveal(annotation) {
    if (this._revealed.has(annotation)) return;

    const sdf = new SplatEditSdf({
      type: SplatEditSdfType.BOX,
      color: DARK,
      opacity: 1,
    });
    sdf.position.copy(annotation.position);
    sdf.quaternion.copy(annotation.quaternion);

    // Spark's BOX sdf reads `scale` as HALF-extents (matching how the upstream
    // viewer sets up its hover highlight), so halve the full box size.
    const target = new THREE.Vector3(
      (annotation.size.x * 0.5) * BOX_PADDING,
      (annotation.size.y * 0.5) * BOX_PADDING,
      (annotation.size.z * 0.5) * BOX_PADDING
    );
    sdf.scale.set(1e-4, 1e-4, 1e-4); // grows in from nothing
    sdf.updateMatrixWorld(true);

    this._revealed.set(annotation, { sdf, target, t0: performance.now() });
    this._syncSdfs();
  }

  /** Put a region back into darkness (used while hover is the trigger). */
  conceal(annotation) {
    if (!this._revealed.has(annotation)) return;
    this._revealed.delete(annotation);
    this._syncSdfs();
  }

  concealAll() {
    this._revealed.clear();
    this._syncSdfs();
  }

  isRevealed(annotation) {
    return this._revealed.has(annotation);
  }

  get revealedCount() {
    return this._revealed.size;
  }

  /** Call once per frame — drives the grow-in animation. */
  update() {
    const now = performance.now();
    let dirty = false;

    for (const entry of this._revealed.values()) {
      const t = Math.min(1, (now - entry.t0) / REVEAL_MS);
      if (t >= 1 && entry.done) continue;
      const k = easeOutCubic(t);
      entry.sdf.scale.set(
        Math.max(1e-4, entry.target.x * k),
        Math.max(1e-4, entry.target.y * k),
        Math.max(1e-4, entry.target.z * k)
      );
      entry.sdf.updateMatrixWorld(true);
      if (t >= 1) entry.done = true;
      dirty = true;
    }

    if (dirty) this._touch();
  }

  _syncSdfs() {
    const sdfs = [this._agentSdf];
    for (const entry of this._revealed.values()) sdfs.push(entry.sdf);
    this._edit.sdfs = sdfs;
    this._touch();
  }

  // Spark picks up mutations on its own, but reassigning `edits` is the
  // documented way to force the edit list to be re-read. Cheap; do it whenever
  // the shape set or geometry changes.
  _touch() {
    if (this.mesh) this.mesh.edits = [this._edit];
  }
}
