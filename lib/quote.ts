'use client';

import { useCallback, useRef, useState } from 'react';
import { ContractCallData } from '@vfat-io/sickle-sdk';

/**
 * Calldata together with the exact request that produced it.
 *
 * `request` is a snapshot, not a reference to live state. Read the amounts,
 * percentages and addresses you show the user — and the approval you check —
 * from here, never from the controls, so what is displayed and what is
 * submitted cannot drift apart.
 */
export interface BoundQuote<TRequest, TDetail = undefined> {
  request: TRequest;
  callData: ContractCallData;
  /**
   * Anything the builder resolved while quoting that the UI must show.
   *
   * It belongs here rather than in separate state because it describes *this*
   * calldata. The deposit's auto-exit trigger is the case that forced it: the
   * trigger is decided from the quote's own minted range, so recomputing it
   * for display could show one range while the calldata carried another.
   */
  detail: TDetail;
}

function stableKey(value: unknown): string {
  return JSON.stringify(value, (_k, v) => {
    if (typeof v === 'bigint') return `${v}n`;
    // Sort object keys so an identical request always serialises identically.
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>).sort(([a], [b]) =>
          a < b ? -1 : a > b ? 1 : 0
        )
      );
    }
    return v;
  });
}

/**
 * A quote that is only ever valid for the inputs it was built from.
 *
 * Two separate ways a quote could previously be submitted for something the
 * user was no longer looking at, both closed here:
 *
 * - Editing a control after quoting left the calldata in place. Quoting a 50%
 *   decrease, then typing 10, still submitted 50%. Now the request is keyed,
 *   and a quote whose key no longer matches the current controls is simply not
 *   returned — the submit button goes away and the user has to re-quote.
 * - An in-flight quote resolved after the user switched actions, so exit
 *   calldata could land behind a Harvest button. The response carries the key
 *   it was requested with, so it cannot match a changed request; the
 *   generation counter additionally stops a superseded request from clobbering
 *   the error and loading flags.
 *
 * On a page that only ever talks to mainnet, submitting a materially different
 * financial action than the one on screen is the worst thing it could do.
 */
export function useBoundQuote<TRequest, TDetail = undefined>(
  request: TRequest
) {
  // Deliberately not memoised. Only the serialised value is load-bearing —
  // `quote` is gated on a string comparison — so the object's identity never
  // matters, and a dep list over a mutable request is something neither the
  // React Compiler nor a reader can verify.
  const key = stableKey(request);

  const [held, setHeld] = useState<{
    key: string;
    quote: BoundQuote<TRequest, TDetail>;
  }>();
  const [error, setError] = useState<string>();
  const [isQuoting, setIsQuoting] = useState(false);
  const generation = useRef(0);

  // The quote, only if it still describes what the controls say right now.
  const quote = held?.key === key ? held.quote : undefined;
  const stale = held !== undefined && held.key !== key;

  const build = async (
    fn: (
      request: TRequest
    ) => Promise<{ callData: ContractCallData; detail: TDetail }>
  ) => {
    const mine = ++generation.current;
    const requested = request;
    const requestedKey = key;

    setIsQuoting(true);
    setError(undefined);
    setHeld(undefined);

    try {
      const { callData, detail } = await fn(requested);
      if (mine !== generation.current) return;
      setHeld({
        key: requestedKey,
        quote: { request: requested, callData, detail },
      });
    } catch (e) {
      if (mine !== generation.current) return;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (mine === generation.current) setIsQuoting(false);
    }
  };

  /** Retires the quote — after it is spent, or when it should not be used. */
  const discard = useCallback(() => {
    generation.current++;
    setHeld(undefined);
    setError(undefined);
    setIsQuoting(false);
  }, []);

  return { quote, stale, error, isQuoting, build, discard };
}
