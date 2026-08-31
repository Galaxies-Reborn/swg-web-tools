'use client';

/**
 * The ship loadout view.
 *
 * SWG assembles a ship from per-slot part appearances hung on named hardpoints
 * rather than from one mesh, which is why changing a booster changes what you
 * see. The converted GLBs carry those hardpoints as empty nodes, so a
 * component's model can be parented to the point the game would hang it from
 * and inherit the right position and orientation for free.
 *
 * Nothing is guessed. Which model hangs where comes from the game's own
 * per-chassis attachment table, and each part is placed at the hardpoint that
 * table names -- which on a wing model is the origin and on a fuselage is a
 * real offset.
 */

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { Canvas, useThree } from '@react-three/fiber';
import { Bounds, OrbitControls, useGLTF, useTexture } from '@react-three/drei';
import * as THREE from 'three';

import type { PaintPattern } from '@precu/shared';
import { patternForModel } from '@precu/shared';

import { findHardpoint, ownerOfHardpoint, transformWithinModel } from '../lib/hardpoints';

const ASSET_BASE = process.env.NEXT_PUBLIC_ASSET_BASE ?? '/assets';

export interface AttachedPart {
  slot: string;
  /** Manifest key of the attachment model, from the chassis's own table. */
  model: string;
  /** The hardpoint the game names for it. Kept for reporting, not for placing. */
  hardpoint: string;
  label: string;
}

/**
 * A hull's chosen paint: which pattern, and the two colours painted through it.
 *
 * The masks are what make this faithful. The game multiplies the base colour by
 * `mix(1, colour, mask)` for each channel, so a colour only lands where the
 * artist marked it — about 8% of an X-wing. Tinting the whole hull instead would
 * paint the fuselage in a colour the game only ever puts on the markings.
 */
/**
 * A model that is part of the hull rather than of any component — a wing.
 *
 * `mount` is the hull hardpoint it bolts to: `wing1` on an X-wing, `struct1` on
 * a Hutt. Drawing these at the origin instead put the Hutt turret's wings
 * halfway up its nose.
 */
export interface StructuralPart {
  model: string;
  mount: string | null;
  /** The model that carries the mount — the hull, or another structural part. */
  on?: string | null;
}

export interface ShipPaintSelection {
  /** The chosen pattern, shared by every model the hull draws. */
  pattern: number;
  primaryColour: string;
  secondaryColour: string;
  /** Per model key: which material to paint, and that model's own masks. */
  models: Record<string, { material: string | null; patterns: PaintPattern[] }>;
}

export interface ShipCanvasProps {
  /**
   * Models that are part of the hull but not part of the hull mesh.
   *
   * An X-wing's wings are a separate model, and the chassis table never names
   * them — it just references hardpoints that only exist on them. Drawn
   * whatever is installed, because they are the ship, not a component.
   */
  structural?: StructuralPart[];
  /** The hull's paint, or null when the chassis has no paint channels. */
  paint?: ShipPaintSelection | null;
  /**
   * S-foils out.
   *
   * The client rotates the wing models rather than playing a clip — the models
   * carry no animation — so this rolls them apart about the ship's forward
   * axis. Which hulls have wings comes from the data; the ANGLE does not, and
   * is chosen to read clearly rather than measured from anything.
   */
  wingsOpen?: boolean;
  /** Manifest key of the chassis hull. */
  hull: string | null;
  parts: AttachedPart[];
  showHardpoints: boolean;
  /** Reports which parts could not be placed, so the UI can be honest. */
  onUnplaced?: (slots: string[]) => void;
  className?: string;
}

