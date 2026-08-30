import Link from 'next/link';

import { PageHeader } from '@/components/shell';

export const metadata = {
  title: 'SWG Web Tools',
  description:
    'Planet map, city planner, ship builder and asset viewer for Star Wars Galaxies Pre-CU.',
};

const TOOLS = [
  {
    href: '/tools/planet-map',
    title: 'Planet Map',
    detail:
      'A whole planet as real ground. Pick a site for a city and see what it is standing on — how far the land moves across the city’s own radius, and how much of it is water and cannot be built on.',
  },
  {
    href: '/tools/city-planner',
    title: 'City Planner',
    detail:
      'Lay out a city on the lot grid, on the real terrain if you have baked it. What a rank can hold, which buildings a planet allows and what each costs come from the game’s own structure tables.',
  },
  {
    href: '/tools/ship-loadout',
    title: 'Ship Builder',
    detail:
      'Fit a starfighter and see it assembled — components offered only where the chassis accepts them, parts hung on the hardpoints the attachment tables name, and the paint schemes the hull can actually wear.',
  },
  {
    href: '/assets',
    title: 'Asset Viewer',
    detail:
      'Browse the converted client models: geometry, materials, hardpoints and animation clips, one at a time.',
  },
];

export default function HomePage() {
  return (
    <div className="space-y-6">
      <PageHeader
        title="SWG Web Tools"
        subtitle="Planning tools for Star Wars Galaxies Pre-CU, built from the game's own data."
      />

      <div className="grid gap-3 sm:grid-cols-2">
        {TOOLS.map((tool) => (
          <Link
            key={tool.href}
            href={tool.href}
            className="panel block p-4 transition-colors hover:border-[var(--color-accent)]"
          >
            <h2 className="mb-1 text-sm font-medium text-[var(--color-accent)]">{tool.title}</h2>
            <p className="text-xs leading-relaxed text-[var(--color-ink-dim)]">{tool.detail}</p>
          </Link>
        ))}
      </div>

      <div className="panel p-4">
        <h2 className="label mb-2">Before the 3D views work</h2>
        <p className="text-xs leading-relaxed text-[var(--color-ink-dim)]">
          The ship builder and the asset viewer draw models converted from a copy of the game
          client, and the planet map and planner draw ground baked from its terrain files. Neither
          is distributed here — both are generated from your own client. See the README. The city
          planner works without either, as a plain lot grid.
        </p>
      </div>
    </div>
  );
}
