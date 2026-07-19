// The player's whole interface: a feed, a movement pad, and two separate input
// boxes. Asking VIN and naming an object are different acts with different
// costs, so they get different boxes — the box you type in *is* the intent.
// Builds its own DOM so index.html stays untouched.

const COMMAND_LABEL = {
  forward:  "VIN moves forward.",
  backward: "VIN steps back.",
  left:     "VIN turns left, 60°.",
  right:    "VIN turns right, 60°.",
  look:     "VIN looks again.",
};

const MOVES = [
  ["↰", "Turn left",  "left"],
  ["↑", "Forward",    "forward"],
  ["↓", "Back",       "backward"],
  ["↱", "Turn right", "right"],
];

const TYPE_MS = 12; // per character

export class CommandBar {
  constructor(game) {
    this.game = game;
    this._busy = false;
    this._locked = true; // until the splat has loaded

    const root = document.createElement("div");
    root.id = "commandbar";

    // ── feed ────────────────────────────────────────────────────────────────
    this.feedEl = document.createElement("div");
    this.feedEl.className = "cb-feed";

    // ── movement pad ────────────────────────────────────────────────────────
    this.padEl = document.createElement("div");
    this.padEl.className = "cb-pad";
    for (const [glyph, label, kind] of MOVES) {
      this.padEl.appendChild(
        this._button(`${glyph} ${label}`, "", () => this._run(this.game.command(kind)))
      );
    }
    this.padEl.appendChild(
      this._button("What do you see?", "cb-btn-look", () =>
        this._run(this.game.command("look"))
      )
    );

    // ── two inputs ──────────────────────────────────────────────────────────
    const inputs = document.createElement("div");
    inputs.className = "cb-inputs";

    this.askEl = this._input({
      tag: "ASK",
      cls: "cb-row-ask",
      placeholder: "what does it look like? is it worn? …",
      onSubmit: (v) => this._run(this.game.askVin(v), v, "cb-echo"),
    });

    this.nameEl = this._input({
      tag: "NAME",
      cls: "cb-row-name",
      placeholder: "commit to a name — a wrong one costs light",
      onSubmit: (v) => this._run(this.game.guess(v), v, "cb-echo-name"),
    });

    inputs.append(this.askEl.row, this.nameEl.row);
    root.append(this.feedEl, this.padEl, inputs);
    document.body.appendChild(root);

    // ── progress ────────────────────────────────────────────────────────────
    this.progressEl = document.createElement("div");
    this.progressEl.id = "cb-progress";
    this.progressEl.innerHTML =
      `<div class="cb-bar"><div class="cb-bar-fill"></div></div><div class="cb-pct">0% In-sync</div>`;
    document.body.appendChild(this.progressEl);
    this._fillEl = this.progressEl.querySelector(".cb-bar-fill");
    this._pctEl = this.progressEl.querySelector(".cb-pct");

    // Tab hops between the two boxes; clicking anywhere in the world returns
    // focus to whichever was last used.
    for (const box of [this.askEl, this.nameEl]) {
      box.input.addEventListener("focus", () => (this._lastFocus = box.input));
    }
    this._lastFocus = this.askEl.input;
    window.addEventListener("mousedown", (e) => {
      if (e.target.closest("#settings") || e.target.closest(".cb-feed") ||
          e.target.closest("#commandbar")) return;
      setTimeout(() => !this._busy && this._lastFocus?.focus(), 0);
    });

    this._setEnabled(false);
  }

  // ── construction helpers ──────────────────────────────────────────────────
  _button(text, cls, onClick) {
    const b = document.createElement("button");
    b.className = `cb-btn ${cls}`;
    b.textContent = text;
    b.tabIndex = -1; // never steal focus from the inputs
    b.addEventListener("click", () => !this._busy && !this._locked && onClick());
    return b;
  }

