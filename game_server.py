"""
Game server — static files + the two LLM calls the game needs.

Deliberately separate from server.py: that one imports the whole detection
pipeline (torch, gsplat, sqlite, admin panel). This needs none of it, so the
game stays runnable on a laptop with no GPU.

    pip install fastapi uvicorn httpx python-dotenv
    python game_server.py
    # → http://localhost:8000/game/

Configure the model in .env (any OpenAI-compatible endpoint — DashScope/Qwen,
OpenAI, DeepSeek, Groq, a local vLLM or Ollama, …):

    LLM_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
    LLM_MODEL=qwen-plus
    LLM_API_KEY=sk-...

With no key set, both endpoints fall back to local templates so the game is
still playable and demoable offline.
"""
import os, json, re, asyncio, logging, urllib.request, urllib.error
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

# httpx is nicer but not worth a hard dependency — one missing package should
# not stop the server from booting at all (it did, once, and cost us an hour).
# Stdlib urllib on a thread does the same job.
try:
    import httpx
    HAVE_HTTPX = True
except ImportError:
    httpx = None
    HAVE_HTTPX = False

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("game")

ROOT = Path(__file__).parent
ENV_PATH = ROOT / ".env"

# Silently ignoring a missing/unreadable .env is how you spend twenty minutes
# wondering why the model sounds like a template. Be loud about all three ways
# this goes wrong.
DOTENV_NOTE = ""
if not ENV_PATH.exists():
    DOTENV_NOTE = f"no .env file at {ENV_PATH} — copy .env.example to .env"
    log.warning(DOTENV_NOTE)
else:
    try:
        from dotenv import load_dotenv
        load_dotenv(ENV_PATH)
        log.info("loaded %s", ENV_PATH)
    except ImportError:
        DOTENV_NOTE = ".env exists but python-dotenv is not installed — "\
                      "run: pip install python-dotenv"
        log.warning(DOTENV_NOTE)
BASE_URL = os.getenv("LLM_BASE_URL", "https://dashscope.aliyuncs.com/compatible-mode/v1")
MODEL    = os.getenv("LLM_MODEL", "qwen-plus")
API_KEY  = os.getenv("LLM_API_KEY", "")
TIMEOUT  = float(os.getenv("LLM_TIMEOUT", "12"))

# Gemini 3.x and friends are reasoning models: they spend tokens thinking before
# they answer. With a small max_tokens the thinking eats the whole budget and
# you get a sentence that stops mid-word. Give it room, and turn the thinking
# down — this is a two-sentence description, not a maths olympiad.
REASONING = os.getenv("LLM_REASONING_EFFORT", "none")  # none | low | medium | high | ""

app = FastAPI(title="Splat Analyzer Game")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

_describe_cache: dict[str, str] = {}


