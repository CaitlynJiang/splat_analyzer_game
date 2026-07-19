import { BoundingBox } from "./BoundingBox.js";
import { Marker } from "./Marker.js";

// Pairs one annotation's box and marker. Hovering the marker reveals the box
// and forwards hover events outward (so the splat itself can react).
export class AnnotatedObject {
  constructor(annotation, hooks = {}) {
    this.annotation = annotation;
    this.discovered = false;
    this.box = new BoundingBox(annotation);
    this.marker = new Marker(annotation, {
      onHoverStart: () => {
        this.box.show();
        hooks.onHoverStart?.(annotation);
      },
      onHoverEnd: () => {
        // A named object keeps its box; only exploratory hovers hide again.
        if (!this.discovered) this.box.hide();
        hooks.onHoverEnd?.(annotation);
      },
    });
  }

  // Called when the player names this object correctly.
  setDiscovered() {
    this.discovered = true;
    this.box.show();
  }

  addTo(sceneManager) {
    sceneManager.add(this.box.group);
    sceneManager.add(this.marker.dotObject);
    sceneManager.add(this.marker.hoverLabelObject);
  }

  removeFrom(sceneManager) {
    sceneManager.remove(this.box.group);
    sceneManager.remove(this.marker.dotObject);
    sceneManager.remove(this.marker.hoverLabelObject);
  }
}
