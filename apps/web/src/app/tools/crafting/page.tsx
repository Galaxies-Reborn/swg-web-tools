'use client';

/**
 * Schematic resource finder.
 *
 * Answers the question a Pre-CU crafter actually asks: not "what does this
 * need", which the schematic says, but "what on the server can I make it from
 * right now, and which of it is any good".
 *
 * Resources are ranked by quality against each class's own caps rather than by
 * raw attribute values — a 700 is an excellent roll in one class and a poor one
 * in another, so raw numbers cannot be compared across classes.
 *
 * In this repo there is no server and no galaxy, so only the static half of
 * that is answerable: every schematic and what each slot wants. Which resources
 * are spawned, and therefore what is craftable today, needs a live galaxy. The
 * page says so where those numbers would be rather than showing zeros, because
 * "0 spawned" and "nobody asked" look identical and mean opposite things.
 */

import { Suspense, useCallback, useEffect, useState } from 'react';

import { Empty, PageHeader, Stat, Unavailable } from '@/components/shell';
import { api, qs } from '@/lib/api';

interface SchematicSummary {
  id: string;
  group: string;
  label: string;
  category: string | null;
  resourceSlots: number;
}

interface ResourceMatch {
  resourceId: string;
  name: string;
  classId: string;
  className: string;
  planets: string[];
  quality: number;
  attributes: Record<string, number>;
}

interface SchematicSlot {
  name: string;
  optional: boolean;
  kind: string;
  ingredient: string;
  count: number;
  available: number | null;
  matches: ResourceMatch[];
}

interface SchematicDetail {
  id: string;
  label: string;
  group: string;
  category: string | null;
  crafted: string | null;
  slots: SchematicSlot[];
  /** Null when nothing could be asked, which is not the same as false. */
  craftableNow: boolean | null;
  missingSlots: string[];
}

export default function CraftingPage() {
  return (
    <Suspense fallback={<Empty title="Loading…" />}>
      <CraftingView />
    </Suspense>
  );
}

