import { formatUnits } from 'viem';

export function formatUsd(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return '—';
  return value.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: value < 1 ? 4 : 2,
  });
}

/**
 * Formats a value the API already expresses in percent.
 *
 * `snapshot.apr` is 171.78 for 171.78%, not 1.7178 — multiplying by 100 turns a
 * plausible number into a 17,000% one.
 */
export function formatAprPercent(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return '—';
  if (value >= 1000) return `${Math.round(value).toLocaleString('en-US')}%`;
  return `${value.toFixed(2)}%`;
}

export function formatAmount(value: bigint, decimals: number): string {
  const n = Number(formatUnits(value, decimals));
  if (n === 0) return '0';
  if (n < 0.0001) return '<0.0001';
  return n.toLocaleString('en-US', { maximumFractionDigits: 6 });
}

export function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/** Turns the API's status strings into something a person can act on. */
export function explainGasStatus(status: string | undefined): string {
  switch (status) {
    case 'success':
      return 'Simulated successfully.';
    case undefined:
      return 'No simulation result.';
    case 'contract_call_failed':
      return 'Simulation failed — usually a missing approval or balance.';
    case 'action_not_consented':
      return 'The Sickle owner has not consented to this automated action yet.';
    case 'sickle_not_deployed':
      return 'No Sickle yet. The deposit deploys one as part of the transaction.';
    case 'high_price_impact':
      return 'Price impact above the limit you set.';
    case 'no_swap_route':
      return 'No swap route for this pair and size.';
    default:
      return `Simulation reported: ${status}`;
  }
}

/**
 * The useful line out of a wallet or simulation error.
 *
 * viem's `message` is several paragraphs with the whole request appended, so
 * it reads terribly in a panel. Its errors carry `shortMessage` (one sentence)
 * and `details` (what the wallet or node actually said); prefer those, and
 * fall back to the first line of the message.
 *
 * Swallowing these entirely is worse than any of it: a `writeContract` that
 * fails — a rejection in the wallet, a gas estimation that reverts on an
 * insufficient balance — then sends nothing and says nothing, which looks
 * exactly like the button being broken. That is how a real bug here hid.
 */
export function shortWriteError(error: unknown): string {
  if (typeof error !== 'object' || error === null) return String(error);
  const viem = error as { shortMessage?: unknown; details?: unknown };

  const details =
    typeof viem.details === 'string' && viem.details.trim()
      ? viem.details.trim()
      : undefined;
  const short =
    typeof viem.shortMessage === 'string' && viem.shortMessage.trim()
      ? viem.shortMessage.trim()
      : undefined;

  if (short && details && !short.includes(details)) return `${short} ${details}`;
  if (short) return short;
  if (details) return details;

  if (error instanceof Error) {
    const first = error.message.split('\n').find(line => line.trim());
    if (first) return first.trim();
  }
  return 'unknown error';
}
