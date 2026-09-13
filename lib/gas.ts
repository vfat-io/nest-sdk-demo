import { ContractCallData } from '@vfat-io/sickle-sdk';

/**
 * How much room to leave above the quote's gas estimate.
 *
 * The estimate is a simulation against the chain at quote time. By the time
 * the transaction is mined the state has moved, and some of that movement
 * costs gas the simulation never saw: a storage slot that was warm in the
 * simulation is cold in the real transaction (20k rather than 2.9k), a tick
 * crossing adds a word, a new NFT id writes into a fresh registry slot.
 *
 * So the estimate is a lower bound, not a limit. Sending it verbatim reverted
 * a deposit here at 950,395 gas with `ReentrancySentryOOG` — the inner call
 * gets 63/64 of what is left under EIP-150, so an outer frame that is merely
 * tight makes the innermost storage write fail rather than the outermost one.
 * The transaction still costs only what it uses; unused limit is not charged.
 */
const HEADROOM_NUMERATOR = 12n;
const HEADROOM_DENOMINATOR = 10n;

/**
 * The `gas` field to pass to `writeContract`, or nothing.
 *
 * Returning an empty object when the quote gave no estimate lets the wallet
 * estimate for itself, which is the right fallback — better than a number we
 * invented.
 */
export function gasWithHeadroom(
  callData: Pick<ContractCallData, 'gas'>
): { gas: bigint } | Record<string, never> {
  if (callData.gas === undefined) return {};
  return {
    gas: (callData.gas * HEADROOM_NUMERATOR) / HEADROOM_DENOMINATOR,
  };
}
