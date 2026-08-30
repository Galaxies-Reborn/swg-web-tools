/**
 * Game clock ↔ wall clock conversion.
 *
 * Some persisted timestamps are ServerClock game seconds, not unix time:
 * `resource_types.depleted_timestamp` is the big one. The `clock` table is the
 * only anchor — it stores the game time of the last save alongside the wall
 * clock date it happened at, so the offset between the two can be recovered.
 *
 * Getting this wrong makes every resource look like it despawns in 1970.
 */

export interface ClockAnchor {
  /** `clock.last_save_time` — game seconds at the last cluster save. */
  readonly lastSaveTime: number;
  /** `clock.last_save_timestamp` — wall clock instant of that save. */
  readonly lastSaveAt: Date;
}

export class GameClock {
  private readonly offsetSeconds: number;

  constructor(anchor: ClockAnchor) {
    this.offsetSeconds = Math.floor(anchor.lastSaveAt.getTime() / 1000) - anchor.lastSaveTime;
  }

  /** Game seconds → wall clock. */
  toDate(gameSeconds: number): Date {
    return new Date((gameSeconds + this.offsetSeconds) * 1000);
  }

  /** Wall clock → game seconds. */
  toGameTime(date: Date): number {
    return Math.floor(date.getTime() / 1000) - this.offsetSeconds;
  }

  now(): number {
    return this.toGameTime(new Date());
  }

  /** Seconds until a game-time deadline, floored at zero. */
  secondsUntil(gameSeconds: number): number {
    return Math.max(0, gameSeconds - this.now());
  }
}

/**
 * ServerClock's "never" sentinel. Recycled and permanent resources are given
 * this as their depleted timestamp, and they must not be rendered as expiring.
 */
export const END_OF_TIME = 0xffffffff;

export function isPermanent(gameSeconds: number): boolean {
  // Anything within a few years of the sentinel is the sentinel; the exact
  // constant has drifted between builds.
  return gameSeconds >= END_OF_TIME - 86400 * 365 * 5;
}