export function ShipCanvas({
  hull,
  parts,
  structural,
  paint,
  wingsOpen,
  showHardpoints,
  onUnplaced,
  className,
}: ShipCanvasProps) {
  if (!hull) {
    return (
      <div
        className={`panel flex items-center justify-center text-sm text-[var(--color-ink-dim)] ${
          className ?? 'h-[520px] w-full'
        }`}
      >
        This chassis has no converted model.
      </div>
    );
  }

  return (
    <div className={className ?? 'h-[520px] w-full'}>
      <Canvas
        className="rounded-lg"
        dpr={[1, 2]}
        camera={{ fov: 40, position: [12, 6, 16] }}
        gl={{ antialias: true, toneMapping: THREE.ACESFilmicToneMapping }}
        onCreated={({ gl }) => gl.setClearColor('#05070a')}
      >
        <hemisphereLight intensity={0.5} groundColor="#0d1117" />
        <directionalLight position={[8, 12, 6]} intensity={1.5} />
        <directionalLight position={[-8, 4, -10]} intensity={0.5} color="#4ea3ff" />

        {/*
          No <Environment>. drei's presets are fetched from a third-party CDN,
          and sharing a Suspense boundary with the ship meant a slow, blocked or
          unreachable fetch left the whole viewer empty rather than merely
          unlit. It also bought nothing here: an environment map only shows on
          metallic materials, and every converted ship material is metalness 0.
          The three lights above are what actually lights the hull.
        */}
        <Suspense fallback={null}>
          <Bounds fit clip observe margin={1.3}>
            <Ship
              hull={hull}
              parts={parts}
              structural={structural}
              paint={paint}
              wingsOpen={wingsOpen}
              showHardpoints={showHardpoints}
              onUnplaced={onUnplaced}
            />
          </Bounds>
        </Suspense>

        <OrbitControls makeDefault enableDamping dampingFactor={0.08} autoRotate autoRotateSpeed={0.5} />
      </Canvas>
    </div>
  );
}

function Ship({
  hull,
  parts,
  structural,
  paint,
  wingsOpen,
  showHardpoints,
  onUnplaced,
}: {
  hull: string;
  parts: AttachedPart[];
  structural?: StructuralPart[];
  paint?: ShipPaintSelection | null;
  wingsOpen?: boolean;
  showHardpoints: boolean;
  onUnplaced?: (slots: string[]) => void;
}) {
  const copy = usePreparedModel(`${ASSET_BASE}/models/${hull}.glb`);
  usePaint(copy, hull, paint ?? null);

  /**
   * Every hardpoint the assembled ship exposes, by model and lowercased name.
   *
   * Not just the hull's. An assembly can be more than one deep — a B-wing's
   * chassis model is only its cockpit pod, and `engine1` and `booster1` live on
   * the body that hangs off it — so structural models register theirs as they
   * mount, and components resolve against the whole ship.
   */
  const registry = useRef(new Map<string, Map<string, THREE.Object3D>>());
  const [mountedCount, setMountedCount] = useState(0);

  const hullPoints = useMemo(() => {
    const found = new Map<string, THREE.Object3D>();
    copy.traverse((node) => {
      // The converter marks hardpoints with extras.hardpoint, which three's
      // GLTFLoader surfaces as userData. Only marked nodes count: a hull's
      // ordinary mesh nodes are named too, and treating a name as a hardpoint
      // would bolt engines onto whatever happened to be called "engine1".
      if (node.userData?.hardpoint) found.set(node.name.toLowerCase(), node);
    });
    return found;
  }, [copy]);

  useEffect(() => {
    registry.current.set(hull, hullPoints);
    setMountedCount((n) => n + 1);
  }, [hull, hullPoints]);

  const register = useCallback((model: string, points: Map<string, THREE.Object3D>) => {
    registry.current.set(model, points);
    setMountedCount((n) => n + 1);
  }, []);

  /**
   * The models THIS ship is made of.
   *
   * The registry is a ref, so it keeps every model mounted since the page
   * loaded -- including the wings of a chassis looked at earlier. Hardpoint
   * names are not unique between ships: `engine1`, `booster1` and `weapon1`
   * appear on most of them. So a lookup that searched the whole registry could
   * answer with another ship's wing, and did.
   *
   * Scoping every lookup to the current ship is what makes the answer belong
   * to the ship being drawn. Clearing the registry instead would race: a
   * child's registration effect runs before its parent's, so the hull would
   * wipe the structural models that had just registered.
   */
  const shipModels = useMemo(() => {
    const set = new Set<string>([hull]);
    for (const part of structural ?? []) set.add(part.model);
    return set;
  }, [hull, structural]);

  /** Look a hardpoint up anywhere on the ship, preferring a named owner. */
  const findPoint = useCallback(
    (name: string, owner?: string | null) =>
      findHardpoint(registry.current, shipModels, name, owner),
    // `registry` is a ref, so nothing about reading it can invalidate this.
    // mountedCount is the signal that its CONTENTS changed, which is exactly
    // what should re-resolve a hardpoint lookup. The rule cannot see that,
    // because the value is not read in the body.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [mountedCount, shipModels],
  );

  /**
   * Which structural model carries a hardpoint, or null when the hull does.
   *
   * This decides where a part is DRAWN, not just where it sits. A cannon whose
   * hardpoint lives on a wing has to be a child of that wing, or the wing rolls
   * away from underneath it when the S-foils open.
   */
  const ownerOf = useCallback(
    (hardpoint: string): string | null =>
      ownerOfHardpoint(registry.current, shipModels, hull, hardpoint),
    // Same as findPoint above: mountedCount stands in for "the ref's contents
    // changed". The disable has to be the LAST line before the array -- with a
    // trailing comment line it suppresses that comment instead of the code,
    // which is how this one was reported as unused while still erroring.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [hull, mountedCount, shipModels],
  );

  const hardpoints = hullPoints;

  // Every part with a model is drawn, so nothing is reported here. The named
  // hardpoint may well live on a wing rather than the hull -- the X-wing's
  // engine_pos1 does -- and that is not a failure to draw anything.
  const unplaced = useMemo<string[]>(() => [], []);

  /**
   * Marker size scaled to the hull.
   *
   * A fixed 0.12 m sphere is invisible on a corvette and swamps a TIE. Derived
   * from the hull's own span so it reads the same on every chassis.
   */
  const markerRadius = useMemo(() => {
    const box = new THREE.Box3().setFromObject(copy);
    const span = box.getSize(new THREE.Vector3());
    const largest = Math.max(span.x, span.y, span.z);
    return THREE.MathUtils.clamp(largest * 0.006, 0.05, 1.5);
  }, [copy]);

  useEffect(() => {
    onUnplaced?.(unplaced);
  }, [unplaced, onUnplaced]);

  return (
    <group>
      <primitive object={copy} />

      {(structural ?? []).map((part) => (
        <AttachedModel
          key={`structural:${part.model}`}
          model={part.model}
          paint={paint}
          at={part.mount ? findPoint(part.mount, part.on) : null}
          onHardpoints={register}
          roll={wingRoll(part.model, wingsOpen)}
        >
          {(space) =>
            parts
              .filter((component) => ownerOf(component.hardpoint) === part.model)
              .map((component) => (
                <AttachedModel
                  key={`${component.slot}:${component.model}`}
                  model={component.model}
                  paint={paint}
                  at={findPoint(component.hardpoint, part.model)}
                  within={space}
                />
              ))
          }
        </AttachedModel>
      ))}

      {parts
        .filter((part) => ownerOf(part.hardpoint) === null)
        .map((part) => (
          <AttachedModel
            key={`${part.slot}:${part.model}`}
            model={part.model}
            paint={paint}
            at={findPoint(part.hardpoint)}
          />
        ))}

      {showHardpoints
        ? [...hardpoints.entries()].map(([name, node]) => (
            <HardpointMarker key={name} node={node} radius={markerRadius} />
          ))
        : null}
    </group>
  );
}

