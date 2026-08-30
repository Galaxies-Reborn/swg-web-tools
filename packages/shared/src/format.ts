/** Display formatting shared by the API's derived labels and the web UI. */

const creditFormatter = new Intl.NumberFormat('en-US');

export function formatCredits(amount: number): string {
  return `${creditFormatter.format(Math.round(amount))} cr`;
}

/** Compact credit display for dense tables: 1.2M, 45.3k, 900. */
export function formatCreditsShort(amount: number): string {
  const abs = Math.abs(amount);
  if (abs >= 1_000_000) return `${(amount / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1)}M`;
  if (abs >= 1_000) return `${(amount / 1_000).toFixed(abs >= 10_000 ? 0 : 1)}k`;
  return String(Math.round(amount));
}

/** `3d 4h`, `12h 30m`, `45m`, `20s` — never more than two units. */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0s';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (d > 0) return h > 0 ? `${d}d ${h}h` : `${d}d`;
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  if (m > 0) return s > 0 ? `${m}m ${s}s` : `${m}m`;
  return `${s}s`;
}

/** Played time as the character sheet shows it: `142d 6h`. */
export function formatPlayedTime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  return d > 0 ? `${d}d ${h}h` : `${h}h`;
}

export function formatRelative(iso: string | Date, now = new Date()): string {
  const then = typeof iso === 'string' ? new Date(iso) : iso;
  const delta = Math.round((then.getTime() - now.getTime()) / 1000);
  const abs = Math.abs(delta);
  if (abs < 45) return delta < 0 ? 'just now' : 'in a moment';
  const text = formatDuration(abs);
  return delta < 0 ? `${text} ago` : `in ${text}`;
}

/**
 * Turn a server object template path into a readable item name.
 * `object/weapon/ranged/pistol/pistol_cdef.iff` → `Pistol Cdef`.
 * Used only as a fallback when the object has no stored name.
 */
export function templateDisplayName(template: string): string {
  const file = template.split('/').pop() ?? template;
  return file
    .replace(/\.iff$/i, '')
    .replace(/^shared_/, '')
    .split('_')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}
