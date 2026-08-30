/**
 * Typed client for the API.
 *
 * These tools run with no server of their own. The only thing they ever asked a
 * backend for was somewhere to keep saved designs, so that one path is answered
 * from the browser instead -- see `designs.ts`. Everything else the tools need
 * is either static data compiled into `@precu/shared` or a model file fetched
 * from the asset tree.
 *
 * The interception lives here rather than in the pages so the tools read the
 * same in this repo as they do in the full stack, where these requests really
 * do go to an API over same-origin `/api/*`.
 */

import { handleDesignRequest, isDesignPath } from './designs';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  // Saved designs are kept in this browser. Nothing here is sent anywhere.
  if (isDesignPath(path)) return handleDesignRequest<T>(path, init);

  const response = await fetch(path.startsWith('/') ? path : `/api/${path}`, {
    credentials: 'include',
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    ...init,
  });

  const text = await response.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }

  if (!response.ok) {
    const message =
      typeof body === 'object' && body && 'error' in body
        ? String((body as { error: unknown }).error)
        : `request failed (${response.status})`;
    throw new ApiError(response.status, message, body);
  }

  return body as T;
}

/**
 * Server-side fetch for React Server Components.
 *
 * Rewrites do not apply on the server, so this talks to the API directly and
 * never caches: every page here shows live galaxy state.
 */
export async function serverApi<T>(): Promise<T | null> {
  // There is no server to ask. Kept so pages written against the full stack
  // still compile here, and so the degraded branch they already handle is the
  // one that runs.
  return null;
}

export function qs(params: Record<string, string | number | boolean | undefined | null>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}
