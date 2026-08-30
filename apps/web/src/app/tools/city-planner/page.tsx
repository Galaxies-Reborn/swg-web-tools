'use client';

/**
 * City planner.
 *
 * Lays out a player city under the rules the server actually enforces: the
 * buildable radius comes from the rank table, structures unlock at the rank
 * the structure table says, and footprints come from the game's own .sfp
 * grids. Anything the planner accepts should be something the game accepts.
 *
 * Plans are saved as JSON through the shared design store, so a layout can be
 * revisited, shared, or handed to someone else to build.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';

import {
  CITY_LIMITS,
  CITY_RANKS,
  CITY_STRUCTURES,
  cityMaintenanceCost,
  cityRadius,
  fitsInCity,
  maxCivicStructures,
  overlaps,
  placeableOn,
  rankLocks,
  structureLabel,
  type CityStructure,
} from '@precu/shared';

import { loadSiteTerrain, type TerrainTile } from '@/lib/terrain';

import { Empty, PageHeader, Stat } from '@/components/shell';
import { api, ApiError } from '@/lib/api';
import type { PlacedStructure } from '@/components/city-canvas';

const CityCanvas = dynamic(
  () => import('@/components/city-canvas').then((m) => m.CityCanvas),
  {
    ssr: false,
    loading: () => (
      <div className="panel flex h-[620px] items-center justify-center text-sm text-[var(--color-ink-dim)]">
        Loading the plan view…
      </div>
    ),
  },
);

interface SavedRow {
  id: string;
  name: string;
  description: string;
  updatedAt: string;
  isPublic: boolean;
}

/** Ids only need to be unique within one plan, and plans are small. */
let nextId = 1;
const makeId = () => `p${nextId++}`;

/** Deep enough to cover a session's mistakes without holding a plan per frame. */
const HISTORY_LIMIT = 50;

/**
 * Snap a structure to the lot grid by its EDGES, not its centre.
 *
 * A footprint an odd number of cells wide has its centre half a cell off the
 * line, so snapping the centre leaves every such building straddling the grid
 * it is drawn over.
 */
function snapToLots(
  structure: CityStructure,
  x: number,
  z: number,
  rotation = 0,
): [number, number] {
  const half = (cells: number) => (cells % 2 === 0 ? 0 : 4);
  const fp = structure.footprint;
  // A quarter turn swaps which axis carries the odd cell count. Without this a
  // rotated odd-by-even footprint -- the theatre is 5 by 6 -- snaps by the wrong
  // axis and sits 4 m off the lot grid it is drawn over.
  const quarters = Math.abs(Math.round(rotation / (Math.PI / 2)) % 2);
  const acrossX = quarters === 1 ? (fp?.height ?? 1) : (fp?.width ?? 1);
  const acrossZ = quarters === 1 ? (fp?.width ?? 1) : (fp?.height ?? 1);
  return [
    Math.round((x - half(acrossX)) / 8) * 8 + half(acrossX),
    Math.round((z - half(acrossZ)) / 8) * 8 + half(acrossZ),
  ];
}

