import * as THREE from "three";
import { SceneManager } from "./SceneManager.js";
import { SplatView } from "./SplatView.js";
import { AnnotationParser } from "./AnnotationParser.js";
import { AnnotationLayer } from "./AnnotationLayer.js";
import { SettingsMenu } from "./SettingsMenu.js";
import { FogOfWar } from "./FogOfWar.js";
import { Agent } from "./Agent.js";
import { Vision } from "./Vision.js";
import { Game } from "./Game.js";
import { CommandBar } from "./CommandBar.js";
import { Intro } from "./Intro.js";
import { Llm } from "./Llm.js";

// Served from the repo root (game_server.py, or `python3 -m http.server` there),
// so these resolve to the pipeline's own inputs and outputs as siblings.
//
// NOTE: the .ply is ~208 MB and its LOD tree is built in a worker on every page
// load. If iteration feels slow, MGstudio_SmallRoom.spz is the same scene at
// 15 MB and loads in about a second.
const DEFAULT_SPLAT_URL = "../MGstudio_SmallRoom.ply";
const DEFAULT_ANNOTATIONS_URL = "../out_MGstudio_SmallRoom/interactions.json";

const sceneManager = new SceneManager(document.getElementById("viewport"));
const fog = new FogOfWar();
const agent = new Agent();
const vision = new Vision(agent);

const game = new Game({ agent, fog, vision, onChange: () => syncDiscovered() });
const bar = new CommandBar(game);

// The intro plays over the top while the splat streams in; the game only
// becomes playable once BOTH are done.
let splatReady;
const splatLoaded = new Promise((resolve) => (splatReady = resolve));

const splatView = new SplatView(sceneManager, {
  onLoad: (mesh) => {
    fog.attach(mesh);
    splatReady();
  },
});

// Labels and boxes stay dark until the player has named the object.
const annotationLayer = new AnnotationLayer(sceneManager, {
  isVisible: (annotation) => game.isDiscovered(annotation),
});

function syncDiscovered() {
  for (const obj of annotationLayer.objects) {
    if (!obj.discovered && game.isDiscovered(obj.annotation)) obj.setDiscovered();
  }
}

agent.addTo(sceneManager);
document.getElementById("empty-hint").classList.add("hidden");

new SettingsMenu({
  onSplatFile: async (file) => {
    await splatView.load(file);
  },
  onAnnotationsFile: async (file) => {
    const annotations = await AnnotationParser.parse(file);
    annotationLayer.rebuild(annotations);
    game.setAnnotations(annotations);
    bar.refresh();
  },
});

sceneManager.addFrameListener(() => {
  fog.setAgentPosition(agent.update());
  game.update();
  fog.update();
});

sceneManager.start();

// ── boot ─────────────────────────────────────────────────────────────────────
const intro = new Intro();

splatView.load(DEFAULT_SPLAT_URL).catch((e) => {
  bar.say(`Could not load the splat: ${e.message}`, "cb-miss");
  bar.say("Serve from the repo root, not from game/.", "cb-dim");
  splatReady(); // let the player through to see the error rather than hang
});

intro.play().then(async () => {
  // Skipping past the crawl shouldn't skip past physics — if the scan is still
  // arriving, say so instead of dropping the player into an empty room.
  intro.setStatus("Reconstructing the scan…");
  await splatLoaded;
  await intro.dismiss();
  bar.say("Signal acquired. VIN is standing in the dark with you.", "cb-dim");
  bar.unlock();
});

AnnotationParser.parse(DEFAULT_ANNOTATIONS_URL).then((annotations) => {
  annotationLayer.rebuild(annotations);
  game.setAnnotations(annotations);
  bar.refresh();

  Llm.health().then((h) => {
    if (!h.ok) {
      bar.say("(no game_server.py — VIN is running on canned text)", "cb-miss");
    } else if (!h.llm) {
      bar.say("(VIN is running on canned text — the model is not answering)", "cb-miss");
      if (h.error) bar.say(`  ${h.error}`, "cb-dim");
      bar.say("  full diagnosis: localhost:8000/api/health", "cb-dim");
    }
  });

  // Console handle for tuning / cheating during dev.
  window.__game = { game, fog, agent, vision, annotations, annotationLayer, sceneManager, bar, THREE };
});
