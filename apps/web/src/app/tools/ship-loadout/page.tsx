'use client';

/**
 * Ship loadout planner.
 *
 * The engine enforces two things when installing a component: the slot must
 * accept its compatibility token, and total mass must stay within the chassis
 * budget. That budget comes from the chassis's craft schematic, not from
 * shiptype.tab — a crafted X-wing gets 97,500, where shiptype.tab's placeholder
 * says 10,000 for every player hull alike.
 *
 * Loadouts save as JSON through the shared design store.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';

import {
  chassisByName,
  componentByName,
  componentsForSlot,
  paintForChassis,
  patternCountForChassis,
  playerFlyableChassis,
  totalsFor,
  type ShipChassis,
  wingsOf,
} from '@precu/shared';

import { Empty, PageHeader, Stat } from '@/components/shell';
import { api, ApiError } from '@/lib/api';
import type { AttachedPart } from '@/components/ship-canvas';

const ASSET_BASE = process.env.NEXT_PUBLIC_ASSET_BASE ?? '/assets';

/**
 * One chassis's attachment table, as generated from the game's own
 * ship_chassis_<chassis> datatable.
 */
interface ChassisAttachments {
  chassis: string;
  /** Hull models the chassis table never names but constantly relies on. */
  structural?: { model: string; mount: string | null; on?: string | null }[];
  components: Record<
    string,
    Record<
      string,
      {
        attachments?: { model: string; hardpoint: string }[];
        /** Hardpoints the game keeps for targeting, with nothing to draw. */
        extraHardpoints?: string[];
      }
    >
  >;
}

const ShipCanvas = dynamic(() => import('@/components/ship-canvas').then((m) => m.ShipCanvas), {
  ssr: false,
  loading: () => (
    <div className="panel flex h-[520px] items-center justify-center text-sm text-[var(--color-ink-dim)]">
      Loading the ship…
    </div>
  ),
});

interface SavedRow {
  id: string;
  name: string;
  description: string;
}

/** Fighters first: they are what most people are actually outfitting. */
const CHASSIS_ORDER = [...playerFlyableChassis()].sort((a, b) => a.label.localeCompare(b.label));

