/**
 * Bazaar / vendor domain rules.
 *
 * `market_auctions` is written by CommoditiesServer, whose timers are plain
 * `time(0)` unix seconds — unlike `resource_types.depleted_timestamp`, which is
 * game-clock seconds. Do not run auction timers through the game clock.
 */
import { getGameObjectType, gameObjectTypeLabel } from './game-object-types.js';

/** Flag bits from serverNetworkMessages/gameCommoditiesServer/AuctionBase.h. */
export const AUCTION_FLAGS = {
  ALWAYS_PRESENT: 1 << 5,
  PREMIUM_AUCTION: 1 << 10,
  ACTIVE: 1 << 11,
  VENDOR_TRANSFER: 1 << 12,
  MAGIC_ITEM: 1 << 13,
  OFFERED_ITEM: 1 << 14,
} as const;

/** `auction_locations.status` values, from the ARC_VendorStatus* block. */
export const VENDOR_STATUS = {
  EMPTY: 0,
  NOT_EMPTY: 1,
  UNACCESSED: 2,
  ENDANGERED: 3,
  REMOVED: 4,
} as const;

export const VENDOR_STATUS_LABELS: Readonly<Record<number, string>> = {
  0: 'Empty',
  1: 'Stocked',
  2: 'Unaccessed',
  3: 'Endangered',
  4: 'Removed',
};

export type ListingKind = 'auction' | 'instant' | 'vendor' | 'stockroom';

export interface AuctionTiming {
  /** Unix seconds when the sale closes. */
  readonly endsAt: number;
  /** Unix seconds when an unsold item is destroyed or returned. */
  readonly expiresAt: number;
  readonly secondsRemaining: number;
  readonly ended: boolean;
}

export function auctionTiming(
  auctionTimer: number,
  itemTimer: number,
  now = Math.floor(Date.now() / 1000),
): AuctionTiming {
  return {
    endsAt: auctionTimer,
    expiresAt: itemTimer,
    secondsRemaining: Math.max(0, auctionTimer - now),
    ended: auctionTimer <= now,
  };
}

/**
 * Classify a listing the way the bazaar UI does.
 *
 * A zero `min_bid` with a `buy_now_price` is an instant sale; a listing on a
 * player-owned location is a vendor listing regardless of price shape; anything
 * whose timer has run out and is still on the books is stockroom stock.
 */
export function classifyListing(row: {
  minBid: number;
  buyNowPrice: number;
  ended: boolean;
  isVendorLocation: boolean;
}): ListingKind {
  if (row.ended) return 'stockroom';
  if (row.isVendorLocation) return 'vendor';
  if (row.minBid <= 0 && row.buyNowPrice > 0) return 'instant';
  return 'auction';
}

/**
 * The effective asking price: buy-now if the seller set one, otherwise the
 * opening bid. This is what sorting and price history should use — comparing a
 * 1-credit opening bid against a 50k buy-now is meaningless.
 */
export function askingPrice(minBid: number, buyNowPrice: number): number {
  return buyNowPrice > 0 ? buyNowPrice : minBid;
}

export function listingCategoryLabel(category: number): string {
  return gameObjectTypeLabel(category);
}

export function isResourceListing(category: number): boolean {
  return getGameObjectType(category)?.id.startsWith('misc_resource') ?? false;
}

/**
 * Parse `market_auctions.oob` — the out-of-band item attribute blob the client
 * renders in the examine window.
 *
 * The commodities server packs each attribute as a tab-separated
 * `name\tvalue` pair joined by newlines. Names are string-table ids, so they
 * arrive as `@obj_attr_n:armor_effectiveness` and are cleaned up here.
 */
export function parseOob(oob: string | null | undefined): { name: string; value: string }[] {
  if (!oob) return [];
  const out: { name: string; value: string }[] = [];
  for (const line of oob.split(/[\r\n]+/)) {
    if (!line.trim()) continue;
    const tab = line.indexOf('\t');
    if (tab === -1) continue;
    out.push({
      name: cleanStringId(line.slice(0, tab)),
      value: cleanStringId(line.slice(tab + 1)),
    });
  }
  return out;
}

/** Turn `@obj_attr_n:armor_effectiveness` into `Armor Effectiveness`. */
export function cleanStringId(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith('@')) return trimmed;
  const colon = trimmed.lastIndexOf(':');
  const key = colon === -1 ? trimmed.slice(1) : trimmed.slice(colon + 1);
  return key
    .split('_')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}