/**
 * One attachment model, drawn in the hull's own space.
 *
 * See the note on the resolver above: these models carry their position, so
 * they are rendered as siblings of the hull rather than children of a
 * hardpoint.
 */
/**
 * One attached model, placed at the hardpoint the table names.
 *
 * The hardpoint's own transform decides everything, and it says one of two
 * things. On the wing models every attachment hardpoint sits at (0,0,0) --
 * booster_pos1, engine_pos1, weapon1_pos1 all of them -- which means those
 * parts are authored in hull space and belong at the origin. On a fuselage they
 * carry a real offset: the Hutt turret's engine1 is at (0, 1.33, 6.55), and a
 * part left at the origin there sits inside the ship rather than on the back of
 * it.
 *
 * Honouring the transform covers both, because honouring a zero transform is
 * the same as ignoring it.
 */
function AttachedModel({
  model,
  paint,
  at,
  onHardpoints,
  roll = 0,
  within = null,
  children,
}: {
  model: string;
  paint?: ShipPaintSelection | null;
  at?: THREE.Object3D | null;
  onHardpoints?: (model: string, points: Map<string, THREE.Object3D>) => void;
  /** Radians about the ship's forward axis, for opening S-foils. */
  roll?: number;
  /**
   * The model this one is mounted on, when it is not the hull.
   *
   * Set for a part hanging off a structural model -- a cannon on a wing. The
   * mount is then read in that model's frame instead of the world's, because
   * the part is drawn inside it and inherits its transform.
   */
  within?: THREE.Object3D | null;
  /** Parts mounted on THIS model, drawn inside it so they move with it. */
  children?: (space: THREE.Object3D) => React.ReactNode;
}) {
  const copy = usePreparedModel(`${ASSET_BASE}/models/${model}.glb`);

  // A structural model carries hardpoints of its own, and components mount on
  // them: a B-wing's engine hangs off the body, not off the cockpit pod.
  useEffect(() => {
    if (!onHardpoints) return;
    const found = new Map<string, THREE.Object3D>();
    copy.traverse((node) => {
      if (node.userData?.hardpoint) found.set(node.name.toLowerCase(), node);
    });
    if (found.size) onHardpoints(model, found);
  }, [copy, model, onHardpoints]);
  // Structural models are painted too: a hull's wings carry the same markings
  // as its fuselage, from their own textures.
  usePaint(copy, model, paint ?? null);

  /**
   * Where to put this model, or null to leave it at the hull's origin.
   *
   * Parts come in two kinds and the geometry says which. One is modelled about
   * its own origin and has to be carried to its mount:
   * `hutt_fighter_heavy_struct_s01` is centred on z=0 and its `struct1` sits at
   * z=6.55. The other is already positioned in hull space, and moving it again
   * double-counts: `xwing_wing_pos` is centred on z=2.17 and its `wing1` is at
   * z=2.00, so honouring the mount pushed the S-foils out past the tail.
   *
   * A part centred on its own origin is the first kind. Only two mounts in the
   * whole corpus are anywhere but the origin — those two — so everywhere else
   * this decides nothing and the part lands in the same place either way.
   */
  const placement = useMemo(() => {
    if (!at) return null;

    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    if (within) {
      // Mounted on another model: read the mount in that model's frame. Using
      // the world transform here would bake in the wing's roll and then apply
      // it a second time when this part is drawn inside the rolled group.
      transformWithinModel(at, within).decompose(position, quaternion, new THREE.Vector3());
    } else {
      at.getWorldPosition(position);
      at.getWorldQuaternion(quaternion);
    }

    const box = new THREE.Box3().setFromObject(copy);
    if (box.isEmpty()) return { position, quaternion };

    const centre = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const extent = Math.max(size.x, size.y, size.z) || 1;

    // Is the part already sitting at its mount? That is the question, and it is
    // answered by comparing the two directly rather than by asking whether the
    // geometry looks centred. An earlier attempt measured the centre against
    // the part's LARGEST dimension, which for a wing is its span: the X-wing's
    // centre sits 2.17 from the origin against a 13 m span, read as "close
    // enough to the origin", and the wing was moved a second time.
    if (centre.distanceTo(position) < extent * 0.1) return null;

    return { position, quaternion };
  }, [at, copy, within]);

  // The roll is applied inside the mount, so a wing pivots about the point it
  // bolts to rather than about the world origin -- and anything mounted on this
  // model is drawn in the same group, so opening the S-foils carries the
  // cannons out with the wing instead of leaving them hanging where the wing
  // used to be.
  const inner = (
    <group rotation={[0, 0, roll]}>
      <primitive object={copy} />
      {children?.(copy)}
    </group>
  );

  if (!placement) return inner;
  return (
    <group position={placement.position} quaternion={placement.quaternion}>
      {inner}
    </group>
  );
}

