import Link from 'next/link';
import type { ReactNode } from 'react';

const NAV = [
  { href: '/', label: 'Tools' },
  { href: '/tools/planet-map', label: 'Planet Map' },
  { href: '/tools/city-planner', label: 'City Planner' },
  { href: '/tools/ship-loadout', label: 'Ship Builder' },
  { href: '/assets', label: 'Assets' },
];

export function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-40 border-b border-[var(--color-edge)] bg-[var(--color-void)]/85 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-[1400px] items-center gap-6 px-4">
          <Link href="/" className="flex items-center gap-2 shrink-0">
            <span className="text-lg font-semibold tracking-tight">PRE-CU</span>
            <span className="text-lg font-light tracking-[0.25em] text-[var(--color-accent)]">
              REBORN
            </span>
          </Link>
          <nav className="flex flex-1 items-center gap-1 overflow-x-auto">
            {NAV.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="whitespace-nowrap rounded px-3 py-1.5 text-sm text-[var(--color-ink-dim)] transition-colors hover:bg-[var(--color-panel-2)] hover:text-[var(--color-ink)]"
              >
                {item.label}
              </Link>
            ))}
          </nav>
        </div>
      </header>

      <main className="mx-auto max-w-[1400px] px-4 py-8">{children}</main>

      <footer className="mt-16 border-t border-[var(--color-edge)] py-8">
        <div className="mx-auto max-w-[1400px] px-4 text-xs text-[var(--color-ink-dim)]">
          <p>
            An unofficial Star Wars Galaxies emulator restoring Publish 14.1. Not affiliated with
            Lucasfilm, Disney, or Sony Online Entertainment.
          </p>
        </div>
      </footer>
    </div>
  );
}

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {subtitle ? <p className="mt-1 text-sm text-[var(--color-ink-dim)]">{subtitle}</p> : null}
      </div>
      {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function Stat({
  label,
  value,
  hint,
  tone = 'default',
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: 'default' | 'credit' | 'good' | 'bad';
}) {
  const toneClass = {
    default: '',
    credit: 'text-[var(--color-credit)]',
    good: 'text-[var(--color-good)]',
    bad: 'text-[var(--color-bad)]',
  }[tone];

  return (
    <div className="panel p-4">
      <div className="label">{label}</div>
      <div className={`stat-value mt-1 ${toneClass}`}>{value}</div>
      {hint ? <div className="mt-1 text-xs text-[var(--color-ink-dim)]">{hint}</div> : null}
    </div>
  );
}

export function Empty({ title, detail }: { title: string; detail?: string }) {
  return (
    <div className="panel p-10 text-center">
      <p className="text-[var(--color-ink-dim)]">{title}</p>
      {detail ? <p className="mt-2 text-xs text-[var(--color-ink-dim)]/70">{detail}</p> : null}
    </div>
  );
}

/**
 * Shown when a page's data source is unreachable.
 *
 * Deliberately distinct from `Empty`: "there is nothing here" and "we could not
 * find out whether there is anything here" are different facts, and conflating
 * them makes an outage look like an empty galaxy.
 */
export function Unavailable({ what }: { what: string }) {
  return (
    <div className="panel border-[var(--color-warn)]/30 p-6">
      <p className="text-sm text-[var(--color-warn)]">{what} is unavailable right now.</p>
      <p className="mt-1 text-xs text-[var(--color-ink-dim)]">
        The API could not be reached. This is not the same as the galaxy being empty — try again in
        a moment.
      </p>
    </div>
  );
}

