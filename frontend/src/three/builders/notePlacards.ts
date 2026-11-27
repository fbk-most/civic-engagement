/** The notes in the 3D view: each a speech bubble with its title on a
 * stake, built like the cards' placards (`placards.ts`) — real-world size,
 * turned to face the camera about the vertical axis (`facePlacards`) — and
 * taller than them, so that a note stands out over the cards around it. */

import * as THREE from "three";
import type { Note } from "../../api/types";
import { drawBubble } from "../../notes/bubble";
import { toLocal, type GeoAnchor } from "../geo";
import type { Terrain } from "../terrain";
import type { Placards } from "./placards";

/** The bubble's height; its width follows its title. */
const BUBBLE_HEIGHT_M = 0.7;
/** The tail's tip: above the cards' placards (2 m), below a tree's crown. */
const BUBBLE_BOTTOM_M = 2.3;
const STAKE_RADIUS_M = 0.02;
/** Device pixels per CSS pixel of the bubble's drawing: sharp up close. */
const TEXTURE_SCALE = 6;

/** `panels[i].userData.noteId` is the note's id, for picking. */
export function buildNotePlacards(notes: Note[], color: string, anchor: GeoAnchor, terrain: Terrain): Placards {
  const group = new THREE.Group();
  group.name = "note-placards";
  const pivots: THREE.Object3D[] = [];
  const panels: THREE.Mesh[] = [];

  const stakeHeight = BUBBLE_BOTTOM_M + BUBBLE_HEIGHT_M * 0.3;
  const stakeGeometry = new THREE.CylinderGeometry(STAKE_RADIUS_M, STAKE_RADIUS_M, stakeHeight, 6);
  stakeGeometry.translate(0, stakeHeight / 2, 0);
  const stakeMaterial = new THREE.MeshStandardMaterial({ color: 0x555555, roughness: 0.8 });

  for (const note of notes) {
    const [lng, lat] = note.geometry.coordinates;
    const [x, z] = toLocal(anchor, lng, lat);
    const pivot = new THREE.Group();
    pivot.position.set(x, terrain.heightAt(x, z), z);

    const stake = new THREE.Mesh(stakeGeometry, stakeMaterial);
    stake.castShadow = true;
    stake.position.z = -0.03;
    pivot.add(stake);

    const canvas = drawBubble(note.title, color, TEXTURE_SCALE);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 4;
    const width = (BUBBLE_HEIGHT_M * canvas.width) / canvas.height;
    const geometry = new THREE.PlaneGeometry(width, BUBBLE_HEIGHT_M);
    geometry.translate(0, BUBBLE_BOTTOM_M + BUBBLE_HEIGHT_M / 2, 0);
    // Unlit, as the cards' faces; cut out around the bubble.
    const panel = new THREE.Mesh(
      geometry,
      new THREE.MeshBasicMaterial({ map: texture, side: THREE.DoubleSide, toneMapped: false, alphaTest: 0.5 })
    );
    panel.userData.noteId = note.id;
    pivot.add(panel);

    group.add(pivot);
    pivots.push(pivot);
    panels.push(panel);
  }
  return { group, pivots, panels };
}
