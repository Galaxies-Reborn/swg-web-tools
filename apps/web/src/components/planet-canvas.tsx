'use client';

/**
 * A whole planet, drawn as ground rather than as a picture of ground.
 *
 * The mesh is the overview bake -- one vertex per 32 m sample, 512 a side --
 * which is 262,000 vertices and draws comfortably. Height is exaggerated,
 * because a planet is 16 km across and its mountains are a few hundred metres:
 * at true scale the whole world is a flat sheet and none of the relief anyone
 * is looking for is visible.
 *
 * The camera starts overhead, since siting a city is a map task. It is a real
 * 3D scene rather than a 2D image so the same view can be tilted to read a
 * valley's shape, which is exactly the thing a flat map hides.
 */

import { useEffect, useMemo, useRef, useState } from 'react';

import { Canvas } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import * as THREE from 'three';

import { FLAG_WATER, type PlanetOverview } from '@/lib/planet-map';

/**
 * How much taller than life the relief is drawn.
 *
 * A planet spans 16,384 m and rises a few hundred, so unexaggerated terrain is
 * visually flat. Six is enough to read a mountain range at a glance without
 * turning gentle ground into spikes.
 */
const HEIGHT_EXAGGERATION = 6;

export interface PlanetCanvasProps {
  overview: PlanetOverview;
  /** Where the plan sits, in world metres, or null when it is not sited. */
  site: { x: number; z: number } | null;
  /** The city's buildable radius, so the marker is its real size. */
  siteRadius: number;
  /** Click on the planet, in world metres. */
  onPick: (x: number, z: number) => void;
  className?: string;
}

export function PlanetCanvas({
  overview,
  site,
  siteRadius,
  onPick,
  className,
}: PlanetCanvasProps) {
  const half = overview.meta.mapWidth / 2;

  return (
    <div className={className ?? 'h-[520px] w-full overflow-hidden rounded border border-[var(--color-edge)]'}>
      <Canvas
        camera={{ position: [0, half * 1.15, half * 0.75], fov: 45, near: 10, far: half * 8 }}
        dpr={[1, 1.75]}
      >
        <color attach="background" args={['#05080c']} />
        <hemisphereLight args={['#9fb4cc', '#1a1410', 0.7]} />
        <directionalLight position={[half, half, half * 0.6]} intensity={1.4} />

        <PlanetSurface overview={overview} onPick={onPick} />
        {site ? <SiteMarker overview={overview} site={site} radius={siteRadius} /> : null}

        <OrbitControls
          makeDefault
          minDistance={400}
          maxDistance={half * 3}
          maxPolarAngle={Math.PI / 2.05}
        />
      </Canvas>
    </div>
  );
}

function PlanetSurface({
  overview,
  onPick,
}: {
  overview: PlanetOverview;
  onPick: (x: number, z: number) => void;
}) {
  const dragged = useRef(false);

  const geometry = useMemo(() => {
    const { samples, spacing, heights, flags } = overview.grid;
    const half = ((samples - 1) * spacing) / 2;
    const positions = new Float32Array(samples * samples * 3);
    const colours = new Float32Array(samples * samples * 3);

    const at = (col: number, row: number) => heights[row * samples + col] / 10;

    let lowest = Infinity;
    let highest = -Infinity;
    for (let i = 0; i < heights.length; i += 1) {
      const metres = heights[i] / 10;
      lowest = Math.min(lowest, metres);
      highest = Math.max(highest, metres);
    }
    const span = Math.max(highest - lowest, 1);

    for (let row = 0; row < samples; row += 1) {
      for (let col = 0; col < samples; col += 1) {
        const i = row * samples + col;
        const metres = at(col, row);
        positions[i * 3] = -half + col * spacing;
        positions[i * 3 + 1] = metres * HEIGHT_EXAGGERATION;
        positions[i * 3 + 2] = -half + row * spacing;

        if (flags[i] & FLAG_WATER) {
          colours[i * 3] = 0.05;
          colours[i * 3 + 1] = 0.2;
          colours[i * 3 + 2] = 0.36;
        } else {
          // Banded by elevation, which is how a physical map reads: low ground
          // green-grey, high ground pale. Relative to this planet's own range,
          // so a flat world is not rendered as one uniform colour.
          const t = (metres - lowest) / span;
          colours[i * 3] = 0.13 + t * 0.62;
          colours[i * 3 + 1] = 0.16 + t * 0.55;
          colours[i * 3 + 2] = 0.13 + t * 0.46;
        }
      }
    }

    const indices: number[] = [];
    for (let row = 0; row < samples - 1; row += 1) {
      for (let col = 0; col < samples - 1; col += 1) {
        const a = row * samples + col;
        indices.push(a, a + samples, a + 1, a + 1, a + samples, a + samples + 1);
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(colours, 3));
    geo.setIndex(indices);
    geo.computeVertexNormals();
    return geo;
  }, [overview]);

  useEffect(() => () => geometry.dispose(), [geometry]);

  return (
    <mesh
      geometry={geometry}
      onPointerDown={() => {
        dragged.current = false;
      }}
      onPointerMove={() => {
        // Orbiting a planet crosses its surface constantly; without this every
        // camera swing would re-site the city.
        dragged.current = true;
      }}
      onPointerUp={(event) => {
        if (dragged.current) return;
        event.stopPropagation();
        onPick(event.point.x, event.point.z);
      }}
    >
      <meshStandardMaterial vertexColors roughness={1} />
    </mesh>
  );
}

/**
 * Where the plan sits, at its real size.
 *
 * A city is at most 900 m across on a 16 km planet, so at true scale the marker
 * is under a twentieth of the view and easy to lose. It gets a pillar as well
 * as a disc: the disc is the honest footprint, and the pillar is what makes it
 * findable from across the world.
 */
function SiteMarker({
  overview,
  site,
  radius,
}: {
  overview: PlanetOverview;
  site: { x: number; z: number };
  radius: number;
}) {
  const y = overview.heightAt(site.x, site.z) * HEIGHT_EXAGGERATION;
  const pillar = Math.max(overview.meta.mapWidth * 0.02, 200);

  return (
    <group position={[site.x, y, site.z]}>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 4, 0]}>
        <circleGeometry args={[radius, 48]} />
        <meshBasicMaterial color="#4ea3ff" transparent opacity={0.45} depthWrite={false} />
      </mesh>
      <mesh position={[0, pillar / 2, 0]}>
        <cylinderGeometry args={[radius * 0.06, radius * 0.06, pillar, 8]} />
        <meshBasicMaterial color="#4ea3ff" />
      </mesh>
    </group>
  );
}

/** Loading and empty states, so a missing bake explains itself. */
export function PlanetCanvasFallback({ message }: { message: string }) {
  const [dots, setDots] = useState('');
  useEffect(() => {
    const timer = setInterval(() => setDots((d) => (d.length >= 3 ? '' : `${d}.`)), 400);
    return () => clearInterval(timer);
  }, []);
  return (
    <div className="flex h-[520px] w-full items-center justify-center rounded border border-[var(--color-edge)] bg-[var(--color-void)]">
      <p className="text-sm text-[var(--color-ink-dim)]">
        {message}
        {message.endsWith('...') ? dots : null}
      </p>
    </div>
  );
}