function CraftingView() {
  const [query, setQuery] = useState('');
  const [group, setGroup] = useState('');
  const [list, setList] = useState<{
    items: SchematicSummary[];
    total: number;
    groups: string[];
  } | null>(null);
  const [selected, setSelected] = useState<SchematicDetail | null>(null);
  const [failed, setFailed] = useState(false);

  const search = useCallback(async (q: string, g: string) => {
    try {
      setList(
        await api<{ items: SchematicSummary[]; total: number; groups: string[] }>(
          `/api/schematics${qs({ q, group: g, limit: 80 })}`,
        ),
      );
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, []);

  // Debounced like the other search pages, so typing does not fire a request
  // per keystroke against a 3,700-entry list.
  useEffect(() => {
    const timer = setTimeout(() => void search(query, group), 250);
    return () => clearTimeout(timer);
  }, [query, group, search]);

  async function open(id: string) {
    try {
      // The id is directory-qualified and contains slashes, which are part of
      // the path rather than something to escape.
      setSelected(await api<SchematicDetail>(`/api/schematics/${id}`));
    } catch {
      setFailed(true);
    }
  }

  if (failed) {
    return (
      <>
        <PageHeader title="Crafting" />
        <Unavailable what="Schematics" />
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Crafting"
        subtitle="Every schematic, and what each of its slots wants."
      />

      {/*
        Said once, at the top, rather than repeated beside every empty number.
        The tools in this repo run with no server behind them, and which
        resources are spawned is a property of a running galaxy rather than of
        the schematic -- so it is absent here, not zero.
      */}
      <p className="mb-4 text-xs text-[var(--color-ink-dim)]">
        Which resources are spawned, and so what is craftable today, needs a live galaxy. These
        tools run without one, so those figures read &ldquo;&mdash;&rdquo; rather than zero.
      </p>

      <div className="mb-4 flex flex-wrap gap-2">
        <input
          className="input flex-1 min-w-[220px]"
          placeholder="Search schematics…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <select className="input" value={group} onChange={(e) => setGroup(e.target.value)}>
          <option value="">All groups</option>
          {(list?.groups ?? []).map((g) => (
            <option key={g} value={g}>
              {g}
            </option>
          ))}
        </select>
      </div>

      <div className="grid gap-4 lg:grid-cols-[320px_1fr]">
        <div className="panel max-h-[640px] overflow-y-auto p-2">
          {list === null ? (
            <p className="p-2 text-xs text-[var(--color-ink-dim)]">Loading…</p>
          ) : list.items.length === 0 ? (
            <Empty title="Nothing matches." />
          ) : (
            <>
              <p className="px-2 py-1 text-xs text-[var(--color-ink-dim)]">
                {list.items.length} of {list.total}
              </p>
              <ul>
                {list.items.map((item) => (
                  <li key={item.id}>
                    <button
                      type="button"
                      onClick={() => void open(item.id)}
                      className={`table-row w-full rounded px-2 py-1 text-left text-xs ${
                        selected?.id === item.id ? 'text-[var(--color-accent)]' : ''
                      }`}
                    >
                      <span className="block capitalize">{item.label}</span>
                      <span className="block text-[var(--color-ink-dim)]">
                        {item.group} · {item.resourceSlots} resource slots
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>

        <div>
          {selected === null ? (
            <Empty title="Pick a schematic." detail="Its slots and the best live resources appear here." />
          ) : (
            <>
              <section className="mb-4 grid gap-3 sm:grid-cols-3">
                <Stat
                  label="Craftable now"
                  value={
                    selected.craftableNow === null
                      ? '—'
                      : selected.craftableNow
                        ? 'Yes'
                        : 'No'
                  }
                  hint={
                    selected.craftableNow === null
                      ? 'needs a live galaxy'
                      : selected.craftableNow
                        ? 'every slot has a spawn'
                        : `waiting on ${selected.missingSlots.join(', ')}`
                  }
                  tone={
                    selected.craftableNow === null
                      ? undefined
                      : selected.craftableNow
                        ? 'good'
                        : 'bad'
                  }
                />
                <Stat
                  label="Resource slots"
                  value={String(selected.slots.filter((s) => s.kind === 'resource').length)}
                  hint={selected.group}
                />
                <Stat
                  label="Components"
                  value={String(selected.slots.filter((s) => s.kind !== 'resource').length)}
                  hint="crafted sub-parts"
                />
              </section>

              <div className="space-y-3">
                {selected.slots.map((slot, index) => (
                  <div key={`${slot.name}:${slot.ingredient}:${index}`} className="panel p-4">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <div>
                        <h3 className="text-sm font-medium capitalize">
                          {slot.name.replace(/_/g, ' ') || slot.ingredient}
                        </h3>
                        <p className="text-xs text-[var(--color-ink-dim)]">
                          {slot.count}× {slot.ingredient.replace(/_/g, ' ')}
                          {slot.optional ? ' · optional' : ''}
                        </p>
                      </div>
                      {slot.kind === 'resource' ? (
                        // A null count means nothing was asked, which must not
                        // be drawn in the same red as "nothing is spawned".
                        <span
                          className={`chip ${
                            slot.available === null
                              ? ''
                              : slot.available > 0
                                ? 'border-[var(--color-good)]/40 text-[var(--color-good)]'
                                : 'border-[var(--color-bad)]/40 text-[var(--color-bad)]'
                          }`}
                        >
                          {slot.available === null ? 'resource' : `${slot.available} spawned`}
                        </span>
                      ) : (
                        <span className="chip">component</span>
                      )}
                    </div>

                    {slot.matches.length > 0 ? (
                      <ul className="mt-3 space-y-1">
                        {slot.matches.map((match) => (
                          <li
                            key={match.resourceId}
                            className="flex flex-wrap items-baseline justify-between gap-2 text-xs"
                          >
                            <span>
                              <span className="font-medium">{match.name}</span>{' '}
                              <span className="text-[var(--color-ink-dim)]">{match.className}</span>
                            </span>
                            <span className="flex items-baseline gap-2">
                              <span className="text-[var(--color-ink-dim)]">
                                {match.planets.join(', ') || 'unknown planets'}
                              </span>
                              {/*
                                Quality is scored against this class's own caps,
                                so it is comparable between classes in a way the
                                raw attribute values are not.
                              */}
                              <span
                                className={`font-mono ${
                                  match.quality >= 0.7
                                    ? 'text-[var(--color-good)]'
                                    : match.quality >= 0.4
                                      ? 'text-[var(--color-ink)]'
                                      : 'text-[var(--color-ink-dim)]'
                                }`}
                              >
                                {(match.quality * 100).toFixed(0)}%
                              </span>
                            </span>
                          </li>
                        ))}
                      </ul>
                    ) : slot.kind === 'resource' ? (
                      // An empty match list means one of two opposite things.
                      // With a galaxy behind it, nothing of this class is up.
                      // Without one, nobody asked -- and saying "nothing is
                      // spawned" there is simply false.
                      <p
                        className={`mt-3 text-xs ${
                          slot.available === null
                            ? 'text-[var(--color-ink-dim)]'
                            : 'text-[var(--color-warn)]'
                        }`}
                      >
                        {slot.available === null
                          ? 'Which resources fill this needs a live galaxy.'
                          : 'Nothing of this class is spawned right now.'}
                      </p>
                    ) : null}
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </>
  );
}
