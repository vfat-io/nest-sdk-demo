'use client';

import { useEffect, useRef } from 'react';
import { useWaitForTransactionReceipt } from 'wagmi';

/**
 * The outcome of one transaction, acted on exactly once.
 *
 * Two traps this exists to avoid:
 *
 * - `useWaitForTransactionReceipt`'s `isSuccess` means the receipt *query*
 *   resolved. A mined-and-reverted transaction resolves just as successfully
 *   as one that worked, so `isSuccess` alone labels a revert "Confirmed".
 *   Only `receipt.status === 'success'` means the chain accepted it.
 * - Reacting to it in the render body re-fires on every subsequent render.
 *   Scheduling a delayed refetch from there produced an unbounded chain of
 *   them. The handler here is an effect keyed by hash *and* status, guarded by
 *   a ref, so it runs once per outcome and never again.
 */
export function useTxOutcome(
  hash: `0x${string}` | undefined,
  onSuccess: () => void
) {
  const { data: receipt, isLoading: isConfirming } =
    useWaitForTransactionReceipt({ hash });
  const handled = useRef<string | undefined>(undefined);
  const status = receipt?.status;

  useEffect(() => {
    if (!hash || !status) return;
    const outcome = `${hash}:${status}`;
    if (handled.current === outcome) return;
    handled.current = outcome;
    if (status === 'success') onSuccess();
  }, [hash, status, onSuccess]);

  return {
    isConfirming,
    succeeded: status === 'success',
    reverted: status === 'reverted',
  };
}
