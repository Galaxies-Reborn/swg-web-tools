'use client';

/**
 * The city planner's 3D view.
 *
 * Top-down by default because that is how a city is planned and how the game's
 * own city map reads, but orbitable — the real buildings are the point, and a
 * flat plan makes a shuttleport and a garden look alike.
 *
 * Everything is drawn to scale in metres: the buildable circle from the rank's
 * radius, the structures from their footprint cell grid. A planner whose sizes
 * are decorative would look authoritative while misleading someone about what
 * fits, which is worse than no planner.
 */

import { Suspense, useEffect, useMemo, useRef, useState } from 'react';

import { Canvas } from '@react-three/fiber';
import { Grid, OrbitControls, useGLTF } from '@react-three/drei';
import * as THREE from 'three';
import type { CityStructure } from '@precu/shared';

import { FLAG_WATER, type TerrainTile } from '@/lib/terrain';

const ASSET_BASE = process.env.NEXT_PUBLIC_ASSET_BASE ?? '/assets';

export interface PlacedStructure {
  id: string;
  structure: CityStructure;
  x: number;
  z: number;
  rotation: number;
  /** Set when the placement breaks a rule, so the view can call it out. */
  invalid?: boolean;
  /**
   * Where the structure stands, from the same placement test that decided
   * whether it may stand there at all. Computed once alongside the validation
   * rather than again per frame, so the drawn height and the judged height
   * cannot drift apart.
   */
  groundY?: number;
}

export interface CityCanvasProps {
  radius: number;
  placements: PlacedStructure[];
  selectedId: string | null;
  /** Ground click in world metres, for placing the pending structure. */
  onGroundClick: (x: number, z: number) => void;
  onSelect: (id: string | null) => void;
  /**
   * A drag has begun on a placed structure.
   *
   * Reported separately from the moves so the page can record one undo step
   * for the whole drag rather than one per frame.
   */
  onDragStart?: (id: string) => void;
  /** The dragged structure's new position, in world metres. */
  onDragMove?: (id: string, x: number, z: number) => void;
  onDragEnd?: () => void;
  /**
   * Baked ground for this site, when the plan has been anchored to a real
   * place and a tile exists for it. Without one the planner keeps its flat
   * plane, which is still a usable way to lay out lots.
   */
  terrain?: TerrainTile | null;
  className?: string;
}

export function CityCanvas({
  radius,
  placements,
  selectedId,
  onGroundClick,
  onSelect,
  onDragStart,
  onDragMove,
  onDragEnd,
  terrain = null,
  className,
}: CityCanvasProps) {
  const [draggingId, setDraggingId] = useState<string | null>(null);

  // The drag ends wherever the button comes up, including outside the canvas.
  // Without a window listener a pointer released over the palette leaves the
  // structure glued to the cursor.
  useEffect(() => {
    if (!draggingId) return;
    const stop = () => {
      setDraggingId(null);
      onDragEnd?.();
    };
    window.addEventListener('pointerup', stop);
    return () => window.removeEventListener('pointerup', stop);
  }, [draggingId, onDragEnd]);
  return (
    <div className={className ?? 'h-[620px] w-full'}>
      <Canvas
        className="rounded-lg"
        dpr={[1, 2]}
        // Framed for the largest city so switching rank never leaves the plan
        // off-screen; the user can zoom in for a small one.
        camera={{ fov: 45, position: [0, 520, 420], far: 8000 }}
        gl={{ antialias: true, toneMapping: THREE.ACESFilmicToneMapping }}
        onCreated={({ gl }) => gl.setClearColor('#07090d')}
      >
        <hemisphereLight intensity={0.7} groundColor="#0d1117" />
        <directionalLight position={[300, 500, 200]} intensity={1.4} />
        <directionalLight position={[-200, 300, -300]} intensity={0.4} color="#4ea3ff" />

        {terrain ? (
          <TerrainRelief
            tile={terrain}
            onGroundClick={onGroundClick}
            onSelect={onSelect}
            draggingId={draggingId}
            onDragMove={onDragMove}
          />
        ) : (
          <Ground
            radius={radius}
            onGroundClick={onGroundClick}
            onSelect={onSelect}
            draggingId={draggingId}
            onDragMove={onDragMove}
          />
        )}
        <BuildableArea radius={radius} terrain={terrain} />

        {/* Over real terrain the flat grid would hang in the air across a
            valley, so it is dropped when there is ground to read instead. */}
        {terrain ? null : (
        <Grid
          args={[radius * 4, radius * 4]}
          // One cell per lot: the grid is the unit the game actually places on,
          // so it doubles as a ruler rather than being decoration.
          cellSize={8}
          sectionSize={80}
          cellColor="#1a222c"
          sectionColor="#2b3a4d"
          fadeDistance={radius * 3}
          position={[0, -0.05, 0]}
        />
        )}

        {placements.map((placement) => (
          <Placement
            key={placement.id}
            placement={placement}
            selected={placement.id === selectedId}
            onSelect={onSelect}
            onDragStart={(id) => {
              setDraggingId(id);
              onDragStart?.(id);
            }}
          />
        ))}

        <OrbitControls
          makeDefault
          // Dragging a building must not also swing the camera.
          enabled={draggingId === null}
          enableDamping
          dampingFactor={0.08}
          maxPolarAngle={Math.PI / 2 - 0.05}
          maxDistance={radius * 6}
        />
      </Canvas>
    </div>
  );
}

