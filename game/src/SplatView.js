import * as THREE from "three";
import { SplatMesh } from "@sparkjsdev/spark";

// Game fork of the viewer's SplatView. The upstream version owned a hover
// highlight via SplatMesh.edits; here FogOfWar owns `edits` instead (only one
// thing may, or they clobber each other), so this class is reduced to loading.
export class SplatView {
  constructor(sceneManager, { onLoad } = {}) {
    this.sceneManager = sceneManager;
    this.mesh = null;
    this._onLoad = onLoad;
  }

  async load(source) {
    if (this.mesh) {
      this.sceneManager.remove(this.mesh);
      this.mesh = null;
    }

    const isUrl = typeof source === "string";
    const fileName = isUrl ? source.split("/").pop() : source.name;
    const buffer = isUrl
      ? await fetch(source).then((r) => r.arrayBuffer())
      : await source.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    const isBaked = fileName.toLowerCase().endsWith(".rad");

    this.mesh = new SplatMesh({
      fileBytes: bytes,
      fileName,
      lod: isBaked ? undefined : true,
      onLoad: (mesh) => {
        // This π rotation about X defines viewer world space; AnnotationParser
        // mirrors it so the boxes line up.
        mesh.rotation.x = Math.PI;
        mesh.editable = true;
        mesh.updateMatrixWorld(true);
        const box = new THREE.Box3().setFromObject(mesh);
        this.sceneManager.frameBounds(box);
        this._onLoad?.(mesh, box);
      },
    });
    this.sceneManager.add(this.mesh);
  }
}
