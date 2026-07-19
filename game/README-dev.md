# game/ — dev notes

Fork of `viewer/`. Same splat + annotation pipeline, but the scene starts dark
and is revealed region by region.

## Run

```bash
pip install fastapi uvicorn httpx python-dotenv
cp .env.example .env      # set LLM_API_KEY
python game_server.py
# open http://localhost:8000/game/
```

`game_server.py` serves the repo root as static files *and* hosts the two LLM
endpoints. It deliberately does not import the detection pipeline, so it runs on
a laptop with no GPU.

Static-only (no VIN dialogue, canned text instead) also works:
`python3 -m http.server 8000` from the repo root.

## The LLM

Any OpenAI-compatible endpoint — set `LLM_BASE_URL` / `LLM_MODEL` /
`LLM_API_KEY` in `.env` (see `.env.example` for Qwen, OpenAI, DeepSeek, Ollama).
**With no key set everything still runs**, falling back to local templates, so a
dead API or dead wifi can never take the demo down.

Two calls, and the second one matters more than the first:

| Endpoint | Job |
|---|---|
| `POST /api/ask` | VIN answers the operator, *without naming anything* |
| `POST /api/judge` | decides whether the player's guess means the same thing as a real label |

`/api/judge` is what makes `seat` → `stool` and `rug` → `carpet` work. Exact
matches short-circuit before any network call.

`/api/ask` is fed only structured facts — bearing, distance, build, bulk — plus
the true label so it can be accurate. The label is on an explicit banned list;
the server checks the reply for leaks, retries once with a harder nudge, and
drops to the template rather than spoil the puzzle. It carries the last 6 turns
of conversation, so follow-ups like "is it worn?" land in context.

`VIN_SYSTEM` in `game_server.py` holds the whole character: the 3018 setting,
the Unindexed, the necromancer operator, the two-sentence limit, and licence to
invent everything except the name.

VIN reports on at most `MAX_REPORTED` (2) objects — the nearest ones in the
cone, re-sorted left to right. Two is enough to give the player a choice of
where to walk, few enough that they actually read it.

Loads `MGstudio_SmallRoom.ply` + `out_MGstudio_SmallRoom/interactions.json`
automatically (constants at the top of `main.js`).

> The `.ply` is **208 MB** and rebuilds its LOD tree in a worker on every page
> load. While iterating, point `DEFAULT_SPLAT_URL` at `MGstudio_SmallRoom.spz`
> — same scene, 15 MB, about a second. Inputs stay locked until it's ready.

## Intro

`Intro.js` plays three paragraphs of backstory over the top of everything while
the splat streams in — ~32s of reading, which is roughly what the 208 MB scan
costs anyway. Each character fades up as it types rather than snapping on.

Skip button is bottom-right; `Esc` also works. Skipping fast-forwards the crawl
but **not** the loading: if the scan hasn't arrived, the overlay stays with a
"Reconstructing the scan…" status instead of dropping the player into an empty
room. Inputs unlock only once both the crawl and the splat are done.

Timing knobs at the top of `Intro.js`: `TYPE_MS` (14, per character), `READ_MS`
(5000, hold after each paragraph), `FADE_MS` (900, cross-fade). Text lives in
`PARAGRAPHS` in the same file.

## Playing

Three ways in, and they are deliberately separate:

**Movement pad** — buttons for turn left / forward / back / turn right, plus
*What do you see?*. One press = one fixed step (`STEP`, 0.45 units) or one 60°
turn (`TURN`), queued and eased. Every move ends with VIN reporting.

**ASK box** — talk to VIN. Free; questions never cost light. Carries the last 6
turns of conversation, so follow-ups work. Typing `forward` / `turn left` here
still works as a shortcut.

**NAME box** — commit to a name. A correct one lights the object up; a wrong one
dims the agent for 3s.

Splitting these was the point: with one box, the game has to *guess* whether
"is it a chair?" is a question or an answer, and the player gets penalised for
thinking out loud. Two boxes, no ambiguity. `↑` / `↓` scroll each box's own
history; Tab hops between them.

All labels and boxes start hidden. A correct name reveals every object with
that label at once — which conveniently defuses the duplicate detections in the
pipeline output (three separate `stool` boxes, three `carpet`). Progress counts
*distinct labels*, not boxes.

A wrong name dims the agent's light for 3s. Penalties stack multiplicatively
(`PENALTY_FALLOFF` in `Game.js`) with a floor at `MIN_LIGHT` so you are never
fully blind.

## How the fog works

One `SplatEdit`, `rgbaBlendMode: MULTIPLY`, `invert: true`. Its SDF shapes mark
the **lit** regions; inverting applies the dark colour everywhere *outside*
them, leaving revealed splats at full original colour.

The alternative — darken globally, then `ADD_RGBA` the lit areas back — does not
work, because ADD adds a flat colour and revealed objects come back as
washed-out blobs rather than themselves.

`sdfs[0]` is always the agent's own sphere of light, so the array is never empty
and the agent has a small personal radius of visibility from the start.

### If the fog comes out backwards

Room lit and objects dark = polarity flipped. Set `INVERT = false` in
`FogOfWar.js`. That is the entire fix.

### Tuning knobs (all in `FogOfWar.js`)

| Constant | Does |
|---|---|
| `DARK` | how black the unlit world is; push toward 0 for a harder fog |
| `SOFT_EDGE` | feathering around each pool of light |
| `SDF_SMOOTH` | how smoothly two overlapping pools merge |
| `BOX_PADDING` | light spill beyond the detected box (boxes hug tightly) |
| `AGENT_LIGHT_RADIUS` | the agent's personal visibility bubble |
| `REVEAL_MS` | grow-in duration of a reveal |

## Console handle

`window.__game = { fog, agent, annotations, sceneManager, THREE }`

```js
__game.game.targetLabels          // the answer key
__game.game.submit("arcade machine")
__game.fog.concealAll()
```

## Files

| File | Owns |
|---|---|
| `FogOfWar.js` | the single inverted MULTIPLY edit; reveal / conceal |
| `Agent.js` | position, heading, queued + eased discrete movement |
| `Vision.js` | the cone query and the facts handed to the LLM |
| `Game.js` | command vs guess, discovery set, penalty stack. No DOM, no THREE |
| `Llm.js` | client for the two endpoints, with offline fallbacks |
| `CommandBar.js` | prompt box, feed, progress bar |

## Vision cone

`HALF_ANGLE` 38°, `RANGE` 1.7 units (both in `Vision.js`). Objects are found by
signed angle rather than raycasting — cheaper, and sorting by that angle gives
the left-to-right reading order that makes descriptions navigable.

**Not modelled yet: occlusion.** VIN can see through the sofa.

## Next

- Occlusion — segment vs the other AABBs is enough.
- Camera follows the agent instead of free orbit.
- Collision: `move forward` currently walks through furniture.
- Curate the 22 detections down to ~8 clean objects as `game/level.json`
  (`out_*/` is gitignored, so level data must live outside it).