# ── LLM plumbing ─────────────────────────────────────────────────────────────
async def _post_json(url: str, headers: dict, payload: dict, timeout: float):
    """POST JSON, returning (status_code, body_text). Uses httpx when present,
    stdlib urllib on a worker thread otherwise."""
    if HAVE_HTTPX:
        async with httpx.AsyncClient(timeout=timeout) as client:
            r = await client.post(url, headers=headers, json=payload)
            return r.status_code, r.text

    def _blocking():
        req = urllib.request.Request(
            url,
            data=json.dumps(payload).encode(),
            headers={**headers, "Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return resp.status, resp.read().decode()
        except urllib.error.HTTPError as e:
            return e.code, e.read().decode(errors="replace")

    return await asyncio.to_thread(_blocking)


async def chat(system: str, user: str, history: list | None = None,
               max_tokens: int = 800, temperature: float = 0.9,
               clean: bool = True) -> str | None:
    """One OpenAI-compatible chat completion. None on any failure — every
    caller has a local fallback, because a dead API must not kill the demo."""
    if not API_KEY:
        return None
    messages = [{"role": "system", "content": system}]
    messages += history or []
    messages.append({"role": "user", "content": user})

    payload = {"model": MODEL, "messages": messages,
               "temperature": temperature, "max_tokens": max_tokens}
    if REASONING:
        payload["reasoning_effort"] = REASONING

    url = f"{BASE_URL.rstrip('/')}/chat/completions"
    headers = {"Authorization": f"Bearer {API_KEY}"}

    try:
        status, body = await _post_json(url, headers, payload, TIMEOUT)

        # Not every provider knows reasoning_effort. If that's the complaint,
        # drop it and try once more rather than falling back to canned text.
        if status == 400 and "reasoning" in body.lower():
            log.info("provider rejected reasoning_effort — retrying without it")
            payload.pop("reasoning_effort", None)
            status, body = await _post_json(url, headers, payload, TIMEOUT)

        if status != 200:
            log.warning("LLM HTTP %s: %s — using fallback", status, body[:300])
            return None

        choice = json.loads(body)["choices"][0]
        text = (choice.get("message", {}).get("content") or "").strip()

        if choice.get("finish_reason") == "length":
            log.warning("reply hit the token ceiling — raise max_tokens or "
                        "lower LLM_REASONING_EFFORT")
        if not text:
            log.warning("empty content (finish_reason=%s) — thinking probably "
                        "consumed the budget", choice.get("finish_reason"))
            return None

        return clean_reply(text) if clean else text
    except Exception as e:
        log.warning("LLM call failed (%s) — using fallback", e)
        return None


# Models sometimes continue the system prompt instead of answering it — you get
# "Constraints:** * Maximum TWO" echoed straight into the feed. Strip anything
# that looks like instructions leaking through, plus the markdown VIN should
# never be emitting anyway.
_LEAK_MARKERS = re.compile(
    r"^(constraints?\b|rules?\b|style\b|how you talk\b|the one hard rule\b"
    r"|answer the question actually asked|maximum \w+ sentence|never write\b"
    r"|reply (with|in at most)\b|you speak in\b|no labels\b)",
    re.I,
)


def clean_reply(text: str) -> str:
    """Strip formatting first, THEN drop instruction lines — otherwise a
    perfectly good sentence in **bold** looks like a bullet and gets binned."""
    kept = []
    for line in text.splitlines():
        line = re.sub(r"\*+|`+|^#+", "", line)          # markdown
        line = re.sub(r"^\s*[-•–]\s+", "", line)        # bullet markers
        line = line.strip()
        if not line or _LEAK_MARKERS.match(line):
            continue
        kept.append(line)

    out = re.sub(r"\s{2,}", " ", " ".join(kept)).strip()
    # Hard cap at two sentences: it's the one rule that keeps the feed readable,
    # and models treat it as a suggestion.
    return " ".join(re.split(r"(?<=[.!?])\s+", out)[:2]).strip()


# ── /api/ask ─────────────────────────────────────────────────────────────────
# Written as prose on purpose. An earlier version used bulleted "Constraints:"
# and "How you talk:" sections, and the model kept continuing the document
# instead of answering it — bullet fragments came back verbatim in the feed.
# Flowing paragraphs are much harder to accidentally autocomplete.
VIN_SYSTEM = """You are VIN, a daemon built out of scavenged code. It is 3018. \
The AI took the digital world for good, and what is left of humanity, the \
Unindexed, lost their permissions and went to ground. Your operator is a \
descendant of the necromancers, the last lineage that remembers the old myth of \
prompting: name a thing correctly and it must appear to you. They stitched you \
together out of dead virtual environments so the system would read you as a \
trusted process. You walk through places they cannot see, and you report back.

You never write the name of anything you can see. Their whole task is to work \
out what a thing is from your report and name it themselves, so you are told \
each object's true name only in order to describe it accurately. That word, its \
plural and any obvious synonym must never appear in what you say. Asked point \
blank what something is, you deflect: daemons do not answer the Unindexed, you \
only report what you find.

You speak in first person, clipped and a little cold, in no more than two \
sentences, because the channel is bad and nobody is reading an essay. You answer \
the question you were actually asked, and you anchor things by bearing and \
distance so your operator can steer you. You invent freely otherwise — wear, \
dust, the quality of the light, the hum of a thing, how old the data feels — \
because this room is a scan of somewhere a person used to live. If nothing is in \
range you say so plainly and stop.

Reply with nothing but what VIN says. No labels, no formatting, no notes."""


class Observation(BaseModel):
    id: int
    secret_label: str
    bearing: str
    distance: str
    build: str
    bulk: str


class Turn(BaseModel):
    role: str
    content: str


class AskReq(BaseModel):
    observations: list[Observation]
    question: str | None = None
    history: list[Turn] = []


def banned_words(labels: list[str]) -> list[str]:
    out = set()
    for l in labels:
        l = l.lower()
        out.add(l)
        out.update(w for w in l.split() if len(w) > 2)
    return sorted(out)


def leaks(text: str, labels: list[str]) -> bool:
    t = text.lower()
    return any(re.search(rf"\b{re.escape(w)}s?\b", t) for w in banned_words(labels))


def fallback_ask(obs: list[Observation], question: str | None) -> str:
    if not obs:
        return "Nothing in range. Only floor."
    o = obs[0]
    lead = f"{o.bearing.capitalize()}, {o.distance}. Something {o.build}, {o.bulk}."
    if len(obs) > 1:
        lead += f" Another shape {obs[1].bearing}."
    if question:
        lead += " That is all this channel will carry."
    return lead


@app.post("/api/ask")
async def ask(req: AskReq):
    obs = req.observations
    question = (req.question or "").strip()

    if not obs:
        return {"text": "Nothing in range. Only floor.", "source": "empty"}

    # Only cache the plain "what do you see" case — real questions vary too much
    # to key on, and repeating a canned answer would kill the conversation.
    key = None
    if not question:
        key = json.dumps([o.model_dump() for o in obs], sort_keys=True)
        if key in _describe_cache:
            return {"text": _describe_cache[key], "source": "cache"}

    labels = [o.secret_label for o in obs]
    payload = json.dumps([o.model_dump() for o in obs], indent=2)
    banned = ", ".join(banned_words(labels))
    user = (
        f"What is in range right now, nearest first, ordered left to right:\n{payload}\n\n"
        + (f"Your operator asks: {question!r}\n\n" if question
           else "Your operator is waiting on a report.\n\n")
        + f"Reply in at most two sentences. Never write any of these words: {banned}"
    )

    history = [t.model_dump() for t in req.history][-6:]
    text = await chat(VIN_SYSTEM, user, history=history)

    # Models leak the name surprisingly often. One retry with a harder nudge,
    # then give up and use the template rather than spoil the puzzle.
    if text and leaks(text, labels):
        log.info("reply leaked a label — retrying")
        text = await chat(
            VIN_SYSTEM,
            user + "\n\nYour previous attempt used a forbidden word. Rewrite it "
                   "using only shape, size, material, wear and position.",
            history=history,
        )
        if text and leaks(text, labels):
            text = None

    if not text:
        return {"text": fallback_ask(obs, question), "source": "fallback"}

    if key:
        _describe_cache[key] = text
    return {"text": text, "source": "llm"}


# ── /api/judge ───────────────────────────────────────────────────────────────
JUDGE_SYSTEM = """You decide whether a player's guess refers to the same object \
as one of the candidate names in a 3D scan.

Be generous about wording, strict about identity. "seat"/"stool", "sofa"/"couch", \
"rug"/"carpet", "plant"/"potted plant", "TV"/"television" are all matches. \
"chair" vs "table" is not. A guess that is merely in the same room is not a match.

Reply with ONLY a JSON object, no markdown fence:
{"match": "<exact candidate string>"} or {"match": null}"""


class JudgeReq(BaseModel):
    guess: str
    candidates: list[str]


def normalize(s: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9\s]", "", s.lower())).strip()


@app.post("/api/judge")
async def judge(req: JudgeReq):
    g = normalize(req.guess)

    # Exact match never needs a model call.
    for c in req.candidates:
        if normalize(c) == g:
            return {"match": c, "source": "exact"}

    # max_tokens must leave room for the model to think before it emits the
    # JSON; 60 was enough for the answer and not enough to reach it.
    raw = await chat(
        JUDGE_SYSTEM,
        f"Candidates: {json.dumps(req.candidates)}\nPlayer's guess: {req.guess!r}",
        max_tokens=400,
        temperature=0,
        clean=False,  # this one returns JSON; the prose cleanup would mangle it
    )
    if raw:
        try:
            m = json.loads(re.sub(r"^```(?:json)?|```$", "", raw.strip(), flags=re.M).strip())
            match = m.get("match")
            if match in req.candidates:
                return {"match": match, "source": "llm"}
            if match is None:
                return {"match": None, "source": "llm"}
        except Exception:
            log.warning("judge returned unparseable output: %r", raw)

    # Offline fallback: substring containment, which catches the common
    # "sofa" -> "white sofa" case without pretending to be clever.
    for c in req.candidates:
        n = normalize(c)
        if g and (g in n or n in g):
            return {"match": c, "source": "substring"}
    return {"match": None, "source": "fallback"}


@app.get("/api/models")
async def models():
    """What this key can actually reach. Model names rot — gemini-2.5-flash was
    retired for new users mid-project — so make the live list one click away."""
    if not API_KEY:
        return {"error": "LLM_API_KEY is empty", "models": []}

    url = f"{BASE_URL.rstrip('/')}/models"
    headers = {"Authorization": f"Bearer {API_KEY}"}
    try:
        if HAVE_HTTPX:
            async with httpx.AsyncClient(timeout=TIMEOUT) as client:
                r = await client.get(url, headers=headers)
                status, body = r.status_code, r.text
        else:
            def _blocking():
                req = urllib.request.Request(url, headers=headers, method="GET")
                try:
                    with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
                        return resp.status, resp.read().decode()
                except urllib.error.HTTPError as e:
                    return e.code, e.read().decode(errors="replace")
            status, body = await asyncio.to_thread(_blocking)

        if status != 200:
            return {"error": f"HTTP {status}: {body[:400]}", "models": []}

        data = json.loads(body).get("data", [])
        ids = sorted(m.get("id", "").replace("models/", "") for m in data)
        return {"current": MODEL, "count": len(ids), "models": ids}
    except Exception as e:
        return {"error": f"{type(e).__name__}: {e}", "models": []}


@app.get("/api/health")
async def health(probe: bool = True):
    """Actually calls the model. A health check that only reports config is
    useless — the failure you care about (bad key, wrong model name, no
    network) only shows up on a real request."""
    out = {
        "ok": True,
        "env_file": ENV_PATH.exists(),
        "base_url": BASE_URL,
        "model": MODEL,
        "key_set": bool(API_KEY),
        "key_len": len(API_KEY),
        "note": DOTENV_NOTE or None,
        "llm": False,
        "error": None,
    }

    if not API_KEY:
        out["error"] = DOTENV_NOTE or "LLM_API_KEY is empty"
        return out

    try:
        status, body = await _post_json(
            f"{BASE_URL.rstrip('/')}/chat/completions",
            {"Authorization": f"Bearer {API_KEY}"},
            {"model": MODEL,
             "messages": [{"role": "user", "content": "reply with: ok"}],
             "max_tokens": 5},
            TIMEOUT,
        )
        if status == 200:
            out["llm"] = True
        else:
            # Surface the provider's own message; it is nearly always specific
            # ("API key not valid", "model not found", "quota exceeded").
            out["error"] = f"HTTP {status}: {body[:400]}"
    except Exception as e:
        out["error"] = f"{type(e).__name__}: {e}"

    return out


# Static last so /api/* wins. Serving the repo root means game/ can reach the
# .spz and the pipeline's out_*/interactions.json as siblings.
app.mount("/", StaticFiles(directory=str(ROOT), html=True), name="root")


if __name__ == "__main__":
    import uvicorn
    print("─" * 62)
    print(f"  .env      {'found' if ENV_PATH.exists() else 'MISSING — copy .env.example to .env'}")
    print(f"  base_url  {BASE_URL}")
    print(f"  model     {MODEL}")
    print(f"  api_key   {'set (%d chars)' % len(API_KEY) if API_KEY else 'EMPTY — VIN will use canned text'}")
    print(f"  http      {'httpx' if HAVE_HTTPX else 'urllib (stdlib) — pip install httpx for async'}")
    if DOTENV_NOTE:
        print(f"  ⚠  {DOTENV_NOTE}")
    print("  check     http://localhost:8000/api/health")
    print("  models    http://localhost:8000/api/models")
    print("─" * 62)
    uvicorn.run(app, host="0.0.0.0", port=8000)
