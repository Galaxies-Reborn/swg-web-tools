'use client';

/**
 * three.js viewer for a converted game asset.
 *
 * The models come out of the TRE pipeline in metres with their own origin,
 * which is rarely the centre — SWG anchors most props at ground level. The
 * camera is therefore framed from the bounding box rather than a fixed
 * distance, otherwise a speeder and a teacup need different presets.
 */

import { Suspense, useEffect, useMemo, useRef, useState } from 'react';

import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Bounds, Environment, Grid, OrbitControls, useAnimations, useGLTF } from '@react-three/drei';
import * as THREE from 'three';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';

export interface ModelViewerProps {
  /** URL of the .glb, relative to the asset base. */
  src: string;
  /**
   * Clip names from the manifest, used to render the picker before the model
   * has downloaded. Playback itself reads the clips out of the loaded file.
   */
  animations?: readonly string[];
  autoRotate?: boolean;
  showGrid?: boolean;
  className?: string;
}

export function ModelViewer({
  src,
  animations = [],
  autoRotate = true,
  showGrid = true,
  className,
}: ModelViewerProps) {
  const [error, setError] = useState<string | null>(null);
  // Null is "bind pose", which is a real choice and the right default: it is
  // how the asset was authored, and several clips only make sense in motion.
  const [clip, setClip] = useState<string | null>(null);
  // The model's own bounds, reported once the GLB resolves, so the shadow
  // frustum can be sized and centred on it.
  const [bounds, setBounds] = useState<THREE.Box3 | null>(null);

  // A different asset's clips are not this one's — and neither is its error,
  // nor its bounds.
  // Without clearing it, one model that failed to load left the panel showing
  // that failure for every model selected afterwards.
  useEffect(() => {
    setClip(null);
    setError(null);
    setBounds(null);
  }, [src]);

  // The wrapper is a fixed height and the canvas fills it, so the picker had
  // nowhere to go and overflowed. Give the canvas the remaining space instead
  // of the whole box.
  return (
    <div className={`flex flex-col ${className ?? 'h-[520px] w-full'}`}>
      {error ? (
        <div className="panel flex h-full items-center justify-center p-6 text-center text-sm text-[var(--color-warn)]">
          {error}
        </div>
      ) : (
        <>
          <Canvas
            className="min-h-0 flex-1 rounded-lg"
            shadows
            dpr={[1, 2]}
            camera={{ fov: 40, position: [3, 2, 4] }}
            gl={{ antialias: true, toneMapping: THREE.ACESFilmicToneMapping }}
            onCreated={({ gl }) => {
              gl.setClearColor('#07090d');
            }}
          >
            <hemisphereLight intensity={0.45} groundColor="#0d1117" />
            <ShadowLight bounds={bounds} />
            <directionalLight position={[-4, 3, -6]} intensity={0.5} color="#4ea3ff" />

            <Suspense fallback={<LoadingCube />}>
              {/*
                `clip` is deliberately not in Bounds' dependency path: refitting
                the camera on every clip change would lurch the view each time
                the user tried one.
              */}
              <Bounds fit clip observe margin={1.25}>
                <Model src={src} clip={clip} onError={setError} onBounds={setBounds} />
              </Bounds>
              <Environment preset="city" />
            </Suspense>

            {showGrid ? (
              <Grid
                args={[40, 40]}
                cellColor="#1e2733"
                sectionColor="#2b3a4d"
                fadeDistance={30}
                infiniteGrid
                position={[0, -0.001, 0]}
              />
            ) : null}

            <OrbitControls
              makeDefault
              // Spinning the camera while a walk cycle plays makes both harder
              // to read, so motion in the model takes precedence.
              autoRotate={autoRotate && clip === null}
              autoRotateSpeed={0.6}
              enableDamping
              dampingFactor={0.08}
              // Stop the camera dropping below the grid, which reads as a bug.
              maxPolarAngle={Math.PI / 2 - 0.02}
            />
          </Canvas>

          {animations.length > 0 ? (
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <ClipButton label="Bind pose" active={clip === null} onClick={() => setClip(null)} />
              {animations.map((name) => (
                <ClipButton
                  key={name}
                  label={clipLabel(name)}
                  active={clip === name}
                  onClick={() => setClip(name)}
                />
              ))}
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

/**
 * `rancor_idl_stand_breathe` → `idl stand breathe`.
 *
 * The species prefix is the asset you are already looking at, so repeating it
 * on every button is noise.
 */
function clipLabel(name: string): string {
  const parts = name.split('_');
  return (parts.length > 1 ? parts.slice(1) : parts).join(' ');
}

function ClipButton({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded border px-2 py-1 text-[11px] transition-colors ${
        active
          ? 'border-[var(--color-accent)] text-[var(--color-accent)]'
          : 'border-[var(--color-edge)] text-[var(--color-ink-dim)] hover:text-[var(--color-ink)]'
      }`}
    >
      {label}
    </button>
  );
}

function Model({
  src,
  clip,
  onError,
  onBounds,
}: {
  src: string;
  clip: string | null;
  onError: (message: string) => void;
  onBounds?: (box: THREE.Box3) => void;
}) {
  const { scene, animations } = useGLTF(src);
  const { gl } = useThree();
  const group = useRef<THREE.Group>(null);

  const prepared = useMemo(() => {
    // `Object3D.clone()` copies a SkinnedMesh but leaves it pointing at the
    // original skeleton's bones, so an animated clone deforms the asset in the
    // cache instead of itself — and two viewers on a page fight over it.
    // SkeletonUtils.clone rebuilds the bone references against the copy.
    const copy = cloneSkinned(scene);
    copy.traverse((node) => {
      if (!(node instanceof THREE.Mesh)) return;
      node.castShadow = true;
      node.receiveShadow = true;
      // A skinned mesh's bounding volume is computed from the bind pose, so a
      // clip that reaches outside it makes three cull the model mid-animation.
      node.frustumCulled = false;

      // Clone before mutating. Object3D.clone and SkeletonUtils.clone both
      // share material instances with the original, and the original is drei's
      // cached gltf.scene — so writing to them changed how every other viewer
      // on the site drew that model, and whether a ship got anisotropic
      // filtering depended on whether someone had opened it in the asset
      // browser first. Textures can stay shared; only the material wrappers
      // are copied.
      const source = Array.isArray(node.material) ? node.material : [node.material];
      const materials = source.map((m) => (m ? m.clone() : m));
      node.material = Array.isArray(node.material) ? materials : materials[0];

      for (const material of materials) {
        if (!(material instanceof THREE.MeshStandardMaterial)) continue;
        // The converter writes sRGB textures; three defaults new textures to
        // linear, which washes every colour map out.
        if (material.map) material.map.colorSpace = THREE.SRGBColorSpace;
        if (material.map) material.map.anisotropy = gl.capabilities.getMaxAnisotropy();
        // Alpha-blended game materials frequently have no meaningful depth
        // order; writing depth on them produces holes.
        if (material.transparent) material.depthWrite = false;
      }
    });
    return copy;
  }, [scene, gl]);

  // Measured here, not from the canvas scene: this component only renders once
  // useGLTF has resolved, whereas anything watching the scene from outside the
  // Suspense boundary measures the loading cube and the grid instead.
  useEffect(() => {
    if (!group.current || !onBounds) return;
    onBounds(new THREE.Box3().setFromObject(group.current));
  }, [prepared, onBounds]);

  const { actions } = useAnimations(animations, group);

  useEffect(() => {
    if (!clip) {
      // Fade out rather than stop: cutting to bind pose mid-stride reads as a
      // glitch, and `reset().fadeOut()` leaves the mixer clean either way.
      for (const action of Object.values(actions)) action?.fadeOut(0.2);
      return;
    }
    const next = actions[clip];
    if (!next) return;
    next.reset().fadeIn(0.2).play();
    return () => {
      next.fadeOut(0.2);
    };
  }, [actions, clip]);

  // Deliberately no useGLTF.clear() on unmount. drei's cache is shared and not
  // reference counted, so clearing it here evicts the entry out from under any
  // other viewer showing the same model, and it does not dispose the GPU
  // resources anyway — it only drops the cache handle. Letting the cache keep
  // the entry is both correct for siblings and what makes reopening a model
  // instant.

  useEffect(() => {
    if (!prepared.children.length) onError('That model contains no geometry.');
  }, [prepared, onError]);

  return (
    <group ref={group}>
      <primitive object={prepared} />
    </group>
  );
}

function LoadingCube() {
  const ref = useRef<THREE.Mesh>(null);
  useFrame((_, delta) => {
    if (ref.current) {
      ref.current.rotation.x += delta * 0.6;
      ref.current.rotation.y += delta * 0.9;
    }
  });
  return (
    <mesh ref={ref}>
      <boxGeometry args={[0.5, 0.5, 0.5]} />
      <meshStandardMaterial color="#1f5f9e" wireframe />
    </mesh>
  );
}

/**
 * The key light, with a shadow frustum sized and centred on the model.
 *
 * three's default shadow camera covers a 10 m box at the origin. The corpus
 * runs from a coffee cup to a star destroyer, and Bounds moves the CAMERA
 * rather than scaling the model, so anything larger fell outside the map and
 * picked up a hard square edge or lost its shadow.
 *
 * The bounds come from the model itself once it has loaded. Measuring the
 * canvas scene instead would measure the grid and the loading cube, because
 * the model is behind a Suspense boundary for the whole of its fetch.
 */
function ShadowLight({ bounds }: { bounds: THREE.Box3 | null }) {
  const light = useRef<THREE.DirectionalLight>(null);
  const { scene } = useThree();

  useEffect(() => {
    const target = light.current;
    if (!target || !bounds || bounds.isEmpty()) return;

    // A directional light aims at its target object, whose default is never
    // added to the scene and so never leaves the origin. Without this the
    // frustum is centred on (0,0,0) however far away the model sits.
    scene.add(target.target);

    const centre = bounds.getCenter(new THREE.Vector3());
    const radius = bounds.getBoundingSphere(new THREE.Sphere()).radius || 1;

    const camera = target.shadow.camera;
    camera.left = -radius;
    camera.right = radius;
    camera.top = radius;
    camera.bottom = -radius;
    camera.near = 0.1;
    camera.far = radius * 6;
    camera.updateProjectionMatrix();

    target.target.position.copy(centre);
    target.target.updateMatrixWorld();
    target.position.copy(centre).add(new THREE.Vector3(radius * 0.8, radius * 1.3, radius * 0.8));

    return () => {
      scene.remove(target.target);
    };
  }, [bounds, scene]);

  return (
    <directionalLight
      ref={light}
      position={[5, 8, 5]}
      intensity={1.6}
      castShadow
      shadow-mapSize={[1024, 1024]}
    />
  );
}