export default function CityPlannerPage() {
  const [rank, setRank] = useState(3);
  const [scene, setScene] = useState(CITY_LIMITS[0]?.scene ?? 'tatooine');
  /**
   * Where on the planet this plan sits, from a waypoint the player pastes in.
   *
   * Null means the plan is not sited: the planner is then the abstract grid it
   * has always been, which is still a fine way to work out a layout. Siting it
   * only adds truth -- the real ground, and the water the game will refuse to
   * build on.
   */
  const [anchor, setAnchor] = useState<{ x: number; z: number } | null>(null);
  const [waypoint, setWaypoint] = useState('');
  const [terrain, setTerrain] = useState<TerrainTile | null>(null);
  const [terrainNote, setTerrainNote] = useState<string | null>(null);
  const [placements, setPlacements] = useState<PlacedStructure[]>([]);
  // Undo history. A plan is fiddly to rebuild, and the two operations most
  // worth having are also the two easiest to do by accident: dropping a
  // building in the wrong place, and deleting one.
  const [history, setHistory] = useState<PlacedStructure[][]>([]);
  const [future, setFuture] = useState<PlacedStructure[][]>([]);
  const [pending, setPending] = useState<CityStructure | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [saved, setSaved] = useState<SavedRow[] | null>(null);
  const [planName, setPlanName] = useState('New city');
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  /** Apply a change and make it undoable. */
  const commit = useCallback(
    (next: PlacedStructure[]) => {
      setHistory((current) => [...current.slice(-HISTORY_LIMIT), placements]);
      setFuture([]);
      setPlacements(next);
    },
    [placements],
  );

  // Arrive from the Planet Map with a site already chosen. Read once on mount:
  // after that the waypoint box and the map are the two ways to move, and
  // re-reading the URL would fight whichever the user is using.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const x = Number(params.get('x'));
    const z = Number(params.get('z'));
    const scene = params.get('scene');
    if (!Number.isFinite(x) || !Number.isFinite(z) || !params.get('x')) return;
    if (scene) setScene(scene);
    setAnchor({ x, z });
    setWaypoint(`${scene ?? ''} ${x} ${z}`.trim());
  }, []);

  // Fetch the ground whenever the site moves. It is cut out of the planet-wide
  // bake, which covers the whole world, so any coordinate on a baked planet has
  // ground -- there is no per-site bake to be missing any more. Only a planet
  // that has never been baked falls back to the flat grid.
  //
  // A little wider than the city, so the ground does not stop at the boundary
  // the plan is being fitted against.
  useEffect(() => {
    if (!anchor) {
      setTerrain(null);
      setTerrainNote(null);
      return;
    }
    let cancelled = false;
    setTerrainNote('Loading ground...');
    const span = cityRadius(rank) * 2 + 200;
    void loadSiteTerrain(scene, anchor.x, anchor.z, span).then((tile) => {
      if (cancelled) return;
      setTerrain(tile);
      setTerrainNote(
        tile
          ? null
          : `No terrain baked for ${scene}. Showing the flat grid. ` +
              `Run: tre-extract terrain --planet ${scene} --planet-wide`,
      );
    });
    return () => {
      cancelled = true;
    };
  }, [anchor, scene, rank]);

  /**
   * Read a waypoint the way a player would paste one.
   *
   * The game prints `/way <planet> X Y Z` and people copy the whole line, so
   * take that, and also accept bare numbers for anyone typing coordinates off
   * a map. The middle number is height, which is exactly what the terrain says
   * -- so it is read and discarded rather than trusted.
   */
  const applyWaypoint = useCallback(
    (text: string) => {
      const numbers = text.match(/-?\d+(?:\.\d+)?/g);
      if (!numbers || numbers.length < 2) {
        setAnchor(null);
        setTerrainNote(text.trim() ? 'Could not read a coordinate from that.' : null);
        return;
      }
      const planet = text.match(/\b(tatooine|naboo|corellia|rori|talus|dantooine|dathomir|endor|lok|yavin4)\b/i);
      if (planet) setScene(planet[1].toLowerCase());
      // Three numbers means X Y Z with height in the middle; two means X Z.
      const [x, z] =
        numbers.length >= 3
          ? [Number(numbers[0]), Number(numbers[2])]
          : [Number(numbers[0]), Number(numbers[1])];
      setAnchor({ x, z });
    },
    [],
  );

  const radius = cityRadius(rank);
  // The radius is not the only limit on a plan: a rank 2 city has map room
  // for far more civic buildings than the nineteen it is allowed.
  const civicCap = maxCivicStructures(rank);
  // Civic buildings and player housing, both filtered to what a deed will
  // actually place on this planet.
  // Everything buildable on this planet, not only what this rank unlocks. A
  // structure above the rank is shown locked rather than hidden -- see
  // placeableOn. Hiding them made the shuttleport, the only thing gated above
  // rank 3, silently absent with no hint that a higher rank would reveal it.
  const palette = useMemo(() => placeableOn(scene), [scene]);
  const civicPalette = palette.filter((s) => s.civic);
  const housingPalette = palette.filter((s) => !s.civic);

  const loadSaved = useCallback(async () => {
    try {
      const body = await api<{ items: SavedRow[] }>('/api/designs/city_plan');
      setSaved(body.items);
    } catch (error) {
      // Not signed in is the common case and not an error worth shouting
      // about: the planner works fine without an account, it just cannot save.
      setSaved(error instanceof ApiError && error.status === 401 ? [] : []);
    }
  }, []);

  useEffect(() => {
    void loadSaved();
  }, [loadSaved]);

  /**
   * Keyboard shortcuts for the two operations people reach for by reflex.
   *
   * Skipped while a field has focus, so typing a plan name does not delete the
   * selected building on the first backspace.
   */
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (target?.isContentEditable) return;

      const undoChord = (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z';
      if (undoChord) {
        event.preventDefault();
        if (event.shiftKey) redo();
        else undo();
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'y') {
        event.preventDefault();
        redo();
        return;
      }
      if (event.key === 'Delete' || event.key === 'Backspace') {
        if (!selectedId) return;
        event.preventDefault();
        removeSelected();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  /**
   * Rank can drop below what is already placed, so validity is derived on
   * every render rather than stamped at placement time. Lowering the rank
   * should show you what stops fitting, not silently keep it legal.
   */
  const validated = useMemo(() => {
    // Which placements are past the civic cap, counted among civic structures
    // only. The ones past it are the ones placed last, so the plan stays
    // stable as you add to it.
    const overCapIndices = new Set<number>();
    let civicSoFar = 0;
    placements.forEach((placement, index) => {
      if (!placement.structure.civic) return;
      if (civicSoFar >= civicCap) overCapIndices.add(index);
      civicSoFar += 1;
    });

    return placements.map((placement, index) => {
      const outside = !fitsInCity(
        placement.structure,
        placement.x,
        placement.z,
        radius,
        placement.rotation,
      );
      const locked = placement.structure.cityRank > rank;
      const collides = placements.some(
        (other, otherIndex) => otherIndex !== index && overlaps(placement, other),
      );
      // A city may hold only so many civic structures however much room is
      // inside the radius: `1 + rank * 9`, from getMaxCivicCount in city.java.
      const overCap = overCapIndices.has(index);

      // The reason travels with the placement. Re-deriving it in the panel let
      // the list of causes drift from the list of tests, and an over-cap
      // building was reported as overlapping something it did not touch.
      const reason = locked
        ? `Needs rank ${placement.structure.cityRank}.`
        : outside
          ? 'Outside the buildable radius.'
          : overCap
            ? `Past the civic cap of ${civicCap} for rank ${rank}.`
            : collides
              ? 'Overlaps another structure.'
              : null;

      return { ...placement, invalid: reason !== null, reason };
    });
  }, [placements, radius, rank, civicCap]);

  const problems = validated.filter((p) => p.invalid).length;
  const civicPlaced = placements.filter((p) => p.structure.civic).length;
  // CITY_COST is a tier index (1..6), not an amount: city.java switches on it
  // to pick a flag and then maps that flag to a credit figure. Summing the
  // index reported "16 credits" for a city costing tens of thousands, and got
  // the ordering backwards too — tier 4 is the cheapest, not the dearest.
  const totalCost = placements.reduce(
    (sum, p) => sum + cityMaintenanceCost(p.structure.cityCost, rank),
    0,
  );
  // Civic structures have MAINT_RATE 0 — a city pays for them from its own
  // treasury at the rate the city cost tier names, which is what the panel
  // should show.
  const maintenance = placements.reduce(
    (sum, p) => sum + (p.structure.civic ? 0 : p.structure.maintenanceRate),
    0,
  );

  const place = useCallback(
    (x: number, z: number) => {
      if (!pending) {
        setNotice('Pick a structure from the palette first.');
        return;
      }
      const [snapX, snapZ] = snapToLots(pending, x, z);
      commit([
        ...placements,
        { id: makeId(), structure: pending, x: snapX, z: snapZ, rotation: 0 },
      ]);
      setNotice(null);
    },
    [pending, placements, commit],
  );

  const selected = validated.find((p) => p.id === selectedId) ?? null;

  function updateSelected(change: Partial<PlacedStructure>) {
    if (!selectedId) return;
    commit(placements.map((p) => (p.id === selectedId ? { ...p, ...change } : p)));
  }

  function removeSelected() {
    if (!selectedId) return;
    commit(placements.filter((p) => p.id !== selectedId));
    setSelectedId(null);
  }

  function undo() {
    const previous = history[history.length - 1];
    if (!previous) return;
    setHistory(history.slice(0, -1));
    setFuture([placements, ...future]);
    setPlacements(previous);
    setSelectedId(null);
  }

  function redo() {
    const next = future[0];
    if (!next) return;
    setFuture(future.slice(1));
    setHistory([...history, placements]);
    setPlacements(next);
    setSelectedId(null);
  }

  /**
   * Dragging is one undo step, and only if it actually moved something.
   *
   * The snapshot is taken on the first MOVE, not on the press. Pressing a
   * building is also how it is selected, so snapshotting on pointerdown burned
   * an undo entry — and cleared the redo stack — every time someone clicked one
   * to look at it. Everything after the first move replaces the position
   * without touching history, so one undo puts the building back where it was
   * picked up.
   */
  const dragSnapshot = useRef<PlacedStructure[] | null>(null);

  function startDrag() {
    dragSnapshot.current = placements;
  }

  function dragTo(id: string, x: number, z: number) {
    const target = placements.find((p) => p.id === id);
    if (!target) return;

    const [snapX, snapZ] = snapToLots(target.structure, x, z, target.rotation);
    // Nothing moved -- the pointer is still inside the same lot -- so this is
    // not yet a drag and must not cost an undo step.
    if (snapX === target.x && snapZ === target.z) return;

    // The first real movement is what opens the undo entry, and it is opened
    // here rather than inside the state updater: React may invoke an updater
    // twice, which would push the entry twice.
    if (dragSnapshot.current) {
      const before = dragSnapshot.current;
      dragSnapshot.current = null;
      setHistory((h) => [...h.slice(-HISTORY_LIMIT), before]);
      setFuture([]);
    }

    setPlacements((current) =>
      current.map((p) => (p.id === id ? { ...p, x: snapX, z: snapZ } : p)),
    );
  }

  function endDrag() {
    dragSnapshot.current = null;
  }

  function toDocument() {
    return {
      version: 1 as const,
      scene,
      rank,
      centre: anchor ?? { x: 0, z: 0 },
      placements: placements.map((p) => ({
        id: p.id,
        template: p.structure.template,
        modelKey: p.structure.model,
        x: p.x,
        z: p.z,
        rotation: p.rotation,
        label: structureLabel(p.structure),
      })),
    };
  }

  const applyDocument = useCallback((doc: unknown) => {
    const plan = doc as ReturnType<typeof toDocument> | null;
    if (!plan || !Array.isArray(plan.placements)) {
      setNotice('That file is not a city plan.');
      return;
    }
    setScene(plan.scene ?? 'tatooine');
    setRank(plan.rank ?? 1);

    // Resolve templates against the current structure list rather than trusting
    // what was saved: a plan made before a structure changed rank should load
    // with today's rules, and one referencing a template that no longer exists
    // should say so instead of rendering an invisible building.
    // Every structure, not just the civic palette. A plan can legitimately
    // contain player housing, and resolving against civic-only silently
    // dropped those placements on load — the plan came back smaller than it
    // was saved.
    const byTemplate = new Map(CITY_STRUCTURES.map((s) => [s.template, s]));
    const restored: PlacedStructure[] = [];
    let dropped = 0;
    for (const entry of plan.placements) {
      const structure = byTemplate.get(entry.template);
      if (!structure) {
        dropped += 1;
        continue;
      }
      restored.push({
        id: makeId(),
        structure,
        x: Number(entry.x) || 0,
        z: Number(entry.z) || 0,
        rotation: Number(entry.rotation) || 0,
      });
    }
    setPlacements(restored);
    setSelectedId(null);
    setNotice(
      dropped > 0 ? `Loaded, but ${dropped} placement(s) referenced unknown structures.` : null,
    );
  }, []);

  /** Listings carry no payload, so opening one fetches the document. */
  async function openSaved(id: string, name: string) {
    try {
      const design = await api<{ payload: unknown }>(`/api/designs/city_plan/${id}`);
      setCurrentId(id);
      setPlanName(name);
      applyDocument(design.payload);
    } catch {
      setNotice('Could not load that plan.');
    }
  }

  async function save() {
    setBusy(true);
    setNotice(null);
    const body = {
      name: planName.trim() || 'Untitled city',
      description: `${scene} · rank ${rank} · ${placements.length} structures`,
      isPublic: false,
      payload: toDocument(),
    };
    try {
      const row = currentId
        ? await api<SavedRow>(`/api/designs/city_plan/${currentId}`, {
            method: 'PUT',
            body: JSON.stringify(body),
          })
        : await api<SavedRow>('/api/designs/city_plan', {
            method: 'POST',
            body: JSON.stringify(body),
          });
      setCurrentId(row.id);
      setNotice('Saved.');
      await loadSaved();
    } catch (error) {
      setNotice(
        error instanceof ApiError
          ? error.status === 401
            ? 'Sign in from My Characters to save plans.'
            : error.message
          : 'Could not save.',
      );
    } finally {
      setBusy(false);
    }
  }

  function exportJson() {
    const blob = new Blob([JSON.stringify(toDocument(), null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${(planName || 'city-plan').replace(/[^\w-]+/g, '-')}.json`;
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <>
      <PageHeader
        title="City planner"
        subtitle="Lay out a player city under the game's own rules — rank radius, structure unlocks, and real footprints."
      />

      <section className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Buildable radius" value={`${radius} m`} hint={`rank ${rank}`} tone="good" />
        <Stat
          label="Structures placed"
          value={String(placements.length)}
          hint={`${civicPalette.length} civic · ${housingPalette.length} houses here`}
        />
        <Stat
          label="Civic buildings"
          value={`${civicPlaced} / ${civicCap}`}
          hint="cap is 1 + rank x 9"
          tone={civicPlaced > civicCap ? 'bad' : undefined}
        />
        <Stat label="City upkeep" value={totalCost.toLocaleString()} hint="credits per maintenance cycle" tone="credit" />
        <Stat
          label="Problems"
          value={String(problems)}
          hint={problems ? 'outside radius, overlapping, rank-locked, or past the civic cap' : 'everything fits'}
          tone={problems ? 'bad' : 'good'}
        />
      </section>

      <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
        <div>
          <CityCanvas
            radius={radius}
            placements={validated}
            selectedId={selectedId}
            onGroundClick={place}
            onSelect={setSelectedId}
            onDragStart={startDrag}
            onDragMove={dragTo}
            onDragEnd={endDrag}
            terrain={terrain}
          />
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              className="btn text-xs"
              disabled={history.length === 0}
              onClick={undo}
              title="Ctrl+Z"
            >
              Undo{history.length ? ` (${history.length})` : ''}
            </button>
            <button
              type="button"
              className="btn text-xs"
              disabled={future.length === 0}
              onClick={redo}
              title="Ctrl+Shift+Z"
            >
              Redo
            </button>
            <button
              type="button"
              className="btn text-xs"
              disabled={!selectedId}
              onClick={removeSelected}
              title="Delete"
            >
              Remove selected
            </button>
          </div>
          {notice ? (
            <p className="mt-2 text-xs text-[var(--color-warn)]">{notice}</p>
          ) : (
            <p className="mt-2 text-xs text-[var(--color-ink-dim)]">
              Pick a structure, then click the ground to place it. Grid squares are one lot (8 m).
              Drag a building to move it; Delete removes it; Ctrl+Z undoes. Drag the ground to
              orbit; scroll to zoom.
            </p>
          )}
        </div>

        <div className="space-y-4">
          <div className="panel p-4">
            <h2 className="label mb-2">City</h2>
            <label className="mb-2 block text-sm">
              <span className="text-xs text-[var(--color-ink-dim)]">Planet</span>
              <select
                className="input mt-1 w-full"
                value={scene}
                onChange={(e) => setScene(e.target.value)}
              >
                {CITY_LIMITS.map((limit) => (
                  <option key={limit.scene} value={limit.scene}>
                    {limit.scene} (max {limit.maxCities} cities)
                  </option>
                ))}
              </select>
            </label>

            <label className="block text-sm">
              <span className="label">Site</span>
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
              <span className="mt-1 block text-xs text-[var(--color-ink-dim)]">
                {terrainNote ??
                  (anchor
                    ? `Sited at ${Math.round(anchor.x)}, ${Math.round(anchor.z)} on ${scene}.`
                    : 'Paste a waypoint to lay the plan out on the real ground.')}
              </span>
            </label>
            <label className="block text-sm">
              <span className="text-xs text-[var(--color-ink-dim)]">Rank</span>
              <select
                className="input mt-1 w-full"
                value={rank}
                onChange={(e) => setRank(Number(e.target.value))}
              >
                {CITY_RANKS.map((r) => (
                  <option key={r.rank} value={r.rank}>
                    Rank {r.rank} — {r.radius} m, {r.citizens} citizens
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="panel p-4">
            <h2 className="label mb-2">Structures</h2>
            <p className="mb-2 text-xs text-[var(--color-ink-dim)]">
              Only what a deed will place on {scene}.
            </p>
            <div className="max-h-96 space-y-3 overflow-y-auto pr-1">
              <StructureGroup
                title="Civic"
                structures={civicPalette}
                pending={pending}
                onPick={setPending}
                rank={rank}
              />
              <StructureGroup
                title="Player houses"
                structures={housingPalette}
                pending={pending}
                onPick={setPending}
                rank={rank}
              />
            </div>
          </div>

          {selected ? (
            <div className="panel p-4">
              <h2 className="label mb-2">Selected</h2>
              <p className="text-sm">{structureLabel(selected.structure)}</p>
              <p className="mt-0.5 font-mono text-xs text-[var(--color-ink-dim)]">
                {Math.round(selected.x)}, {Math.round(selected.z)} ·{' '}
                {Math.hypot(selected.x, selected.z).toFixed(0)} m from centre
              </p>
              {selected.invalid ? (
                <p className="mt-1 text-xs text-[var(--color-bad)]">
                  {selected.reason}
                </p>
              ) : null}
              <div className="mt-3 flex flex-wrap gap-1.5">
                <button
                  type="button"
                  className="btn text-xs"
                  onClick={() => updateSelected({ rotation: (selected.rotation + Math.PI / 2) % (Math.PI * 2) })}
                >
                  Rotate 90°
                </button>
                <button type="button" className="btn text-xs" onClick={removeSelected}>
                  Remove
                </button>
              </div>
            </div>
          ) : null}

          <div className="panel p-4">
            <h2 className="label mb-2">Plan</h2>
            <input
              className="input mb-2 w-full text-sm"
              value={planName}
              onChange={(e) => setPlanName(e.target.value)}
              placeholder="Plan name"
            />
            <div className="flex flex-wrap gap-1.5">
              <button type="button" className="btn text-xs" onClick={save} disabled={busy}>
                {busy ? 'Saving…' : currentId ? 'Update' : 'Save'}
              </button>
              <button type="button" className="btn text-xs" onClick={exportJson}>
                Export JSON
              </button>
              <button
                type="button"
                className="btn text-xs"
                onClick={() => fileInput.current?.click()}
              >
                Import
              </button>
              <button
                type="button"
                className="btn text-xs"
                onClick={() => {
                  commit([]);
                  setCurrentId(null);
                  setSelectedId(null);
                }}
              >
                Clear
              </button>
            </div>
            <input
              ref={fileInput}
              type="file"
              accept="application/json"
              className="hidden"
              onChange={async (event) => {
                const file = event.target.files?.[0];
                if (!file) return;
                try {
                  applyDocument(JSON.parse(await file.text()));
                } catch {
                  setNotice('That file is not valid JSON.');
                }
                event.target.value = '';
              }}
            />
            {maintenance > 0 ? (
              <p className="mt-2 text-xs text-[var(--color-ink-dim)]">
                Upkeep {maintenance.toLocaleString()} cr/hr across placed structures.
              </p>
            ) : null}
          </div>

          <div className="panel p-4">
            <h2 className="label mb-2">Saved plans</h2>
            {saved === null ? (
              <p className="text-xs text-[var(--color-ink-dim)]">Loading…</p>
            ) : saved.length === 0 ? (
              <Empty title="No saved plans." detail="Sign in from My Characters to save." />
            ) : (
              <ul className="space-y-1">
                {saved.map((row) => (
                  <li key={row.id}>
                    <button
                      type="button"
                      className="table-row w-full rounded px-2 py-1 text-left text-xs"
                      onClick={() => {
                        void openSaved(row.id, row.name);
                      }}
                    >
                      <span className="block">{row.name}</span>
                      <span className="block text-[var(--color-ink-dim)]">{row.description}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

/**
 * One labelled section of the palette.
 *
 * Civic buildings and houses are different things — one is paid for by the
 * city and counts against its civic cap, the other is paid for by a player and
 * costs them lots — so they are not worth mixing into one flat list.
 */
function StructureGroup({
  title,
  structures,
  pending,
  onPick,
  rank,
}: {
  title: string;
  structures: CityStructure[];
  pending: CityStructure | null;
  onPick: (structure: CityStructure) => void;
  /** The city's rank, so a structure it cannot yet hold is shown locked. */
  rank: number;
}) {
  if (structures.length === 0) {
    return (
      <div>
        <p className="label mb-1">{title}</p>
        <p className="px-2 text-xs text-[var(--color-ink-dim)]">None available here.</p>
      </div>
    );
  }

  return (
    <div>
      <p className="label mb-1">
        {title} <span className="text-[var(--color-ink-dim)]">({structures.length})</span>
      </p>
      <div className="space-y-1">
        {structures.map((structure) => {
          const locked = rankLocks(structure, rank);
          return (
            <button
              key={structure.template}
              type="button"
              disabled={locked}
              // Say what is missing on the row itself. The placement panel
              // already carried a reason, but only once the building had been
              // placed and clicked -- by which time the red pad looks like an
              // obstruction rather than a rank the city has not reached.
              title={locked ? `Needs rank ${structure.cityRank}` : undefined}
              onClick={() => onPick(structure)}
              className={`table-row flex w-full items-baseline justify-between gap-2 rounded px-2 py-1 text-left text-xs ${
                locked
                  ? 'cursor-not-allowed border border-transparent opacity-40'
                  : pending?.template === structure.template
                    ? 'border border-[var(--color-accent)] text-[var(--color-accent)]'
                    : 'border border-transparent'
              }`}
            >
              <span>{structureLabel(structure)}</span>
              <span className="shrink-0 text-[var(--color-ink-dim)]">
                {locked
                  ? `rank ${structure.cityRank}`
                  : structure.footprint
                    ? `${structure.footprint.widthMetres}×${structure.footprint.depthMetres}m`
                    : '—'}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
