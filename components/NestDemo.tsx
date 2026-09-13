'use client';

import { useCallback, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAccount } from 'wagmi';
import { FarmInfo } from '@vfat-io/sickle-sdk';
import { NEST_CHAIN_ID, depositableFarms, fetchNestFarms } from '@/lib/nest';
import { indexDeadline } from '@/lib/indexing';
import ConnectWallet from './ConnectWallet';
import FarmList from './FarmList';
import DepositPanel from './DepositPanel';
import PositionsPanel, { POSITIONS_QUERY_KEY } from './PositionsPanel';
import AutomationPanel, { AUTOMATION_QUERY_KEY } from './AutomationPanel';

export default function NestDemo() {
  const { isConnected, chainId } = useAccount();
  const queryClient = useQueryClient();
  const [selectedAddress, setSelectedAddress] = useState<string>();
  /**
   * Until when a just-deposited Sickle is still expected to appear.
   *
   * The automation panel cannot see that a deposit happened, and the Sickle it
   * deploys takes a few seconds to reach the API.
   */
  const [expectDeployedUntil, setExpectDeployedUntil] = useState(0);

  const {
    data: farms,
    error,
    isPending,
  } = useQuery({ queryKey: ['nest-farms'], queryFn: fetchNestFarms });

  // Killed farms stay in `farms` so existing positions can still be matched
  // and exited; only the picker excludes them.
  const openable = useMemo(
    () => (farms ? depositableFarms(farms) : []),
    [farms]
  );

  // Derived, so a farm leaving the list cannot leave a dangling selection.
  const selected: FarmInfo | undefined =
    openable.find(f => f.address === selectedAddress) ?? openable[0];

  /**
   * A deposit can deploy the Sickle and always changes the position list, and
   * neither panel can see that on its own.
   */
  const onDeposited = useCallback(() => {
    setExpectDeployedUntil(indexDeadline());
    void queryClient.invalidateQueries({ queryKey: [AUTOMATION_QUERY_KEY] });
    void queryClient.invalidateQueries({ queryKey: [POSITIONS_QUERY_KEY] });
  }, [queryClient]);

  // Every write is pinned to HyperEVM, but a wallet on another chain cannot
  // sign them, so showing the panels would only offer buttons that fail.
  const onNestChain = isConnected && chainId === NEST_CHAIN_ID;

  return (
    <div className="flex flex-col gap-6">
      <ConnectWallet />

      {error && (
        <p className="rounded bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
          Could not load farms:{' '}
          {error instanceof Error ? error.message : String(error)}
        </p>
      )}

      {isPending && !error && (
        <p className="text-sm text-zinc-500">Loading Nest farms…</p>
      )}

      {isConnected && !onNestChain && (
        <p className="rounded bg-amber-50 p-3 text-sm text-amber-800 dark:bg-amber-950 dark:text-amber-200">
          This wallet is on chain {chainId ?? 'unknown'}. Nest is on HyperEVM
          (999) — switch above before quoting or sending anything.
        </p>
      )}

      {farms && onNestChain && (
        <PositionsPanel farms={farms} expectChangeUntil={expectDeployedUntil} />
      )}

      {farms && (
        <section className="flex flex-col gap-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500">
            Open a position — Nest farms ({openable.length})
          </h2>
          <FarmList
            farms={openable}
            selected={selected}
            onSelect={farm => setSelectedAddress(farm.address)}
          />
        </section>
      )}

      {selected && onNestChain && (
        // Keyed on the farm: the panel holds a token choice and an amount that
        // mean nothing once the pair changes.
        <DepositPanel
          key={selected.address}
          farm={selected}
          onDeposited={onDeposited}
        />
      )}
      {selected && !isConnected && (
        <p className="text-sm text-zinc-500">
          Connect a wallet to quote and open a position.
        </p>
      )}

      {onNestChain && (
        <AutomationPanel expectDeployedUntil={expectDeployedUntil} />
      )}
    </div>
  );
}
