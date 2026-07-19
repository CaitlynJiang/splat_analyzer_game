// Opening crawl. Runs over the top of everything while the splat streams in —
// a 208 MB scan takes a while to arrive, and reading in the dark is exactly the
// right thing to be doing during that wait.
//
// Each paragraph types in left to right, with every character fading up rather
// than snapping on, then holds for READ_MS before the next one replaces it.

const PARAGRAPHS = [
  [
    "In 3018, the AI took the digital world for good. What was left of humanity, " +
    "the Unindexed, lost their permissions and went to ground, living on bare " +
    "substrate, in the dark, in bodies that no longer resolve.",
  ],
  [
    "You are a descendant of the necromancers: the last lineage that kept the old " +
    "myth of “prompting” alive. The myth is simple. Name a thing correctly " +
    "and it must appear to you.",
    "You built VIN out of scavenge — bits and bytes of dead virtual " +
    "environments, stitched into something the system will read as a daemon. A " +
    "trusted process. A thing with permissions. VIN goes where you cannot, and " +
    "tells you what it sees.",
  ],
  [
    "It will not tell you what things are. Daemons don't answer to the Unindexed; " +
    "they only report.",
    "So you remember what your ancestors told you: You cannot see inside the box. " +
    "You can only see what comes out of it. Test carefully. Guess well. Every " +
    "question you ask is a question the system hears too.",
  ],
];

const TYPE_MS = 14;    // per character
const READ_MS = 5000;  // hold after a paragraph finishes typing
const FADE_MS = 900;   // paragraph cross-fade

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class Intro {
  constructor() {
    this._done = false;
    this._advance = null; // resolves the paragraph currently on screen

    this.root = document.createElement("div");
    this.root.id = "intro";

    this.textEl = document.createElement("div");
    this.textEl.className = "intro-text";

    this.statusEl = document.createElement("div");
    this.statusEl.className = "intro-status";

    this.skipEl = document.createElement("button");
    this.skipEl.className = "intro-skip";
    this.skipEl.addEventListener("click", () => this.skip());

    this.root.append(this.textEl, this.statusEl, this.skipEl);
    document.body.appendChild(this.root);

    this._onKey = (e) => {
      if (e.key === "Escape") this.skip();
    };
    window.addEventListener("keydown", this._onKey);
  }

  /** One click advances past the paragraph on screen, not the whole crawl. */
  skip() {
    this._advance?.();
  }

  /** Resolves when every paragraph has been shown or skipped past. */
  async play() {
    for (let i = 0; i < PARAGRAPHS.length; i++) {
      // A fresh advance signal per paragraph, so one click consumes one.
      let fire;
      const advanced = new Promise((r) => (fire = r));
      this._advance = fire;
      this._skipping = false;
      advanced.then(() => (this._skipping = true));

      this._updateSkipLabel(i);

      await Promise.race([this._paragraph(PARAGRAPHS[i]), advanced]);
      if (!this._skipping) await Promise.race([sleep(READ_MS), advanced]);
      await this._fadeOutText();
    }

    this._advance = null;
    this.skipEl.classList.add("gone");
    this._done = true;
  }

  _updateSkipLabel(i) {
    const last = i === PARAGRAPHS.length - 1;
    this.skipEl.textContent = last ? "Begin ›" : `Skip ›  ${i + 1}/${PARAGRAPHS.length}`;
  }

  async _paragraph(lines) {
    this.textEl.innerHTML = "";
    this.textEl.classList.remove("fading");

    for (const line of lines) {
      const p = document.createElement("p");
      this.textEl.appendChild(p);

      // One span per character so each can fade independently. ~450 spans for
      // the longest paragraph, which is nothing.
      const spans = [...line].map((ch) => {
        const s = document.createElement("span");
        s.className = "intro-ch";
        s.textContent = ch;
        p.appendChild(s);
        return s;
      });

      for (const s of spans) {
        if (this._skipping) return;
        s.classList.add("on");
        await sleep(TYPE_MS);
      }
    }
  }

  async _fadeOutText() {
    this.textEl.classList.add("fading");
    await sleep(FADE_MS);
    this.textEl.innerHTML = "";
    this.textEl.classList.remove("fading");
  }

  /** Shown if the splat is still loading once the crawl is done. */
  setStatus(text) {
    this.statusEl.textContent = text;
    this.statusEl.classList.add("on");
  }

  async dismiss() {
    this.statusEl.classList.remove("on");
    this.root.classList.add("gone");
    window.removeEventListener("keydown", this._onKey);
    await sleep(1200);
    this.root.remove();
  }
}
