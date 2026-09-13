import { Address, FarmInfo, MainAPI, TokenBalance } from '@vfat-io/sickle-sdk';

/** Nest runs on HyperEVM, and only on HyperEVM. */
export const NEST_CHAIN_ID = 999;
export const NEST_PROTOCOL_ID = 'nest';

/**
 * Every Nest farm, killed ones included, deepest liquidity first.
 *
 * Killed farms stay in: a holder of a position in a killed farm still has to
 * see it and get out of it. Filtering them here removed the farm from the map
 * that `fetchNestPositions` matches against, so the position vanished from the
 * page along with every action that could close it. Use `depositableFarms`
 * for the deposit picker, which is the only place killed should be excluded.
 *
 * `/v4/farms` is several MB unfiltered, so always pass the chain.
 */
export async function fetchNestFarms(): Promise<FarmInfo[]> {
  const farms = await MainAPI.fetchFarms(NEST_CHAIN_ID);
  return farms
    .filter(farm => farm.protocol.id === NEST_PROTOCOL_ID)
    .sort((a, b) => (b.snapshot?.stakedLiquidity ?? 0) - (a.snapshot?.stakedLiquidity ?? 0));
}

/** The farms a new position can be opened in. */
export function depositableFarms(farms: FarmInfo[]): FarmInfo[] {
  return farms.filter(farm => !farm.isKilled);
}

/** The two tokens a position is made of. */
export function farmTokens(farm: FarmInfo) {
  return farm.pool.underlying ?? [];
}

/** "WHYPE / USDC" */
export function farmPair(farm: FarmInfo): string {
  const symbols = farmTokens(farm).map(t => t.symbol ?? '?');
  return symbols.length > 0 ? symbols.join(' / ') : farm.pool.symbol ?? 'pool';
}

/** A position, paired with the farm it belongs to. */
export interface NestPosition {
  position: TokenBalance;
  farm: FarmInfo;
  nftId: bigint;
}

/**
 * The caller's open Nest positions.
 *
 * Note for anything reading this straight after a transaction: the data API
 * indexes a few seconds behind the chain, so a position read immediately after
 * a write comes back in its pre-write state.
 */
export async function fetchNestPositions(
  address: Address,
  farms: FarmInfo[]
): Promise<NestPosition[]> {
  const balances = await MainAPI.fetchUserPositions(address);
  const byAddress = new Map(farms.map(f => [f.address.toLowerCase(), f]));

  return balances.flatMap(position => {
    if (position.chainId !== NEST_CHAIN_ID || !position.nft) return [];
    const farm = byAddress.get((position.farmAddress ?? '').toLowerCase());
    if (!farm) return [];
    return [{ position, farm, nftId: position.nft.nftId }];
  });
}

/** What a position is currently worth, from the API's own prices. */
export function positionValueUsd(position: TokenBalance): number | undefined {
  const underlying = position.underlying ?? [];
  if (underlying.length === 0) return undefined;
  if (underlying.some(token => token.price === undefined)) return undefined;
  return underlying.reduce(
    (sum, token) =>
      sum +
      (Number(token.balance ?? 0n) / 10 ** (token.decimals ?? 18)) *
        (token.price ?? 0),
    0
  );
}
