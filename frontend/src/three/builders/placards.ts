/** "Carte proposte" in the 3D view: every placed intervention as a card
 * standing in the square on a stake, the 3D counterpart of the paper cards
 * laid on the map in the original workshop method (see `map/layers.ts`'s
 * card markers for the 2D version).
 *
 * Real-world size, not constant on screen: a placard is a physical object in
 * the scene, so it gets smaller with distance like everything else. Each one
 * turns about its vertical axis to face the camera (see `facePlacards`) but
 * never tilts, so it keeps reading as a sign planted in the ground.
 */

import * as THREE from "three";
import type { CardSpec, Intervention } from "../../api/types";
import { drawCardIcon } from "../../map/cardMarkerIcons";
import { categoryColor } from "../../ui/categoryColors";
import { cardLabel, yearLabel } from "../../i18n/labels";
import { representativePoint, toLocal, type GeoAnchor } from "../geo";
import { drapeLine, type Terrain } from "../terrain";

const PANEL_WIDTH_M = 0.8;
const PANEL_HEIGHT_M = 1.0;
/** Bottom edge of the panel: with a 1.6m eye height the card sits at eye
 * level, readable when walking up to it. */
const PANEL_BOTTOM_M = 1.0;
const STAKE_RADIUS_M = 0.025;

/** Footprint outlines of line/area cards, lifted just clear of the ground
 * covers so they don't z-fight with them. */
const OUTLINE_LIFT_M = 0.1;

const CANVAS_WIDTH_PX = 256;
const CANVAS_HEIGHT_PX = 320;
const BORDER_PX = 12;
const HEADER_PX = 140;

export interface Placards {
  group: THREE.Group;
  /** One per placard, rotated each frame to face the camera. */
  pivots: THREE.Object3D[];
  /** The card faces, for click picking; `userData.interventionId` is set. */
  panels: THREE.Mesh[];
}

export function buildPlacards(
  interventions: Intervention[],
  cards: CardSpec[],
  anchor: GeoAnchor,
  terrain: Terrain,
  t: number
): Placards {
  const group = new THREE.Group();
  group.name = "placards";
  const pivots: THREE.Object3D[] = [];
  const panels: THREE.Mesh[] = [];

  const stakeGeometry = new THREE.CylinderGeometry(STAKE_RADIUS_M, STAKE_RADIUS_M, PANEL_BOTTOM_M + PANEL_HEIGHT_M * 0.5, 8);
  stakeGeometry.translate(0, (PANEL_BOTTOM_M + PANEL_HEIGHT_M * 0.5) / 2, 0);
  const stakeMaterial = new THREE.MeshStandardMaterial({ color: 0x7a5a3a, roughness: 0.9 });
  const panelGeometry = new THREE.PlaneGeometry(PANEL_WIDTH_M, PANEL_HEIGHT_M);
  panelGeometry.translate(0, PANEL_BOTTOM_M + PANEL_HEIGHT_M / 2, 0);

  for (const iv of interventions) {
    // Same rule the model applies to the full geometry: an intervention
    // placed while previewing a later year doesn't exist yet at this t.
    if (t < iv.planted_year) continue;
    const card = cards.find((c) => c.card_type === iv.card_type);
    const color = card ? categoryColor(card.category, "#5b6472") : "#5b6472";

    const [lng, lat] = representativePoint(iv.geometry);
    const [x, z] = toLocal(anchor, lng, lat);

    const pivot = new THREE.Group();
    pivot.position.set(x, terrain.heightAt(x, z), z);

    const stake = new THREE.Mesh(stakeGeometry, stakeMaterial);
    stake.castShadow = true;
    // Just behind the panel, so it reads as holding it up rather than
    // poking through the face.
    stake.position.z = -0.03;
    pivot.add(stake);

    const texture = new THREE.CanvasTexture(drawPlacard(iv, card, color));
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 4;
    const panel = new THREE.Mesh(
      panelGeometry,
      // Unlit: a card has to stay readable in the shade and at dusk, which
      // is when a lit one would fade to a dark rectangle.
      new THREE.MeshBasicMaterial({ map: texture, side: THREE.DoubleSide, toneMapped: false })
    );
    panel.castShadow = true;
    panel.userData.interventionId = iv.id;
    pivot.add(panel);

    group.add(pivot);
    pivots.push(pivot);
    panels.push(panel);

    const outline = buildOutline(iv.geometry, anchor, terrain, color);
    if (outline) group.add(outline);
  }

  return { group, pivots, panels };
}

