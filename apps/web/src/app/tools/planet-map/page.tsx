'use client';

/**
 * Planet Map -- where a city goes, rather than how it is laid out.
 *
 * The planner answers "does this fit"; this answers "is this the right place".
 * They share a coordinate space and a saved document, so a plan made in one
 * carries its site into the other: pick a spot here and the planner opens on
 * that ground, or open a plan you already made and see where on the world it
 * actually sits.
 *
 * Ground comes from the whole-planet bake, at the overview resolution. That is
 * 32 m per sample, which is coarse for building on and right for choosing
 * between a coastline and a plateau.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';

import { cityRadius, type CityStructure } from '@precu/shared';

import { PlanetCanvas, PlanetCanvasFallback } from '@/components/planet-canvas';
import { Empty, PageHeader, Stat } from '@/components/shell';
import { api, ApiError } from '@/lib/api';
import {
  MAPPABLE_PLANETS,
  loadPlanetOverview,
  type PlanetOverview,
} from '@/lib/planet-map';

interface SavedRow {
  id: string;
  name: string;
  description: string;
  updatedAt: string;
  isPublic: boolean;
}

/** What the planner writes. Only the parts this tool reads are described. */
interface CityPlanDocument {
  scene?: string;
  rank?: number;
  centre?: { x: number; z: number };
  placements?: { structure?: Partial<CityStructure>; x: number; z: number }[];
}