/**
 * How far one wing rolls when the S-foils open.
 *
 * The halves go opposite ways, which is what makes an X-wing an X: `pos` and
 * `neg` are the upper and lower pairs, `_l` and `_r` the left and right. A
 * model whose name says neither is left alone rather than rolled arbitrarily.
 */
const WING_OPEN_RADIANS = 0.28;

function wingRoll(model: string, open?: boolean): number {
  if (!open) return 0;
  if (/_pos$|_pos_|_l$|_l_/.test(model)) return WING_OPEN_RADIANS;
  if (/_neg$|_neg_|_r$|_r_/.test(model)) return -WING_OPEN_RADIANS;
  return 0;
}

/** A small marker so the hardpoints can be seen while building a loadout. */
function HardpointMarker({ node, radius }: { node: THREE.Object3D; radius: number }) {
  const position = useMemo(() => {
    const world = new THREE.Vector3();
    node.getWorldPosition(world);
    return world;
  }, [node]);

  return (
    <mesh position={position}>
      <sphereGeometry args={[radius, 8, 8]} />
      <meshBasicMaterial color="#4ea3ff" />
    </mesh>
  );
}

/**
 * Clone a cached scene and make its materials safe to look at.
 *
 * The camera here rotates continuously, which is exactly the case where a hull
 * texture without anisotropic filtering shimmers at grazing angles. Materials
 * are cloned before anything is written to them: a clone shares material
 * instances with drei's cache, so mutating them in place would change how the
 * same model draws everywhere else on the site.
 */