/** Turns every placard to face the camera, about the vertical axis only. */
export function facePlacards(placards: Placards, camera: THREE.Camera): void {
  for (const pivot of placards.pivots) {
    pivot.rotation.y = Math.atan2(camera.position.x - pivot.position.x, camera.position.z - pivot.position.z);
  }
}

/** Placards own their geometry, materials and canvas textures (none of it
 * comes from the shared MaterialLibrary), so all of it goes here. */
export function disposePlacards(placards: Placards): void {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  placards.group.traverse((child) => {
    if (child instanceof THREE.Mesh || child instanceof THREE.Line) {
      geometries.add(child.geometry);
      const list = Array.isArray(child.material) ? child.material : [child.material];
      for (const material of list) materials.add(material);
    }
  });
  for (const geometry of geometries) geometry.dispose();
  for (const material of materials) {
    if (material instanceof THREE.MeshBasicMaterial) material.map?.dispose();
    material.dispose();
  }
}

function drawPlacard(iv: Intervention, card: CardSpec | undefined, color: string): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = CANVAS_WIDTH_PX;
  canvas.height = CANVAS_HEIGHT_PX;
  const ctx = canvas.getContext("2d")!;

  // Card body with the category colour as a frame, like the palette buttons.
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, CANVAS_WIDTH_PX, CANVAS_HEIGHT_PX);
  ctx.fillStyle = "#fbfaf6";
  ctx.fillRect(BORDER_PX, HEADER_PX, CANVAS_WIDTH_PX - BORDER_PX * 2, CANVAS_HEIGHT_PX - HEADER_PX - BORDER_PX);

  const iconPx = 104;
  drawCardIcon(ctx, iv.card_type, "#ffffff", (CANVAS_WIDTH_PX - iconPx) / 2, (HEADER_PX - iconPx) / 2, iconPx);

  ctx.fillStyle = "#222";
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  ctx.font = "bold 26px system-ui, sans-serif";
  const lines = wrapText(ctx, card ? cardLabel(card) : iv.card_type, CANVAS_WIDTH_PX - BORDER_PX * 2 - 16).slice(0, 3);
  lines.forEach((line, i) => ctx.fillText(line, CANVAS_WIDTH_PX / 2, HEADER_PX + 16 + i * 32));

  ctx.fillStyle = "#666";
  ctx.font = "22px system-ui, sans-serif";
  ctx.textBaseline = "bottom";
  ctx.fillText(yearLabel(iv.planted_year), CANVAS_WIDTH_PX / 2, CANVAS_HEIGHT_PX - BORDER_PX - 10);

  return canvas;
}

function wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidthPx: number): string[] {
  const lines: string[] = [];
  let current = "";
  for (const word of text.split(/\s+/)) {
    const candidate = current ? `${current} ${word}` : word;
    if (current && ctx.measureText(candidate).width > maxWidthPx) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines;
}

/** A thin ground outline of what a line or area card covers — the placard
 * alone only says *that* something is proposed here, not how far it
 * reaches. Point cards need none. */
function buildOutline(geometry: GeoJSON.Geometry, anchor: GeoAnchor, terrain: Terrain, color: string): THREE.Object3D | null {
  const rings: GeoJSON.Position[][] =
    geometry.type === "LineString"
      ? [geometry.coordinates]
      : geometry.type === "Polygon"
        ? geometry.coordinates
        : geometry.type === "MultiPolygon"
          ? geometry.coordinates.flat()
          : [];
  if (rings.length === 0) return null;

  const material = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.85 });
  const group = new THREE.Group();
  for (const ring of rings) {
    const local = ring.map(([lng, lat]) => toLocal(anchor, lng, lat));
    const points = drapeLine(terrain, local, OUTLINE_LIFT_M).map(([x, y, z]) => new THREE.Vector3(x, y, z));
    group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), material));
  }
  return group;
}