export default function PlanetMapPage() {
  const [planet, setPlanet] = useState<string>(MAPPABLE_PLANETS[0]);
  const [overview, setOverview] = useState<PlanetOverview | null>(null);
  const [status, setStatus] = useState('Loading ground...');

  const [site, setSite] = useState<{ x: number; z: number } | null>(null);
  const [rank, setRank] = useState(3);
  const [waypoint, setWaypoint] = useState('');

  const [saved, setSaved] = useState<SavedRow[] | null>(null);
  const [planName, setPlanName] = useState<string | null>(null);
  const [structureCount, setStructureCount] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);

  // --- ground -------------------------------------------------------------

  useEffect(() => {
    let cancelled = false;
    setOverview(null);
    setStatus('Loading ground...');
    void loadPlanetOverview(planet).then((loaded) => {
      if (cancelled) return;
      setOverview(loaded);
      setStatus(
        loaded
          ? ''
          : `No terrain baked for ${planet} yet. Run: tre-extract terrain --planet ${planet} --planet-wide`,
      );
    });
    return () => {
      cancelled = true;
    };
  }, [planet]);

  // --- saved plans --------------------------------------------------------

  const loadSaved = useCallback(async () => {
    try {
      const body = await api<{ items: SavedRow[] }>('/api/designs/city_plan');
      setSaved(body.items);
    } catch (error) {
      // Not signed in, or no store. The map is still usable without plans.
      setSaved([]);
      if (error instanceof ApiError && error.status !== 401) setNotice(error.message);
    }
  }, []);

  useEffect(() => {
    void loadSaved();
  }, [loadSaved]);

  const openPlan = useCallback(
    async (id: string, name: string) => {
      try {
        const design = await api<{ payload: unknown }>(`/api/designs/city_plan/${id}`);
        const plan = design.payload as CityPlanDocument;
        setPlanName(name);
        setStructureCount(plan.placements?.length ?? 0);
        if (plan.rank) setRank(plan.rank);
        if (plan.scene && MAPPABLE_PLANETS.includes(plan.scene as never)) {
          setPlanet(plan.scene);
        }
        // A plan made before siting existed carries an origin centre, which is
        // not a place -- so it is treated as unsited rather than dropped on the
        // middle of the world.
        const centre = plan.centre;
        setSite(centre && (centre.x !== 0 || centre.z !== 0) ? centre : null);
        setNotice(
          centre && (centre.x !== 0 || centre.z !== 0)
            ? null
            : `"${name}" has no site yet. Click the planet to place it.`,
        );
      } catch {
        setNotice('Could not open that plan.');
      }
    },
    [],
  );

  // --- siting -------------------------------------------------------------

  const applyWaypoint = useCallback((text: string) => {
    const numbers = text.match(/-?\d+(?:\.\d+)?/g);
    if (!numbers || numbers.length < 2) return;
    const named = text.match(
      /\b(tatooine|naboo|corellia|rori|talus|dantooine|dathomir|endor|lok|yavin4)\b/i,
    );
    if (named) setPlanet(named[1].toLowerCase());
    const [x, z] =
      numbers.length >= 3
        ? [Number(numbers[0]), Number(numbers[2])]
        : [Number(numbers[0]), Number(numbers[1])];
    setSite({ x, z });
  }, []);

  const radius = cityRadius(rank);

  /** What the ground under the site is like, which is the point of looking. */
  const siteReport = useMemo(() => {
    if (!overview || !site) return null;
    const centre = overview.heightAt(site.x, site.z);
    let wet = 0;
    let lowest = Infinity;
    let highest = -Infinity;
    const step = overview.spacing;
    for (let dz = -radius; dz <= radius; dz += step) {
      for (let dx = -radius; dx <= radius; dx += step) {
        if (Math.hypot(dx, dz) > radius) continue;
        const x = site.x + dx;
        const z = site.z + dz;
        if (!overview.contains(x, z)) continue;
        const h = overview.heightAt(x, z);
        lowest = Math.min(lowest, h);
        highest = Math.max(highest, h);
        if (overview.isWater(x, z)) wet += 1;
      }
    }
    const cells = Math.max(1, Math.round((Math.PI * radius * radius) / (step * step)));
    return { centre, relief: highest - lowest, wetShare: wet / cells };
  }, [overview, site, radius]);

  return (
    <div className="space-y-4">
      <PageHeader
        title="Planet Map"
        subtitle="Where a city goes. Pick a site on the real ground, or open a plan and see where it sits."
      />

      <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
        <div>
          {overview ? (
            <PlanetCanvas
              overview={overview}
              site={site}
              siteRadius={radius}
              onPick={(x, z) => {
                setSite({ x: Math.round(x), z: Math.round(z) });
                setNotice(null);
              }}
            />
          ) : (
            <PlanetCanvasFallback message={status} />
          )}
          <p className="mt-2 text-xs text-[var(--color-ink-dim)]">
            Click the surface to site the city. Drag to orbit, scroll to zoom. Relief is
            exaggerated six times &mdash; a planet is 16 km across and rises only a few hundred
            metres, so at true scale it reads as a flat sheet.
          </p>
        </div>

        <div className="space-y-3">
          <div className="panel p-4">
            <label className="block text-sm">
              <span className="label">Planet</span>
              <select
                className="input mt-1 w-full"
                value={planet}
                onChange={(event) => setPlanet(event.target.value)}
              >
                {MAPPABLE_PLANETS.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </label>

            <label className="mt-3 block text-sm">
              <span className="label">Waypoint</span>
              <input
                className="input mt-1 w-full"
                placeholder="/way tatooine 3528 5 -4804"
                value={waypoint}
                onChange={(event) => setWaypoint(event.target.value)}
                onBlur={() => applyWaypoint(waypoint)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') applyWaypoint(waypoint);
                }}
              />
            </label>

            <label className="mt-3 block text-sm">
              <span className="label">City rank</span>
              <select
                className="input mt-1 w-full"
                value={rank}
                onChange={(event) => setRank(Number(event.target.value))}
              >
                {[1, 2, 3, 4, 5].map((value) => (
                  <option key={value} value={value}>
                    rank {value} &mdash; {cityRadius(value)} m radius
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="panel p-4">
            <h2 className="label mb-2">Site</h2>
            {site ? (
              <div className="space-y-2">
                <p className="text-sm">
                  {Math.round(site.x)}, {Math.round(site.z)}
                  {planName ? <span className="text-[var(--color-ink-dim)]"> &mdash; {planName}</span> : null}
                </p>
                <div className="grid grid-cols-2 gap-2">
                  <Stat label="Ground" value={`${siteReport?.centre.toFixed(0) ?? '?'} m`} />
                  <Stat
                    label="Relief"
                    value={`${siteReport?.relief.toFixed(0) ?? '?'} m`}
                    hint="across the city"
                    tone={siteReport && siteReport.relief > 40 ? 'bad' : undefined}
                  />
                </div>
                {siteReport && siteReport.wetShare > 0.01 ? (
                  <p className="text-xs text-[var(--color-warn,#d08b45)]">
                    About {Math.round(siteReport.wetShare * 100)}% of this radius is water, which
                    cannot be built on.
                  </p>
                ) : null}
                {structureCount ? (
                  <p className="text-xs text-[var(--color-ink-dim)]">
                    {structureCount} structures in this plan.
                  </p>
                ) : null}
                <a
                  className="btn btn-primary mt-1 inline-block text-xs"
                  href={`/tools/city-planner?scene=${planet}&x=${Math.round(site.x)}&z=${Math.round(site.z)}`}
                >
                  Lay it out here
                </a>
              </div>
            ) : (
              <p className="text-xs text-[var(--color-ink-dim)]">
                Click the planet, or paste a waypoint, to choose a site.
              </p>
            )}
            {notice ? <p className="mt-2 text-xs text-[var(--color-ink-dim)]">{notice}</p> : null}
          </div>

          <div className="panel p-4">
            <h2 className="label mb-2">Saved plans</h2>
            {saved === null ? (
              <p className="text-xs text-[var(--color-ink-dim)]">Loading...</p>
            ) : saved.length === 0 ? (
              <Empty title="No saved plans" detail="Lay one out in the city planner first." />
            ) : (
              <ul className="space-y-1">
                {saved.map((row) => (
                  <li key={row.id}>
                    <button
                      type="button"
                      className="table-row w-full rounded px-2 py-1 text-left text-xs"
                      onClick={() => void openPlan(row.id, row.name)}
                    >
                      {row.name}
                      <span className="ml-1 text-[var(--color-ink-dim)]">{row.description}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