function prepare(
  scene: THREE.Object3D,
  gl: THREE.WebGLRenderer,
): { copy: THREE.Object3D; owned: THREE.Material[] } {
  const copy = scene.clone(true);
  // Every material this call creates, so the caller can give them back.
  const owned: THREE.Material[] = [];
  const maxAnisotropy = gl.capabilities.getMaxAnisotropy();

  copy.traverse((node) => {
    if (!(node instanceof THREE.Mesh)) return;

    const source = Array.isArray(node.material) ? node.material : [node.material];
    const materials = source.map((m) => (m ? m.clone() : m));
    node.material = Array.isArray(node.material) ? materials : materials[0];

    for (const material of materials) {
      if (!material) continue;
      owned.push(material);
      if (!(material instanceof THREE.MeshStandardMaterial)) continue;
      if (material.map) material.map.anisotropy = maxAnisotropy;
      // An alpha-blended game material rarely has a meaningful depth order, and
      // writing depth on one punches holes in what is behind it.
      if (material.transparent) material.depthWrite = false;
    }
  });

  return { copy, owned };
}

/**
 * Clone a model for display and hand the clone's materials back when it goes.
 *
 * Only the materials this hook created are disposed. Geometries and textures
 * belong to drei's cache and are shared with every other view of the same
 * model, so disposing those here would blank the asset browser.
 */
function usePreparedModel(url: string): THREE.Object3D {
  const { scene } = useGLTF(url);
  const { gl } = useThree();
  const { copy, owned } = useMemo(() => prepare(scene, gl), [scene, gl]);

  useEffect(() => {
    return () => {
      for (const material of owned) material.dispose();
    };
  }, [owned]);

  return copy;
}

/**
 * Paint the hull, using the client's own formula.
 *
 *     rgb = diffuse * mix(1, colour1, MAIN.a) * mix(1, colour2, HUEB.a)
 *
 * Two things this does NOT do, both learned the hard way.
 *
 * It does not touch `material.map`. A pattern's base colour is the same for
 * every pattern — the whole difference between them lives in the alpha, which
 * is exported separately as a mask. Swapping the map achieved nothing except
 * to put the fuselage's texture on whatever else had one.
 *
 * And it paints only the material whose shader declared the pattern. A hull has
 * several; painting them all put the fuselage's markings on the canopy.
 *
 * The uniforms are created once per material and then mutated, because
 * `onBeforeCompile` runs only when a program is compiled. Rebuilding them on
 * every change left three serving the cached program with the first colours it
 * ever saw — which is why changing a colour appeared to do nothing.
 */
