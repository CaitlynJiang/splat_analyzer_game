import * as THREE from "three";

// What VIN can see. A cone from the agent's position along its heading; every
// annotation whose centre falls inside becomes one structured observation.
//
// No raycasting: the boxes are axis-aligned points in space, so a signed-angle
// test is both cheaper and easier to sort. Sorting by that signed angle gives a
// natural left-to-right reading order, which is what makes the descriptions
// actually navigable.
//
// NOT modelled yet: occlusion. VIN can currently see through the sofa.

const HALF_ANGLE = THREE.MathUtils.degToRad(38);
const RANGE = 1.7;

// VIN reports on at most this many things. Two is the sweet spot: enough to
// give the player a choice of what to walk toward, few enough that they
// actually read it.
const MAX_REPORTED = 2;

function bearing(signedAngle) {
  const deg = THREE.MathUtils.radToDeg(signedAngle);
  const a = Math.abs(deg);
  if (a < 7) return "directly ahead";
  const side = deg < 0 ? "left" : "right";
  if (a < 20) return `slightly to the ${side}`;
  return `to the ${side}`;
}

function proximity(d) {
  if (d < 0.45) return "right in front of you";
  if (d < 1.0) return "a step or two away";
  return "further off";
}

// Honest shape facts derived from the detected box. This is the only material
// VIN gets besides the label, so it has to carry the puzzle.
function shape(size) {
  const h = size.y;
  const footprint = Math.max(size.x, size.z);
  const biggest = Math.max(size.x, size.y, size.z);

  let build;
  if (h > footprint * 1.4) build = "tall and narrow";
  else if (h < footprint * 0.55) build = "low and wide";
  else build = "roughly as tall as it is wide";

  let bulk;
  if (biggest < 0.33) bulk = "small enough to pick up";
  else if (biggest > 0.8) bulk = "large";
  else bulk = "about knee to waist height";

  return { build, bulk, height_m: +h.toFixed(2), footprint_m: +footprint.toFixed(2) };
}

export class Vision {
  constructor(agent) {
    this.agent = agent;
  }

  /**
   * The nearest few objects in the cone, ordered left → right.
   * @returns {Array} observations
   */
  look(annotations, limit = MAX_REPORTED) {
    const fwd = this.agent.forward;
    const out = [];

    for (const a of annotations) {
      const to = new THREE.Vector3().subVectors(a.position, this.agent.position);
      to.y = 0;
      const dist = to.length();
      if (dist > RANGE || dist < 1e-4) continue;

      to.normalize();
      // Signed angle in the ground plane: negative = left, positive = right.
      const signed = Math.atan2(
        fwd.x * to.z - fwd.z * to.x,
        fwd.x * to.x + fwd.z * to.z
      );
      if (Math.abs(signed) > HALF_ANGLE) continue;

      out.push({
        annotation: a,
        label: a.label,
        signed,
        bearing: bearing(signed),
        distance: proximity(dist),
        distance_m: +dist.toFixed(2),
        ...shape(a.size),
      });
    }

    // Keep the closest few, then restore left-to-right order among those.
    out.sort((x, y) => x.distance_m - y.distance_m);
    const near = out.slice(0, limit);
    near.sort((x, y) => x.signed - y.signed);
    return near;
  }

  /** Payload for the LLM — strips THREE objects, keeps only facts. */
  static toFacts(observations) {
    return observations.map((o, i) => ({
      id: i,
      secret_label: o.label,
      bearing: o.bearing,
      distance: o.distance,
      build: o.build,
      bulk: o.bulk,
    }));
  }
}
