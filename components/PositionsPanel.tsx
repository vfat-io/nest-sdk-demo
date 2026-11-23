'use client';

import { useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAccount } from 'wagmi';
import { FarmInfo } from '@vfat-io/sickle-sdk';
import {
  farmPair,
  fetchNestPositions,
  positionKey,
  positionValueUsd,
} from '@/lib/nest';
import { ELYSIUM_CHAIN_ID, NestChainId } from '@/lib/chains';
import { formatUsd } from '@/lib/format';
import { indexDeadline, pollWhileIndexing } from '@/lib/indexing';
import ManagePanel from './ManagePanel';
import AutomationPanel from './AutomationPanel';

/** Shared so a deposit elsewhere can invalidate this list. */
export const POSITIONS_QUERY_KEY = 'nest-positions';

interface Props {
  chainId: NestChainId;
  farms: FarmInfo[];
  showExitConsent: boolean;
  /**
   * Deadline until which a deposit's new position is still expected.
   *
   * This panel does not see the deposit — another component owns it — so
   * without being told, a single invalidation would read the pre-deposit list,
   * cache it, and stop.
   */
  expectChangeUntil?: number;
}

export default function PositionsPanel({
  chainId,
  farms,
  expectChangeUntil = 0,
  showExitConsent,
}: Props) {
  const { address } = useAccount();
  const [selectedId, setSelectedId] = useState<string>();

  // Until when a write is still expected to show up. Written from an event.
  const awaitUntil = useRef(0);
  const [, forcePoll] = useState(0);

  const {
    data: positions,
    error,
    isPending,
    refetch,
  } = useQuery({
    queryKey: [POSITIONS_QUERY_KEY, chainId, address],
    queryFn: () => fetchNestPositions(address!, chainId, farms),
    enabled: Boolean(address),
    // A deposit opens a window here too, and this panel never sees it, so
    // take whichever is later.
    refetchInterval: () =>
      pollWhileIndexing(Math.max(awaitUntil.current, expectChangeUntil)),
  });

  if (!address) return null;

  // Derived rather than stored, so a position disappearing — a rebalance mints
  // a new id, an exit removes it — cannot leave a dangling selection.
  const selected =
    positions?.find(position => positionKey(position) === selectedId) ?? positions?.[0];
  const hasAutoExit = positions?.some(entry => entry.position.nftSettings?.autoExit);
  const canManage = selected && (chainId !== ELYSIUM_CHAIN_ID || selected.position.sickleAddress);

  /**
   * Refetches after a write, until the write is visible.
   *
   * The data API indexes a few seconds behind the chain, so reading straight
   * after a transaction returns the pre-transaction state. This used to sleep
   * 12 seconds and read once, which is a guess in both directions: too slow
   * when the indexer is quick, and it caches the stale answer when it is not.
   */
  function refreshAfterWrite() {
    awaitUntil.current = indexDeadline();
    forcePoll(n => n + 1);
    void refetch();
  }

  return (
    <>
      <section className="flex flex-col gap-4 rounded border border-zinc-200 p-4 dark:border-zinc-800">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500">
            Your positions {positions && `(${positions.length})`}
          </h2>
          <button
            onClick={() => void refetch()}
            className="text-xs text-zinc-500 underline-offset-2 hover:underline"
          >
            Refresh
          </button>
        </div>

        {error && (
          <p className="rounded bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
            {error instanceof Error ? error.message : String(error)}
          </p>
        )}

        {isPending && <p className="text-sm text-zinc-500">Loading positions…</p>}

        {positions?.length === 0 && (
          <p className="text-sm text-zinc-500">
            No Nest positions yet. Open one below.
          </p>
        )}

        {positions && positions.length > 0 && (
          <div className="flex flex-col divide-y divide-zinc-200 rounded border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
            {positions.map(entry => {
              const id = positionKey(entry);
              const isSelected = selected !== undefined && id === positionKey(selected);
              const nft = entry.position.nft;
              return (
                <button
                  key={id}
                  aria-pressed={isSelected}
                  onClick={() => setSelectedId(id)}
                  className={`flex items-center justify-between gap-4 px-3 py-2 text-left text-sm ${
                    isSelected
                      ? 'bg-zinc-100 dark:bg-zinc-900'
                      : 'hover:bg-zinc-50 dark:hover:bg-zinc-950'
                  }`}
                >
                  <div className="flex min-w-0 flex-col">
                    <span className="font-medium">{farmPair(entry.farm)}</span>
                    <span className="font-mono text-xs text-zinc-500">
                      #{entry.nftId.toString()} · ticks {nft?.tickLower}…{nft?.tickUpper}
                    </span>
                  </div>
                  <span className="shrink-0 font-medium">
                    {formatUsd(positionValueUsd(entry.position))}
                  </span>
                </button>
              );
            })}
          </div>
        )}

        {selected && canManage && (
          <ManagePanel
            key={positionKey(selected)}
            chainId={chainId}
            entry={selected}
            onChanged={refreshAfterWrite}
          />
        )}
        {selected && !canManage && (
          <p className="text-sm text-zinc-500">
            This NFT is in your wallet. The management actions in this demo use a Sickle position.
          </p>
        )}
      </section>
      {(showExitConsent || hasAutoExit) && (
        <AutomationPanel chainId={chainId} expectDeployedUntil={expectChangeUntil} />
      )}
    </>
  );
}
