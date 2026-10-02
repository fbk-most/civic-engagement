#!/usr/bin/env node
/** Turns the crowd's source models — Quaternius characters, dogs and cars, all CC0
 * (see public/assets/3d/CREDITS.md) — into the compact .glb files the 3D
 * view loads.
 *
 * Each source character is ~10 primitives with one material each, which
 * means ~10 draw calls per person (twice that with shadows) — too many for a
 * square with dozens of people. This merges every material into one small
 * palette texture and joins all primitives into a single skinned mesh, so a
 * figure costs one draw call. It also drops props that don't belong in a
 * civic scene (a pistol) and every animation except the few the crowd uses
 * (renaming them to plain names), which is most of the file size, and
 * compresses what's left with meshopt.
 *
 * Usage: node scripts/prepare-crowd-assets.mjs <folder with the source files, named as in MANIFEST>
 * Output: public/assets/3d/{people,animals,vehicles}/<name>.glb
 */

import { existsSync, mkdirSync } from "node:fs";
import { dirname, join as joinPath } from "node:path";
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { dedup, flatten, join, joinPrimitives, meshopt, palette, prune, resample } from "@gltf-transform/functions";
import { MeshoptEncoder } from "meshoptimizer";

const PERSON_CLIPS = { Idle: "Idle", Idle_Neutral: "Idle_Neutral", Walk: "Walk" };
// Finger curls are invisible at the distance a crowd is seen from.
const FINGER_BONE = /^(Index|Middle|Ring|Pinky|Thumb)\d/;
const person = (source, dropNodes = []) => ({
  source,
  output: `people/${source.replace(/\.gltf$/, ".glb")}`,
  clips: PERSON_CLIPS,
  dropNodes,
  dropTracks: FINGER_BONE,
});

const MANIFEST = [
  person("m-casual2.gltf"),
  person("m-hoodie.gltf"),
  person("m-suit.gltf", ["Pistol"]),
  person("m-beach.gltf"),
  person("w-casual.gltf"),
  person("w-formal.gltf"),
  person("w-suit.gltf"),
  person("w-adventurer.gltf"),
  { source: "husky.glb", output: "animals/husky.glb", clips: { Walk: "Walk", Idle: "Idle", Idle_2_HeadLow: "Sniff" } },
  // Vehicles are rigid (drawn instanced, one batch per model — see
  // src/three/people/traffic.ts), so everything, wheels included, is merged
  // into a single mesh.
  { source: "car-a.glb", output: "vehicles/car-a.glb", clips: {}, rigid: true },
  { source: "car-b.glb", output: "vehicles/car-b.glb", clips: {}, rigid: true },
  { source: "suv.glb", output: "vehicles/suv.glb", clips: {}, rigid: true },
  { source: "sports.glb", output: "vehicles/sports.glb", clips: {}, rigid: true },
];

const inputDir = process.argv[2];
if (!inputDir) {
  console.error("Usage: node scripts/prepare-crowd-assets.mjs <folder with the source files>");
  process.exit(1);
}
const outputRoot = new URL("../public/assets/3d/", import.meta.url).pathname;

await MeshoptEncoder.ready;
const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({ "meshopt.encoder": MeshoptEncoder });

/** glTF-Transform's `join()` leaves skinned meshes alone, and these models
 * are split into several nodes (body/feet/head/legs...). They all share one
 * skin, though, and a skinned mesh's vertices are in the skin's space (the
 * node transform is ignored), so their primitives can simply be
 * concatenated into one — valid once `palette()` has left a single
 * material. */
function joinSkinnedMeshes(document) {
  const root = document.getRoot();
  const nodes = root.listNodes().filter((node) => node.getMesh() && node.getSkin());
  const skins = new Set(nodes.map((node) => node.getSkin()));
  if (skins.size !== 1) throw new Error(`expected one shared skin, found ${skins.size}`);
  const primitives = nodes.flatMap((node) => node.getMesh().listPrimitives());
  if (primitives.length === 1) return;
  const materials = new Set(primitives.map((prim) => prim.getMaterial()));
  if (materials.size !== 1) throw new Error(`expected one material after palette(), found ${materials.size}`);

  // A few parts carry leftover vertex colours; the others don't, which
  // blocks the join, and three would multiply them into the palette colour.
  for (const prim of primitives) if (prim.getAttribute("COLOR_0")) prim.setAttribute("COLOR_0", null);

  const merged = joinPrimitives(primitives);
  const mesh = document.createMesh("Character").addPrimitive(merged);
  nodes[0].setMesh(mesh).setName("Character");
  for (const node of nodes.slice(1)) node.dispose();
}

for (const entry of MANIFEST) {
  const sourcePath = joinPath(inputDir, entry.source);
  if (!existsSync(sourcePath)) {
    console.warn(`skipping ${entry.source}: not found in ${inputDir}`);
    continue;
  }
  const document = await io.read(sourcePath);
  const root = document.getRoot();

  for (const node of root.listNodes()) {
    if (entry.dropNodes?.includes(node.getName())) node.dispose();
  }
  for (const animation of root.listAnimations()) {
    const rename = entry.clips[animation.getName()];
    if (!rename) {
      // Disposing an animation leaves its samplers (and their keyframe
      // accessors) alive, so they have to go explicitly.
      for (const sampler of animation.listSamplers()) sampler.dispose();
      animation.dispose();
      continue;
    }
    animation.setName(rename);
    for (const channel of animation.listChannels()) {
      const bone = channel.getTargetNode()?.getName() ?? "";
      if (channel.getTargetPath() === "scale" || entry.dropTracks?.test(bone)) {
        channel.getSampler()?.dispose();
        channel.dispose();
      }
    }
  }

  await document.transform(prune(), dedup(), palette({ min: 2 }));
  if (entry.rigid) await document.transform(flatten(), join({ keepNamed: false }));
  else joinSkinnedMeshes(document);
  // meshopt() quantizes too; the loader needs MeshoptDecoder (see
  // src/three/people/assets.ts).
  await document.transform(resample(), dedup(), prune(), meshopt({ encoder: MeshoptEncoder }));

  const outputPath = joinPath(outputRoot, entry.output);
  mkdirSync(dirname(outputPath), { recursive: true });
  const primitives = root.listMeshes().reduce((n, mesh) => n + mesh.listPrimitives().length, 0);
  await io.write(outputPath, document);
  console.log(`${entry.output}: ${primitives} primitive(s), ${root.listAnimations().map((a) => a.getName()).join(", ")}`);
}
