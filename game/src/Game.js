import { Llm } from "./Llm.js";

// Game rules: what counts as a command, what counts as a guess, what a wrong
// guess costs. Deliberately holds no DOM and no THREE — CommandBar owns the UI,
// FogOfWar owns the lighting, Vision owns the geometry, this owns the state in
// between.

const PENALTY_MS = 3000;     // one wrong guess dims the agent for this long
const PENALTY_FALLOFF = 0.6; // light multiplier per stacked penalty
const MIN_LIGHT = 0.12;      // never go fully blind

const COMMANDS = [
  { kind: "forward",  patterns: ["move forward", "go forward", "forward", "move", "walk", "w"] },
  { kind: "backward", patterns: ["move backward", "move back", "go back", "backward", "back", "s"] },
  { kind: "left",     patterns: ["turn left", "left", "a"] },
  { kind: "right",    patterns: ["turn right", "right", "d"] },
  { kind: "look",     patterns: ["look", "describe", "what do you see", "report", "look again"] },
];

const normalize = (s) =>
  s.toLowerCase().trim().replace(/[^a-z0-9\s]/g, "").replace(/\s+/g, " ");

const MAX_HISTORY = 6;

export class Game {
  constructor({ agent, fog, vision, annotations = [], onChange }) {
    this.agent = agent;
    this.fog = fog;
    this.vision = vision;
    this.annotations = annotations;
    this.discovered = new Set();
    this.onChange = onChange;
    this._penalties = [];
    this._history = []; // rolling VIN conversation, sent back as context
  }

  setAnnotations(annotations) {
    this.annotations = annotations;
    this.discovered.clear();
    this._penalties = [];
    this._history = [];
    this.fog.concealAll();
    this.onChange?.();
  }

  /** Distinct object names in the level — the set the player must produce. */
  get targetLabels() {
    return [...new Set(this.annotations.map((a) => a.label))];
  }

  get remainingLabels() {
    const found = new Set([...this.discovered].map((a) => normalize(a.label)));
    return this.targetLabels.filter((l) => !found.has(normalize(l)));
  }

  get progress() {
    const total = this.targetLabels.length;
    if (!total) return 0;
    return (total - this.remainingLabels.length) / total;
  }

  // Three entry points, one per thing the player can do. The UI decides which —
  // asking and naming have their own input boxes, so there is no heuristic
  // guessing at intent and no way to get penalised for thinking out loud.

  /**
   * Movement / look. Moving does NOT make VIN volunteer a report — it only
   * speaks when spoken to. Otherwise the feed fills with descriptions nobody
   * asked for and the player stops reading them.
   */
  async *command(kind) {
    yield { type: "command", kind };
    if (kind !== "look") {
      this._runCommand(kind);
      await this.agent.waitIdle();
      return;
    }
    await this.agent.waitIdle();
    yield { type: "pending" };
    yield { type: "report", ...(await this.ask(null)) };
  }

  /** Talk to VIN. Free — questions never cost light. */
  async *askVin(raw) {
    const text = raw.trim();
    if (!text) return;

    // Typing a movement command into the ask box should still just work.
    const cmd = COMMANDS.find((c) => c.patterns.includes(normalize(text)));
    if (cmd) {
      yield* this.command(cmd.kind);
      return;
    }

    yield { type: "pending" };
    yield { type: "report", ...(await this.ask(text)) };
  }

  /** Commit to a name. Wrong answers cost light. */
  async *guess(raw) {
    const text = raw.trim();
    if (!text) return;
    yield* this._guess(text);
  }

  /**
   * Ask VIN something (or nothing, for a plain report).
   * @returns {{text: string, source: string}}
   */
  async ask(question) {
    const observations = this.vision.look(this.annotations);
    this.lastObservations = observations;

    const { text, source } = await Llm.ask(observations, question, this._history);

    this._history.push({ role: "user", content: question ?? "Report." });
    this._history.push({ role: "assistant", content: text });
    if (this._history.length > MAX_HISTORY * 2) {
      this._history = this._history.slice(-MAX_HISTORY * 2);
    }
    return { text, source };
  }

  _runCommand(kind) {
    if (kind === "forward")  this.agent.step(1);
    if (kind === "backward") this.agent.step(-1);
    if (kind === "left")     this.agent.turn(-1);
    if (kind === "right")    this.agent.turn(1);
  }

  // The LLM adjudicates. This is what lets "seat" match "stool" and "rug" match
  // "carpet" — and it quietly absorbs the duplicate detections in the pipeline
  // output, since every box sharing the matched label lights up together.
  async *_guess(original) {
    yield { type: "judging" };

    const match = await Llm.judge(original, this.targetLabels);

    if (!match) {
      this._penalize();
      this.onChange?.();
      yield { type: "miss", text: original };
      return;
    }

    const hits = this.annotations.filter(
      (a) => normalize(a.label) === normalize(match) && !this.discovered.has(a)
    );

    if (hits.length === 0) {
      this.onChange?.();
      yield { type: "repeat", text: original, label: match };
      return;
    }

    for (const a of hits) {
      this.discovered.add(a);
      this.fog.reveal(a);
    }
    this.onChange?.();
    yield {
      type: "hit",
      text: original,
      label: match,
      count: hits.length,
      complete: this.remainingLabels.length === 0,
    };
  }

  isDiscovered(annotation) { return this.discovered.has(annotation); }

  _penalize() { this._penalties.push(performance.now() + PENALTY_MS); }

  /** Call each frame: expires penalties and drives the agent's light level. */
  update() {
    const now = performance.now();
    const before = this._penalties.length;
    this._penalties = this._penalties.filter((t) => t > now);

    const k = Math.max(MIN_LIGHT, Math.pow(PENALTY_FALLOFF, this._penalties.length));
    this.fog.setAgentLightScale(k);
    this.agent.setDim(k);

    if (before !== this._penalties.length) this.onChange?.();
    return k;
  }

  get penaltyCount() { return this._penalties.length; }
}