  _input({ tag, cls, placeholder, onSubmit }) {
    const row = document.createElement("div");
    row.className = `cb-row ${cls}`;

    const tagEl = document.createElement("span");
    tagEl.className = "cb-tag";
    tagEl.textContent = tag;

    const input = document.createElement("input");
    input.type = "text";
    input.className = "cb-input";
    input.autocomplete = "off";
    input.spellcheck = false;
    input.placeholder = placeholder;

    const history = [];
    let idx = 0;

    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        const v = input.value.trim();
        if (!v || this._busy || this._locked) return;
        history.push(v);
        idx = history.length;
        input.value = "";
        onSubmit(v);
      } else if (e.key === "ArrowUp" && idx > 0) {
        input.value = history[--idx];
        e.preventDefault();
      } else if (e.key === "ArrowDown") {
        input.value = idx < history.length - 1 ? history[++idx] : ((idx = history.length), "");
        e.preventDefault();
      }
    });

    row.append(tagEl, input);
    return { row, input, tagEl };
  }

  // ── running a turn ────────────────────────────────────────────────────────
  async _run(iterator, echo = null, echoCls = "cb-echo") {
    this._setBusy(true);
    if (echo) this.say(echo, echoCls, echoCls === "cb-echo-name" ? "◇" : ">");

    let waiting = null;
    const clearWaiting = () => { if (waiting) { waiting.remove(); waiting = null; } };

    try {
      for await (const r of iterator) {
        switch (r.type) {
          case "command":
            this.say(COMMAND_LABEL[r.kind], "cb-ok");
            break;
          case "pending":
            waiting = this.say("VIN is looking…", "cb-wait");
            break;
          case "judging":
            waiting = this.say("…", "cb-wait");
            break;
          case "report":
            clearWaiting();
            // VIN's "I have nothing for you" — type it slowly, it lands better
            // as a process failing to find a response than as a sentence.
            if (/^[.…]{3,}$/.test(r.text.trim())) {
              await this.type(r.text.trim(), "cb-null", 260);
            } else {
              await this.type(r.text, "cb-vin");
            }
            // If a template stood in for the model, say so — otherwise a dull
            // reply looks like a dull model rather than a broken pipe.
            if (r.source && r.source !== "llm" && r.source !== "cache") {
              this.say(`[canned — ${r.source}]`, "cb-dim");
            }
            break;
          case "hit":
            clearWaiting();
            this.say(
              r.count > 1
                ? `"${r.text}" — ${r.count} of them. The dark gives way.`
                : `"${r.text}" — named correctly. The dark gives way.`,
              "cb-hit"
            );
            if (r.complete) this.say("Everything here is rendered. You are in sync.", "cb-hit");
            break;
          case "repeat":
            clearWaiting();
            this.say("You already named that one.", "cb-dim");
            break;
          case "miss":
            clearWaiting();
            this.say(`Nothing here answers to "${r.text}". The light pulls back.`, "cb-miss");
            break;
        }
        this.refresh();
      }
    } catch (e) {
      clearWaiting();
      this.say(`Signal lost. (${e.message})`, "cb-miss");
      console.error(e);
    } finally {
      clearWaiting();
      this._setBusy(false);
      this.refresh();
    }
  }

  // ── state ─────────────────────────────────────────────────────────────────
  _setBusy(b) {
    this._busy = b;
    this._setEnabled(!b && !this._locked);
    if (!b && !this._locked) this._lastFocus?.focus();
  }

  _setEnabled(on) {
    for (const btn of this.padEl.children) btn.disabled = !on;
    this.askEl.input.disabled = !on;
    this.nameEl.input.disabled = !on;
    this.askEl.row.classList.toggle("thinking", !on);
    this.nameEl.row.classList.toggle("thinking", !on);
  }

  /** Called once the splat has finished loading. */
  unlock() {
    this._locked = false;
    this._setEnabled(true);
    this.askEl.input.focus();
  }

  // ── feed ──────────────────────────────────────────────────────────────────
  say(text, cls = "", prefix = "") {
    const line = document.createElement("div");
    line.className = `cb-line ${cls}`;
    line.textContent = prefix ? `${prefix} ${text}` : text;
    this.feedEl.appendChild(line);
    while (this.feedEl.children.length > 40) this.feedEl.removeChild(this.feedEl.firstChild);
    this.feedEl.scrollTop = this.feedEl.scrollHeight;
    return line;
  }

  /** Typewriter, because VIN reporting over a bad channel should feel like it. */
  type(text, cls = "", speed = TYPE_MS) {
    const line = this.say("", cls);
    return new Promise((resolve) => {
      let i = 0;
      const tick = () => {
        line.textContent = text.slice(0, ++i);
        this.feedEl.scrollTop = this.feedEl.scrollHeight;
        if (i < text.length) setTimeout(tick, speed);
        else resolve(line);
      };
      tick();
    });
  }

  refresh() {
    const pct = Math.round(this.game.progress * 100);
    this._fillEl.style.width = `${pct}%`;
    this._pctEl.textContent = `${pct}% In-sync`;
    this.progressEl.classList.toggle("dimmed", this.game.penaltyCount > 0);
  }
}