export default function ShipLoadoutPage() {
  const [chassisName, setChassisName] = useState(
    CHASSIS_ORDER.find((c) => c.name === 'player_xwing')?.name ?? CHASSIS_ORDER[0]?.name ?? '',
  );
  const [components, setComponents] = useState<Record<string, string | null>>({});
  const [showHardpoints, setShowHardpoints] = useState(false);
  const [unplaced, setUnplaced] = useState<string[]>([]);
  const [attachments, setAttachments] = useState<ChassisAttachments | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** Chosen palette index per paint channel, keyed by customisation variable. */
  const [paint, setPaint] = useState<Record<string, number>>({});
  /** Which pattern the colours are painted through. */
  const [pattern, setPattern] = useState(0);
  /** S-foils out. Only offered on the hulls that have them. */
  const [wingsOpen, setWingsOpen] = useState(false);

  /**
   * The chassis's attachment table, fetched when the hull changes.
   *
   * This is the game's own per-chassis data — which model hangs off which
   * hardpoint for a given component in a given slot. It is several megabytes
   * across all 57 chassis, so only the one in front of the player is loaded.
   */
  useEffect(() => {
    let cancelled = false;
    setAttachments(null);
    fetch(`${ASSET_BASE}/ship-attachments/${chassisName}.json`)
      .then((response) => (response.ok ? response.json() : null))
      .then((body: ChassisAttachments | null) => {
        if (cancelled) return;
        // A chassis with no table draws no parts, which is different from one
        // whose table has not arrived yet.
        setAttachments(body ?? { chassis: chassisName, components: {}, structural: [] });
      })
      .catch(() => {
        if (!cancelled) setAttachments({ chassis: chassisName, components: {}, structural: [] });
      });
    return () => {
      cancelled = true;
    };
  }, [chassisName]);

  const [saved, setSaved] = useState<SavedRow[] | null>(null);
  const [loadoutName, setLoadoutName] = useState('New loadout');
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const chassis: ShipChassis | undefined = chassisByName(chassisName);
  // Whether this hull's wings open, and what flying with them out costs. Both
  // come from wing_open_speed_factor, which the engine multiplies top speed by
  // while the wings are out.
  const wings = chassis ? wingsOf(chassis) : { opens: false, speedFactor: 1 };

  // Slots differ per hull, so switching chassis has to clear the loadout
  // rather than carry components into slots that may not exist.
  useEffect(() => {
    setComponents({});
    setUnplaced([]);
    // Each hull ships with its own scheme, so the pickers start where the game
    // starts rather than carrying the last hull's colours across.
    const scheme = paintForChassis(chassisName);
    setPaint(
      Object.fromEntries((scheme?.channels ?? []).map((c) => [c.variable, c.defaultIndex])),
    );
    setPattern(0);
    setWingsOpen(false);
  }, [chassisName]);

  const loadSaved = useCallback(async () => {
    try {
      const body = await api<{ items: SavedRow[] }>('/api/designs/ship_loadout');
      setSaved(body.items);
    } catch {
      setSaved([]);
    }
  }, []);

  useEffect(() => {
    void loadSaved();
  }, [loadSaved]);

  const totals = useMemo(
    () => (chassis ? totalsFor(chassis, components) : null),
    [chassis, components],
  );

  /**
   * Components this chassis actually has a part model for, by slot.
   *
   * A slot only appears here when the chassis table names a model for at least
   * one component in it. Reactors, shields, armour, capacitors, droid
   * interfaces and cargo holds never do — the game draws nothing for them
   * either — so those slots are absent and keep the full compatible list. A
   * slot the table does cover is narrowed to what it covers.
   */
  const modelledBySlot = useMemo(() => {
    const bySlot = new Map<string, Set<string>>();
    if (!attachments) return bySlot;
    for (const [name, slots] of Object.entries(attachments.components)) {
      for (const [slot, cell] of Object.entries(slots)) {
        if (!cell.attachments?.length) continue;
        let set = bySlot.get(slot);
        if (!set) {
          set = new Set();
          bySlot.set(slot, set);
        }
        set.add(name);
      }
    }
    return bySlot;
  }, [attachments]);

  /** The hull's paint as the canvas needs it: one pattern, two resolved colours. */
  const paintSelection = useMemo(() => {
    const scheme = paintForChassis(chassisName);
    if (!scheme || Object.keys(scheme.models).length === 0) return null;

    const colourFor = (index: number) => {
      const channel = scheme.channels[index];
      if (!channel) return '#ffffff';
      const at = paint[channel.variable] ?? channel.defaultIndex;
      return channel.colours[at] ?? '#ffffff';
    };

    return {
      pattern,
      primaryColour: colourFor(0),
      secondaryColour: colourFor(1),
      models: scheme.models,
    };
  }, [chassisName, pattern, paint]);

  const { parts, noPart } = useMemo(() => {
    const list: AttachedPart[] = [];
    const missing: string[] = [];
    if (!chassis || !attachments) return { parts: list, noPart: missing };

    for (const [slot, name] of Object.entries(components)) {
      if (!name) continue;
      const component = componentByName(name);
      if (!component) continue;

      const cell = attachments.components[component.name]?.[slot];
      const models = cell?.attachments ?? [];
      if (models.length === 0) {
        // The table knowing about the component but naming no model means the
        // game draws nothing either -- a reactor is internal, and a TIE's
        // engine glow is an effect rather than a mesh. Only a component the
        // table does not mention at all is a gap worth reporting.
        if (cell === undefined) missing.push(slot);
        continue;
      }
      for (const { model, hardpoint } of models) {
        list.push({ slot, model, hardpoint, label: component.label });
      }
    }
    return { parts: list, noPart: missing };
  }, [components, chassis, attachments]);

  function toDocument() {
    return { version: 1 as const, chassis: chassisName, components };
  }

  const applyDocument = useCallback((doc: unknown): boolean => {
    const loadout = doc as { chassis?: string; components?: Record<string, string | null> } | null;
    if (!loadout?.chassis) {
      setNotice('That file is not a ship loadout.');
      return false;
    }
    if (!chassisByName(loadout.chassis)) {
      setNotice(`Unknown chassis "${loadout.chassis}".`);
      return false;
    }
    setChassisName(loadout.chassis);
    // Applied after the chassis-change effect has cleared state, or the clear
    // would wipe what was just loaded.
    setTimeout(() => setComponents(loadout.components ?? {}), 0);
    setNotice(null);
    return true;
  }, []);

  /** Listings carry no payload, so opening one fetches the document. */
  async function openSaved(id: string, name: string) {
    try {
      const design = await api<{ payload: unknown }>(`/api/designs/ship_loadout/${id}`);
      // The id is adopted only after the document validates. Adopting it first
      // meant a failed load left Update pointing at a row the editor was not
      // showing, so the next save overwrote the wrong loadout.
      if (!applyDocument(design.payload)) return;
      setCurrentId(id);
      setLoadoutName(name);
    } catch {
      setNotice('Could not load that loadout.');
    }
  }

  async function save() {
    setBusy(true);
    setNotice(null);
    const body = {
      name: loadoutName.trim() || 'Untitled loadout',
      description: `${chassis?.label ?? chassisName} · ${
        Object.values(components).filter(Boolean).length
      } components`,
      isPublic: false,
      payload: toDocument(),
    };
    try {
      const row = currentId
        ? await api<SavedRow>(`/api/designs/ship_loadout/${currentId}`, {
            method: 'PUT',
            body: JSON.stringify(body),
          })
        : await api<SavedRow>('/api/designs/ship_loadout', {
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
            ? 'Sign in from My Characters to save loadouts.'
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
    link.download = `${(loadoutName || 'loadout').replace(/[^\w-]+/g, '-')}.json`;
    link.click();
    URL.revokeObjectURL(url);
  }

  const massPercent = totals && totals.massMax > 0 ? (totals.mass / totals.massMax) * 100 : 0;

  return (
    <>
      <PageHeader
        title="Ship loadout"
        subtitle="Outfit a hull against the two limits the engine enforces: slot compatibility and total mass."
      />

      <section className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="Mass"
          value={totals ? totals.mass.toLocaleString() : '—'}
          hint={totals ? `of ${totals.massMax.toLocaleString()} budget` : ''}
          tone={totals?.overweight ? 'bad' : 'good'}
        />
        <Stat
          label="Remaining"
          value={totals ? totals.massRemaining.toLocaleString() : '—'}
          hint={totals?.overweight ? 'over budget' : 'headroom'}
          tone={totals?.overweight ? 'bad' : undefined}
        />
        <Stat label="Hull points" value={(chassis?.hitPoints ?? 0).toLocaleString()} hint={chassis?.label ?? ''} />
        <Stat
          label="Slots filled"
          value={`${Object.values(components).filter(Boolean).length}/${chassis?.slots.length ?? 0}`}
          hint={totals?.incompatible.length ? `${totals.incompatible.length} incompatible` : 'all compatible'}
          tone={totals?.incompatible.length ? 'bad' : undefined}
        />
      </section>

      <div className="grid gap-4 lg:grid-cols-[1fr_360px]">
        <div>
          <ShipCanvas
            hull={chassis?.model ?? null}
            parts={parts}
            structural={attachments?.structural ?? []}
            paint={paintSelection}
            wingsOpen={wingsOpen}
            showHardpoints={showHardpoints}
            onUnplaced={setUnplaced}
          />

          {/* Mass is the binding constraint, so it gets a real gauge. */}
          {totals ? (
            <div className="mt-3">
              <div className="mb-1 flex items-baseline justify-between text-xs">
                <span className="label">Mass budget</span>
                <span className={totals.overweight ? 'text-[var(--color-bad)]' : 'text-[var(--color-ink-dim)]'}>
                  {totals.mass.toLocaleString()} / {totals.massMax.toLocaleString()}
                </span>
              </div>
              <div className="h-2 w-full overflow-hidden rounded bg-[var(--color-edge)]">
                <div
                  className={`h-full ${totals.overweight ? 'bg-[var(--color-bad)]' : 'bg-[var(--color-accent)]'}`}
                  style={{ width: `${Math.min(100, massPercent)}%` }}
                />
              </div>
            </div>
          ) : null}

          <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-[var(--color-ink-dim)]">
            <label className="flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={showHardpoints}
                onChange={(e) => setShowHardpoints(e.target.checked)}
              />
              Show hardpoints
            </label>
            {wings.opens ? (
              <label className="flex items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={wingsOpen}
                  onChange={(e) => setWingsOpen(e.target.checked)}
                />
                S-foils open
                <span className="text-[var(--color-ink-dim)]">
                  ({Math.round((1 - wings.speedFactor) * 100)}% slower)
                </span>
              </label>
            ) : null}
            {noPart.length > 0 ? (
              <span className="text-[var(--color-warn)]">
                Not drawn: {[...new Set(noPart)].join(', ')}. This chassis&apos;s attachment table
                names no model for that component, which is usually because the game draws nothing
                either — an internal component has no external part, and a TIE&apos;s engine glow is
                an effect rather than a mesh.
              </span>
            ) : null}
          </div>
          {notice ? <p className="mt-2 text-xs text-[var(--color-warn)]">{notice}</p> : null}
        </div>

        <div className="space-y-4">
          <div className="panel p-4">
            <label className="block text-sm">
              <span className="text-xs text-[var(--color-ink-dim)]">Chassis</span>
              <select
                className="input mt-1 w-full"
                value={chassisName}
                onChange={(e) => setChassisName(e.target.value)}
              >
                {CHASSIS_ORDER.map((c) => (
                  <option key={c.name} value={c.name}>
                    {c.label} — {c.massMax.toLocaleString()} mass
                  </option>
                ))}
              </select>
            </label>
          </div>

          <PaintPanel
            chassis={chassisName}
            paint={paint}
            onChange={setPaint}
            pattern={pattern}
            onPattern={setPattern}
          />

          <Collapsible
            title="Slots"
            summary={`${Object.values(components).filter(Boolean).length}/${chassis?.slots.length ?? 0} filled`}
          >
            <div className="max-h-[430px] space-y-2 overflow-y-auto pr-1">
              {chassis?.slots.map((slot) => {
                const compatible = componentsForSlot(chassis, slot.slot);
                const modelled = modelledBySlot.get(slot.slot);
                // Narrowing to what the chassis has a part for is only evidence
                // when the table covers the slot broadly. A capital hull names
                // just its built-in turret meshes -- the corvette's table has a
                // single row -- and every crafted weapon is absent for the same
                // reason a reactor is: nothing extra is drawn for it. Reading
                // that as "not installable" left weapon_0..6 with one option
                // each. Below a third coverage the absence means nothing.
                const broadCoverage =
                  modelled !== undefined && modelled.size >= compatible.length / 3;
                const options = broadCoverage
                  ? compatible.filter((c) => modelled.has(c.name))
                  : compatible;

                // A loadout saved before these filters existed can name a
                // component the list no longer offers. Without an option to
                // match it the select falls to selectedIndex -1 and renders
                // blank, while the component keeps counting toward mass — the
                // slot looks empty and the totals disagree with it. Keep it,
                // and say why it is unusual.
                const chosenName = components[slot.slot] ?? '';
                const orphaned = chosenName !== '' && !options.some((c) => c.name === chosenName);
                const chosen = components[slot.slot] ?? '';
                const component = chosen ? componentByName(chosen) : undefined;
                return (
                  <label key={slot.slot} className="block text-xs">
                    <span className="flex items-baseline justify-between">
                      <span className="text-[var(--color-ink-dim)]">{slot.slot}</span>
                      {component?.mass != null ? (
                        <span className="font-mono text-[var(--color-ink-dim)]">
                          {component.mass.toLocaleString()}
                        </span>
                      ) : null}
                    </span>
                    <select
                      className="input mt-0.5 w-full text-xs"
                      value={chosen}
                      onChange={(e) =>
                        setComponents((current) => ({
                          ...current,
                          [slot.slot]: e.target.value || null,
                        }))
                      }
                    >
                      <option value="">— empty —</option>
                      {orphaned ? (
                        <option value={chosenName}>
                          {componentByName(chosenName)?.label ?? chosenName} — not offered for this
                          hull
                        </option>
                      ) : null}
                      {options.map((option) => (
                        <option key={option.name} value={option.name}>
                          {option.label}
                          {option.mass != null ? ` (${option.mass.toLocaleString()})` : ''}
                        </option>
                      ))}
                    </select>
                  </label>
                );
              })}
            </div>
            {totals?.unknownMass.length ? (
              <p className="mt-2 text-xs text-[var(--color-warn)]">
                {totals.unknownMass.length} component(s) have no mass on record, so the total is a
                lower bound.
              </p>
            ) : null}
          </Collapsible>

          <div className="panel p-4">
            <h2 className="label mb-2">Loadout</h2>
            <input
              className="input mb-2 w-full text-sm"
              value={loadoutName}
              onChange={(e) => setLoadoutName(e.target.value)}
              placeholder="Loadout name"
            />
            <div className="flex flex-wrap gap-1.5">
              <button type="button" className="btn text-xs" onClick={save} disabled={busy}>
                {busy ? 'Saving…' : currentId ? 'Update' : 'Save'}
              </button>
              <button type="button" className="btn text-xs" onClick={exportJson}>
                Export JSON
              </button>
              <button type="button" className="btn text-xs" onClick={() => fileInput.current?.click()}>
                Import
              </button>
              <button
                type="button"
                className="btn text-xs"
                onClick={() => {
                  setComponents({});
                  setCurrentId(null);
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
          </div>

          <div className="panel p-4">
            <h2 className="label mb-2">Saved loadouts</h2>
            {saved === null ? (
              <p className="text-xs text-[var(--color-ink-dim)]">Loading…</p>
            ) : saved.length === 0 ? (
              <Empty title="No saved loadouts." detail="Sign in from My Characters to save." />
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
 * The paint schemes a hull offers.
 *
 * A ship's paint is two palette indices, not a free colour: the shader tints
 * the texture through a 64-entry palette, masked by that texture's own alpha,
 * so only the parts the artist marked take the colour. Showing the palette as
 * swatches is therefore showing exactly what the game offers — no more, no
 * fewer.
 */
function PaintPanel({
  chassis,
  paint,
  onChange,
  pattern,
  onPattern,
}: {
  chassis: string;
  paint: Record<string, number>;
  onChange: (next: Record<string, number>) => void;
  pattern: number;
  onPattern: (index: number) => void;
}) {
  const scheme = paintForChassis(chassis);
  const patternCount = patternCountForChassis(chassis);
  if (!scheme) {
    return (
      <Collapsible title="Paint" summary="none">
        <p className="text-xs text-[var(--color-ink-dim)]">
          This hull has no paint channels — its colours are painted into the texture with no
          customisation variable behind them.
        </p>
      </Collapsible>
    );
  }

  return (
    <Collapsible
      title="Paint"
      summary={patternCount > 1 ? `pattern ${pattern + 1} of ${patternCount}` : undefined}
    >
      {patternCount > 1 ? (
        <div className="mb-3">
          <span className="mb-1 block text-xs text-[var(--color-ink-dim)]">Pattern</span>
          <div className="flex flex-wrap gap-1">
            {Array.from({ length: patternCount }, (_, index) => (
              <button
                key={index}
                type="button"
                onClick={() => onPattern(index)}
                className={`btn px-2 py-0.5 text-xs ${
                  index === pattern ? 'border-[var(--color-accent)] text-[var(--color-accent)]' : ''
                }`}
              >
                {index + 1}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      <div className="space-y-3">
        {scheme.channels.map((channel, index) => {
          const chosen = paint[channel.variable] ?? channel.defaultIndex;
          return (
            <div key={channel.variable}>
              <div className="mb-1 flex items-baseline justify-between">
                <span className="text-xs text-[var(--color-ink-dim)]">
                  {index === 0 ? 'Primary' : 'Secondary'}
                </span>
                <span className="font-mono text-[10px] text-[var(--color-ink-dim)]">
                  {channel.colours[chosen] ?? '—'}
                  {chosen === channel.defaultIndex ? ' · stock' : ''}
                </span>
              </div>
              <div className="grid gap-1" style={{ gridTemplateColumns: 'repeat(16, minmax(0, 1fr))' }}>
                {channel.colours.map((colour, i) => (
                  <button
                    key={i}
                    type="button"
                    title={`${i}: ${colour}${i === channel.defaultIndex ? ' (stock)' : ''}`}
                    onClick={() => onChange({ ...paint, [channel.variable]: i })}
                    className={`h-4 w-full rounded-sm border ${
                      i === chosen
                        ? 'border-[var(--color-accent)]'
                        : 'border-transparent hover:border-[var(--color-edge)]'
                    }`}
                    style={{ backgroundColor: colour }}
                  />
                ))}
              </div>
            </div>
          );
        })}
      </div>
      <p className="mt-2 text-[10px] text-[var(--color-ink-dim)]">
        {scheme.channels[0]?.colours.length ?? 0} colours per channel, from{' '}
        {scheme.channels[0]?.palette.split('/').pop()}.
      </p>
    </Collapsible>
  );
}

/**
 * A panel that folds away.
 *
 * The loadout side is long — sixty-four swatches twice over, then fifteen slots
 * — and on a short window the ship ends up scrolled off. Open by default,
 * because hiding what the tool is for would be worse than the scrolling.
 */
function Collapsible({
  title,
  children,
  summary,
}: {
  title: string;
  children: React.ReactNode;
  summary?: string;
}) {
  const [open, setOpen] = useState(true);

  return (
    <div className="panel p-4">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full items-baseline justify-between text-left"
        aria-expanded={open}
      >
        <span className="label">{title}</span>
        <span className="flex items-baseline gap-2 text-xs text-[var(--color-ink-dim)]">
          {summary ? <span>{summary}</span> : null}
          <span aria-hidden>{open ? '−' : '+'}</span>
        </span>
      </button>
      {open ? <div className="mt-2">{children}</div> : null}
    </div>
  );
}
