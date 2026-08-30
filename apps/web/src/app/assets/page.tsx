'use client';

/**
 * Asset browser and 3D viewer.
 *
 * Reads the manifest the TRE pipeline writes; when there is no manifest the
 * page says exactly how to produce one rather than showing an empty grid.
 */

import { useEffect, useMemo, useState } from 'react';
import dynamic from 'next/dynamic';

import type { AssetEntry } from '@precu/shared';

import { Empty, PageHeader } from '@/components/shell';
import { api, qs } from '@/lib/api';

// three.js has no business in the server bundle, and the viewer is only
// mounted once a user picks something.
const ModelViewer = dynamic(
  () => import('@/components/model-viewer').then((m) => m.ModelViewer),
  {
    ssr: false,
    loading: () => (
      <div className="panel flex h-[520px] items-center justify-center text-sm text-[var(--color-ink-dim)]">
        Loading viewer…
      </div>
    ),
  },
);

interface ManifestResponse {
  generatedAt: string;
  total: number;
  entries: AssetEntry[];
}

const ASSET_BASE = process.env.NEXT_PUBLIC_ASSET_BASE ?? '/assets';

export default function AssetsPage() {
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState('');
  const [manifest, setManifest] = useState<ManifestResponse | null>(null);
  const [missing, setMissing] = useState(false);
  const [selected, setSelected] = useState<AssetEntry | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => {
      void api<ManifestResponse>(`/api/assets/manifest${qs({ q: query, kind, limit: 300 })}`)
        .then((result) => {
          setManifest(result);
          setMissing(false);
        })
        .catch(() => setMissing(true));
    }, 200);
    return () => clearTimeout(timer);
  }, [query, kind]);

  const dimensions = useMemo(() => {
    if (!selected) return null;
    const [minX, minY, minZ] = selected.bounds.min;
    const [maxX, maxY, maxZ] = selected.bounds.max;
    return {
      width: maxX - minX,
      height: maxY - minY,
      depth: maxZ - minZ,
    };
  }, [selected]);

  if (missing) {
    return (
      <>
        <PageHeader title="Assets" />
        <div className="panel p-6">
          <p className="text-sm">No asset manifest has been generated yet.</p>
          <p className="mt-2 text-sm text-[var(--color-ink-dim)]">
            The models are converted from your own copy of the game client and
            are not distributed with these tools. Generate a tree and place it at{' '}
            <code>apps/web/public/assets</code>, or point{' '}
            <code>NEXT_PUBLIC_ASSET_BASE</code> at one. The README describes the
            layout the viewer expects:
          </p>
          <pre className="mt-3 overflow-x-auto rounded border border-[var(--color-edge)] bg-[var(--color-void)] p-3 text-xs">
{`assets/
  manifest.json
  models/*.glb
  patterns/*.webp`}
          </pre>
        </div>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Assets"
        subtitle={
          manifest
            ? `${manifest.total.toLocaleString()} models converted from the client archives`
            : 'Loading manifest'
        }
      />

      <div className="grid gap-4 lg:grid-cols-[360px_1fr]">
        <div>
          <div className="panel mb-3 grid gap-3 p-3">
            <input
              className="input"
              placeholder="Search models"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <select
              className="input"
              value={kind}
              onChange={(e) => setKind(e.target.value)}
              aria-label="Kind"
            >
              <option value="">All kinds</option>
              <option value="static">Static meshes</option>
              <option value="component">Composites</option>
              <option value="skinned">Skinned (not yet converted)</option>
            </select>
          </div>

          <div className="panel max-h-[560px] divide-y divide-[var(--color-edge)]/60 overflow-y-auto">
            {manifest?.entries.length ? (
              manifest.entries.map((entry) => (
                <button
                  key={entry.key}
                  onClick={() => setSelected(entry)}
                  className={`block w-full px-3 py-2 text-left text-sm transition-colors hover:bg-[var(--color-panel-2)] ${
                    selected?.key === entry.key ? 'bg-[var(--color-panel-2)]' : ''
                  }`}
                >
                  <div className="truncate font-medium">{entry.name}</div>
                  <div className="truncate text-xs text-[var(--color-ink-dim)]">
                    {entry.triangles.toLocaleString()} tris · {(entry.sizeBytes / 1024).toFixed(0)} KB
                  </div>
                </button>
              ))
            ) : (
              <div className="p-6 text-center text-sm text-[var(--color-ink-dim)]">
                No models match.
              </div>
            )}
          </div>
        </div>

        <div>
          {selected ? (
            <>
              <ModelViewer
                src={`${ASSET_BASE}/${selected.model}`}
                animations={selected.animations}
              />
              <div className="panel mt-3 grid gap-4 p-4 sm:grid-cols-2">
                <div>
                  <h2 className="font-medium">{selected.name}</h2>
                  <p className="mt-0.5 font-mono text-xs text-[var(--color-ink-dim)]">
                    {selected.key}
                  </p>
                </div>
                <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
                  <dt className="text-[var(--color-ink-dim)]">Triangles</dt>
                  <dd className="text-right font-mono">{selected.triangles.toLocaleString()}</dd>
                  <dt className="text-[var(--color-ink-dim)]">LOD levels</dt>
                  <dd className="text-right font-mono">{selected.lodCount}</dd>
                  <dt className="text-[var(--color-ink-dim)]">Size</dt>
                  <dd className="text-right font-mono">
                    {(selected.sizeBytes / 1024).toFixed(0)} KB
                  </dd>
                  {dimensions ? (
                    <>
                      <dt className="text-[var(--color-ink-dim)]">Dimensions</dt>
                      <dd className="text-right font-mono">
                        {dimensions.width.toFixed(1)} × {dimensions.height.toFixed(1)} ×{' '}
                        {dimensions.depth.toFixed(1)} m
                      </dd>
                    </>
                  ) : null}
                </dl>
              </div>
            </>
          ) : (
            <Empty
              title="Pick a model to view it."
              detail="Drag to orbit, scroll to zoom. Models are the highest LOD the client ships."
            />
          )}
        </div>
      </div>
    </>
  );
}