function usePaint(
  root: THREE.Object3D,
  modelKey: string,
  paint: ShipPaintSelection | null,
) {
  const forModel = paint?.models[modelKey] ?? null;
  // Clamped, not indexed straight in: the hull-wide index spans the LARGEST
  // pattern list on the ship, and a model with a shorter one would fall off
  // the end and render with no mask -- the raw magenta the paint covers.
  const chosen = forModel ? patternForModel(forModel, paint?.pattern ?? 0) : null;
  const urls = useMemo(() => {
    const names = [chosen?.primaryMask, chosen?.secondaryMask].filter(
      (n): n is string => Boolean(n),
    );
    return names.map((n) => `${ASSET_BASE}/patterns/${n}`);
  }, [chosen]);

  // useTexture cannot be called conditionally, so an unpainted hull asks for a
  // 1x1 transparent pixel instead of nothing.
  const loaded = useTexture(urls.length ? urls : [BLANK_TEXTURE]);
  const masks = useMemo(() => (Array.isArray(loaded) ? loaded : [loaded]), [loaded]);

  /** Uniform objects per material, kept so their values can be mutated. */
  const uniforms = useRef(new Map<string, PaintUniforms>());

  useEffect(() => {
    if (!paint || !forModel || !chosen) return;

    let cursor = 0;
    const primaryMask = chosen.primaryMask ? (masks[cursor++] ?? null) : null;
    const secondaryMask = chosen.secondaryMask ? (masks[cursor++] ?? null) : null;
    for (const mask of [primaryMask, secondaryMask]) {
      if (!mask) continue;
      mask.colorSpace = THREE.NoColorSpace;
      mask.flipY = false;
      mask.needsUpdate = true;
    }

    root.traverse((node) => {
      if (!(node instanceof THREE.Mesh)) return;
      const materials = Array.isArray(node.material) ? node.material : [node.material];

      for (const material of materials) {
        if (!(material instanceof THREE.MeshStandardMaterial)) continue;
        if (forModel.material && material.name !== forModel.material) continue;
        if (!material.map) continue;

        let slot = uniforms.current.get(material.uuid);
        if (!slot) {
          slot = {
            uPrimary: { value: new THREE.Color(1, 1, 1) },
            uSecondary: { value: new THREE.Color(1, 1, 1) },
            uPrimaryMask: { value: null as THREE.Texture | null },
            uSecondaryMask: { value: null as THREE.Texture | null },
            uHasPrimary: { value: 0 },
            uHasSecondary: { value: 0 },
          };
          uniforms.current.set(material.uuid, slot);

          material.onBeforeCompile = (shader) => {
            Object.assign(shader.uniforms, slot);
            shader.fragmentShader = shader.fragmentShader
              .replace(
                '#include <common>',
                [
                  '#include <common>',
                  'uniform vec3 uPrimary;',
                  'uniform vec3 uSecondary;',
                  'uniform sampler2D uPrimaryMask;',
                  'uniform sampler2D uSecondaryMask;',
                  'uniform float uHasPrimary;',
                  'uniform float uHasSecondary;',
                ].join('\n'),
              )
              .replace(
                '#include <map_fragment>',
                [
                  '#include <map_fragment>',
                  'if (uHasPrimary > 0.5) {',
                  '  float pm = texture2D(uPrimaryMask, vMapUv).r;',
                  '  diffuseColor.rgb *= mix(vec3(1.0), uPrimary, pm);',
                  '}',
                  'if (uHasSecondary > 0.5) {',
                  '  float sm = texture2D(uSecondaryMask, vMapUv).r;',
                  '  diffuseColor.rgb *= mix(vec3(1.0), uSecondary, sm);',
                  '}',
                ].join('\n'),
              );
          };
          /**
           * One program per material, not one for all of them.
           *
           * A constant key was the whole bug. Materials that share a cache key
           * share a compiled program, and three runs `onBeforeCompile` once per
           * PROGRAM -- so only the first painted material ever had its uniforms
           * assigned. Every other one sampled whatever texture happened to be
           * bound to that unit, which is the diffuse map, giving a mask value
           * around mid-grey across the entire surface. The result was a hull
           * tinted everywhere instead of on its markings, and multiplied twice,
           * which is why every painted ship came out nearly black while the
           * V-wing -- which has no paint at all -- rendered correctly.
           *
           * Keying on the uuid costs one compile per painted material, of which
           * a ship has a handful.
           */
          material.customProgramCacheKey = () => `swg-paint|${material.uuid}`;
          material.needsUpdate = true;
        }

        // Mutating the existing uniforms is what makes a change show without a
        // recompile.
        slot.uPrimary.value.set(paint.primaryColour);
        slot.uSecondary.value.set(paint.secondaryColour);
        slot.uPrimaryMask.value = primaryMask;
        slot.uSecondaryMask.value = secondaryMask;
        slot.uHasPrimary.value = primaryMask ? 1 : 0;
        slot.uHasSecondary.value = secondaryMask ? 1 : 0;
      }
    });
  }, [root, paint, forModel, chosen, masks]);
}

interface PaintUniforms {
  uPrimary: { value: THREE.Color };
  uSecondary: { value: THREE.Color };
  uPrimaryMask: { value: THREE.Texture | null };
  uSecondaryMask: { value: THREE.Texture | null };
  uHasPrimary: { value: number };
  uHasSecondary: { value: number };
}

/** A 1x1 transparent PNG, so useTexture always has something to load. */
const BLANK_TEXTURE =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
