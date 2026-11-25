import { ContractCallData } from '@vfat-io/sickle-sdk';

/**
 * Tick arithmetic for the auto-exit range.
 *
 * A Uniswap-style tick is a log-price: price = 1.0001^tick.
 */

/** Uniswap V3's absolute tick bounds. */
export const MIN_TICK = -887272;
export const MAX_TICK = 887272;

/** How many ticks a given percentage move is worth. */
export function ticksForPercent(percent: number): number {
  return Math.round(Math.log(1 + percent / 100) / Math.log(1.0001));
}

export interface TickRange {
  min: number;
  max: number;
}

/**
 * The tick range a deposit quote will actually mint.
 *
 * The API decides this, not the caller: the quote is priced against spot at
 * the moment the API answers, and the range it chose is in the calldata it
 * returned. Reading it from there is the only way to know the real range
 * before signing — anything derived from a pool tick this page cached is a
 * guess about a number the API has already decided.
 */
export function mintedRangeFromCallData(
  callData: ContractCallData
): TickRange | undefined {
  let found: TickRange | undefined;

  const walk = (value: unknown): void => {
    if (found || value === null || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }
    const record = value as Record<string, unknown>;
    const low = record.tickLower;
    const high = record.tickUpper;
    if (
      (typeof low === 'number' || typeof low === 'bigint') &&
      (typeof high === 'number' || typeof high === 'bigint')
    ) {
      const min = Number(low);
      const max = Number(high);
      if (Number.isInteger(min) && Number.isInteger(max) && min < max) {
        found = { min, max };
        return;
      }
    }
    Object.values(record).forEach(walk);
  };

  walk(callData.args);
  return found;
}

/**
 * An auto-exit trigger that provably encloses `minted`.
 *
 * The clearance defaults to one tick spacing on each side. Align the
 * triggers outward, then clamp them at the pool's usable tick limits.
 */
export function triggerEnclosing(
  minted: TickRange,
  tickSpacing: number,
  clearance = tickSpacing
): TickRange {
  if (!Number.isInteger(tickSpacing) || tickSpacing <= 0) {
    throw new Error(`Unusable tick spacing: ${tickSpacing}`);
  }

  const usableMin = Math.ceil(MIN_TICK / tickSpacing) * tickSpacing;
  const usableMax = Math.floor(MAX_TICK / tickSpacing) * tickSpacing;

  const min = Math.floor((minted.min - clearance) / tickSpacing) * tickSpacing;
  const max = Math.ceil((minted.max + clearance) / tickSpacing) * tickSpacing;

  return {
    min: Math.max(min, usableMin),
    max: Math.min(max, usableMax),
  };
}

/** Whether `trigger` is strictly outside `minted` at both ends. */
export function encloses(trigger: TickRange, minted: TickRange): boolean {
  return trigger.min < minted.min && trigger.max > minted.max;
}
