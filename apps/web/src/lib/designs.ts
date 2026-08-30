/**
 * Saved designs, kept in this browser.
 *
 * The city planner and the ship builder are the only things here that ever
 * wanted a server, and only to store a plan. Rather than require one, the
 * requests they make are answered from `localStorage`, which keeps this repo
 * runnable with nothing behind it.
 *
 * The shapes below are the API's, not a simplification of it: the same pages
 * run unmodified against the full stack, so anything returned here has to look
 * like what that returns.
 *
 * The consequence is worth stating plainly, because it is not what a "Save"
 * button usually means: a design lives in one browser on one machine. Clearing
 * site data loses it. Nothing is shared, and nothing is sent anywhere. Both
 * tools also have Export JSON, which is the way to move a design.
 */

const STORE_PREFIX = 'swg-web-tools:designs:';

export interface DesignRow {
  id: string;
  name: string;
  description: string;
  updatedAt: string;
  isPublic: boolean;
}

interface StoredDesign extends DesignRow {
  payload: unknown;
}

/** `/api/designs/<kind>` and `/api/designs/<kind>/<id>`. */
const DESIGN_PATH = /^\/api\/designs\/([a-z_]+)(?:\/([^/?]+))?$/;

export function isDesignPath(path: string): boolean {
  return DESIGN_PATH.test(path);
}

function read(kind: string): StoredDesign[] {
  // Storage throws rather than returning null in a few real cases -- Safari in
  // private mode, and any browser set to block site data -- so a failure to
  // read has to look like "nothing saved yet", not a crash on page load.
  try {
    const raw = window.localStorage.getItem(STORE_PREFIX + kind);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? (parsed as StoredDesign[]) : [];
  } catch {
    return [];
  }
}

function write(kind: string, rows: StoredDesign[]): void {
  try {
    window.localStorage.setItem(STORE_PREFIX + kind, JSON.stringify(rows));
  } catch {
    // Out of quota, or storage blocked. The design stays in memory for this
    // session; Export JSON is what makes it durable.
  }
}

/** The row without its payload, which is what listings show. */
function summarise({ id, name, description, updatedAt, isPublic }: StoredDesign): DesignRow {
  return { id, name, description, updatedAt, isPublic };
}

export function handleDesignRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const match = DESIGN_PATH.exec(path);
  if (!match) throw new Error(`not a design path: ${path}`);
  const [, kind, id] = match;
  const method = (init?.method ?? 'GET').toUpperCase();
  const rows = read(kind);

  if (method === 'GET') {
    if (!id) return Promise.resolve({ items: rows.map(summarise) } as T);
    const found = rows.find((row) => row.id === id);
    if (!found) return Promise.reject(new Error('design not found'));
    return Promise.resolve({ payload: found.payload } as T);
  }

  if (method === 'POST' || method === 'PUT') {
    const body = init?.body ? (JSON.parse(String(init.body)) as Partial<StoredDesign>) : {};
    const now = new Date().toISOString();
    const row: StoredDesign = {
      // Date alone is not unique enough: two saves inside the same millisecond
      // would collide, and then the second would overwrite the first on load.
      id: id ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      name: String(body.name ?? 'Untitled'),
      description: String(body.description ?? ''),
      updatedAt: now,
      isPublic: false,
      payload: body.payload ?? null,
    };
    const next = rows.filter((existing) => existing.id !== row.id);
    next.unshift(row);
    write(kind, next);
    return Promise.resolve(summarise(row) as T);
  }

  if (method === 'DELETE' && id) {
    write(kind, rows.filter((row) => row.id !== id));
    return Promise.resolve({ ok: true } as T);
  }

  return Promise.reject(new Error(`unsupported design request: ${method} ${path}`));
}