/**
 * The invisible plane every placement click lands on.
 *
 * Sized well beyond the city so a click near the edge still registers and can
 * be reported as out of bounds, rather than silently doing nothing — which
 * reads as a broken tool.
 */
/**
 * The real ground, built from a baked terrain tile.
 *
 * One vertex per baked sample, so the mesh is exactly the surface the bake
 * recorded -- no resampling, no smoothing that would move a hillside away from
 * where the game puts it. Vertex colours carry the two things a planner needs
 * to see at a glance: water, and how steep the ground is, because a slope that
 * looks gentle in plan view is what makes a lot unbuildable.
 *
 * It replaces the flat plane rather than sitting on top of it, and it is the
 * click target too, so a structure dropped on a hillside lands where the
 * pointer actually met the ground.
 */
function TerrainRelief({
  tile,
  onGroundClick,
  onSelect,
  draggingId,
  onDragMove,
}: {
  tile: TerrainTile;
  onGroundClick: (x: number, z: number) => void;
  onSelect: (id: string | null) => void;
  draggingId: string | null;
  onDragMove?: (id: string, x: number, z: number) => void;
}) {
  const dragged = useRef(false);

  const geometry = useMemo(() => {
    const { samples, spacing, heights, flags } = tile.grid;
    const { originX, originZ } = tile.meta;
    const positions = new Float32Array(samples * samples * 3);
    const colours = new Float32Array(samples * samples * 3);

    const heightAt = (col: number, row: number) =>
      heights[row * samples + col] / 10;

    for (let row = 0; row < samples; row += 1) {
      for (let col = 0; col < samples; col += 1) {
        const i = row * samples + col;
        // Drawn at the tile's own origin rather than by assuming it is centred
        // on the plan. The cut is snapped to the planet's sample grid, so the
        // window can sit up to a sample off the site, and assuming otherwise
        // slides the ground out from under everything standing on it.
        positions[i * 3] = originX + col * spacing;
        positions[i * 3 + 1] = heightAt(col, row);
        positions[i * 3 + 2] = originZ + row * spacing;

        // Steepness from the neighbouring samples, which is what the eye reads
        // as relief once the whole thing is one flat colour.
        const east = heightAt(Math.min(col + 1, samples - 1), row);
        const west = heightAt(Math.max(col - 1, 0), row);
        const south = heightAt(col, Math.min(row + 1, samples - 1));
        const north = heightAt(col, Math.max(row - 1, 0));
        const grade = Math.hypot(east - west, south - north) / (2 * spacing);
        const lit = Math.min(grade * 2.2, 1);

        if (flags[i] & FLAG_WATER) {
          colours[i * 3] = 0.06;
          colours[i * 3 + 1] = 0.22;
          colours[i * 3 + 2] = 0.38;
        } else {
          // Flat ground stays close to the old backdrop colour so the change
          // reads as terrain arriving, not as a new theme.
          colours[i * 3] = 0.05 + lit * 0.30;
          colours[i * 3 + 1] = 0.07 + lit * 0.26;
          colours[i * 3 + 2] = 0.09 + lit * 0.20;
        }
      }
    }

    const indices: number[] = [];
    for (let row = 0; row < samples - 1; row += 1) {
      for (let col = 0; col < samples - 1; col += 1) {
        const a = row * samples + col;
        const b = a + 1;
        const c = a + samples;
        const d = c + 1;
        indices.push(a, c, b, b, c, d);
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(colours, 3));
    geo.setIndex(indices);
    geo.computeVertexNormals();
    return geo;
  }, [tile]);

  useEffect(() => () => geometry.dispose(), [geometry]);

  return (
    <mesh
      geometry={geometry}
      receiveShadow
      onPointerDown={() => {
        dragged.current = false;
      }}
      onPointerMove={(event) => {
        dragged.current = true;
        if (draggingId && onDragMove) {
          event.stopPropagation();
          onDragMove(draggingId, event.point.x, event.point.z);
        }
      }}
      onPointerUp={(event) => {
        if (dragged.current || draggingId) return;
        event.stopPropagation();
        onSelect(null);
        onGroundClick(event.point.x, event.point.z);
      }}
    >
      <meshStandardMaterial vertexColors roughness={1} />
    </mesh>
  );
}

function Ground({
  radius,
  onGroundClick,
  onSelect,
  draggingId,
  onDragMove,
}: {
  radius: number;
  onGroundClick: (x: number, z: number) => void;
  onSelect: (id: string | null) => void;
  draggingId: string | null;
  onDragMove?: (id: string, x: number, z: number) => void;
}) {
  const size = Math.max(radius * 4, 400);
  const dragged = useRef(false);

  return (
    <mesh
      rotation={[-Math.PI / 2, 0, 0]}
      position={[0, -0.06, 0]}
      onPointerDown={() => {
        dragged.current = false;
      }}
      onPointerMove={(event) => {
        // Orbiting crosses the ground plane constantly; without this every
        // camera drag would drop a building where the drag ended.
        dragged.current = true;
        if (draggingId && onDragMove) {
          event.stopPropagation();
          onDragMove(draggingId, event.point.x, event.point.z);
        }
      }}
      onPointerUp={(event) => {
        // A press that landed on a BUILDING never reached this mesh's
        // onPointerDown -- Placement stops propagation -- so `dragged` still
        // holds whatever the last ground interaction left. The pointerup does
        // reach here, though, so without the drag check a click on a building
        // also deselected it and dropped a structure behind it.
        if (dragged.current || draggingId) return;
        event.stopPropagation();
        onSelect(null);
        onGroundClick(event.point.x, event.point.z);
      }}
    >
      <planeGeometry args={[size, size]} />
      <meshStandardMaterial color="#0b0f14" roughness={1} />
    </mesh>
  );
}

/**
 * The rank's buildable circle.
 *
 * Over real ground the boundary is draped on the terrain rather than drawn
 * flat. A flat ring on a slope is buried on the high side and hanging on the
 * low one, which on a hilly site means the thing the whole plan is fitted
 * inside is not visible at all.
 *
 * The filled disc goes with it for the same reason -- a flat disc through a
 * hillside reads as neither ground nor boundary. It stays on flat ground,
 * where it does help the area read at a glance.
 */
function BuildableArea({ radius, terrain }: { radius: number; terrain: TerrainTile | null }) {
  const ring = useMemo(() => {
    const points: THREE.Vector3[] = [];
    const segments = 256;
    for (let i = 0; i <= segments; i += 1) {
      const angle = (i / segments) * Math.PI * 2;
      const x = Math.cos(angle) * radius;
      const z = Math.sin(angle) * radius;
      // Lifted clear of the surface so it is not z-fighting the ground it is
      // drawn on; well under the height of anything it could hide.
      const y = terrain ? terrain.heightAt(x, z) + 0.5 : 0;
      points.push(new THREE.Vector3(x, y, z));
    }
    return new THREE.BufferGeometry().setFromPoints(points);
  }, [radius, terrain]);

  useEffect(() => () => ring.dispose(), [ring]);

  return (
    <group position={[0, 0.02, 0]}>
      {terrain ? null : (
        <mesh rotation={[-Math.PI / 2, 0, 0]}>
          <circleGeometry args={[radius, 128]} />
          <meshBasicMaterial color="#1f5f9e" transparent opacity={0.07} depthWrite={false} />
        </mesh>
      )}
      <primitive object={new THREE.Line(ring, new THREE.LineBasicMaterial({ color: '#4ea3ff' }))} />
    </group>
  );
}

function Placement({
  placement,
  selected,
  onSelect,
  onDragStart,
}: {
  placement: PlacedStructure;
  selected: boolean;
  onSelect: (id: string) => void;
  onDragStart: (id: string) => void;
}) {
  const { structure, x, z, rotation, invalid } = placement;
  const footprint = structure.footprint;
  const width = footprint?.widthMetres ?? 8;
  const depth = footprint?.depthMetres ?? 8;

  /**
   * The height the building stands at.
   *
   * The TOP of the ground under its footprint, which is what
   * LotManager::canPlace returns and what the game stands the building on. A
   * player structure neither flattens the terrain nor follows it -- its
   * template sets snapToTerrain = false -- so on a slope it stands level with
   * its highest lot and overhangs the ground falling away beneath. That
   * overhang is the game's real appearance.
   *
   * It arrives already computed, from the placement test in the planner. A
   * fallback is kept for the flat grid, where there is no ground to read.
   */
  const groundY = placement.groundY ?? 0;

  return (
    <group
      position={[x, groundY, z]}
      rotation={[0, rotation, 0]}
      onClick={(event) => {
        event.stopPropagation();
        onSelect(placement.id);
      }}
      onPointerDown={(event) => {
        // Left button only: the right button belongs to the camera.
        if (event.button !== 0) return;
        event.stopPropagation();
        onSelect(placement.id);
        onDragStart(placement.id);
      }}
      onPointerUp={(event) => {
        // Swallowed so the ground below does not also treat this as a click on
        // empty terrain.
        event.stopPropagation();
      }}
    >
      {/*
        The footprint pad is drawn for every placement, model or not. It is the
        thing that actually determines whether a structure fits, and a model
        that is visually smaller than its footprint would otherwise invite
        someone to pack buildings the game will reject.
      */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.04, 0]}>
        <planeGeometry args={[width, depth]} />
        <meshBasicMaterial
          color={invalid ? '#c2413a' : selected ? '#4ea3ff' : '#2b3a4d'}
          transparent
          opacity={invalid ? 0.45 : selected ? 0.4 : 0.25}
          depthWrite={false}
        />
      </mesh>

      {structure.model ? (
        <Suspense fallback={<FootprintBlock width={width} depth={depth} />}>
          <StructureModel model={structure.model} />
        </Suspense>
      ) : (
        <FootprintBlock width={width} depth={depth} />
      )}
    </group>
  );
}

/** Stand-in for a structure with no converted model, sized to its footprint. */
function FootprintBlock({ width, depth }: { width: number; depth: number }) {
  return (
    <mesh position={[0, 3, 0]}>
      <boxGeometry args={[width * 0.7, 6, depth * 0.7]} />
      <meshStandardMaterial color="#243040" roughness={0.9} />
    </mesh>
  );
}

function StructureModel({ model }: { model: string }) {
  const { scene } = useGLTF(`${ASSET_BASE}/models/${model}.glb`);
  // Cloned per placement: the same building appears many times in a plan, and
  // sharing one scene object would put every copy at the last one's position.
  const copy = useMemo(() => scene.clone(true), [scene]);
  return <primitive object={copy} />;
}
