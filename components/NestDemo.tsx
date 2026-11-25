'use client';

import { useCallback, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAccount } from 'wagmi';
import { Address, AutomationPermissionName, Chains, FarmInfo } from '@vfat-io/sickle-sdk';
import { depositableFarms, farmKey, fetchNestFarms } from '@/lib/nest';
import { ELYSIUM_CHAIN_ID, HYPEREVM_CHAIN_ID, NestChainId, nestChains } from '@/lib/chains';
import { indexDeadline } from '@/lib/indexing';
import ConnectWallet from './ConnectWallet';
import FarmList from './FarmList';
import DepositPanel from './DepositPanel';
import PositionsPanel, { POSITIONS_QUERY_KEY } from './PositionsPanel';
import { AUTOMATION_QUERY_KEY } from './AutomationPanel';

const hyperEvmPermissions: AutomationPermissionName[] = ['nftExit'];

export default function NestDemo({ chainId }: { chainId: NestChainId }) {
  const { address, isConnected, chainId: walletChainId } = useAccount();
  const queryClient = useQueryClient();
  const [selectedFarmKey, setSelectedFarmKey] = useState<string>();
  const [lastDeposit, setLastDeposit] = useState<{
    owner: Address;
    permissions: AutomationPermissionName[];
    pollUntil: number;
  }>();

  const {
    data: farms,
    error,
    isPending,
  } = useQuery({ queryKey: ['nest-farms', chainId], queryFn: () => fetchNestFarms(chainId) });
  const { data: supportsDustDeposit } = useQuery({
    queryKey: ['nest-dust-deposit', chainId],
    queryFn: () => Chains.supportsNftSettingsAutoDeposit(chainId),
    enabled: chainId === ELYSIUM_CHAIN_ID,
  });

  // Killed farms stay in `farms` so existing positions can still be matched
  // and exited; only the picker excludes them.
  const openable = useMemo(
    () => (farms ? depositableFarms(farms) : []),
    [farms]
  );

  // Derived, so a farm leaving the list cannot leave a dangling selection.
  const selected: FarmInfo | undefined =
    openable.find(farm => farmKey(farm) === selectedFarmKey) ?? openable[0];

  /**
   * A deposit can deploy the Sickle and always changes the position list, and
   * neither panel can see that on its own.
   */
  const onDeposited = useCallback((permissions: AutomationPermissionName[]) => {
    if (!address) return;
    setLastDeposit({ owner: address, permissions, pollUntil: indexDeadline() });
    void queryClient.invalidateQueries({ queryKey: [AUTOMATION_QUERY_KEY, chainId, address] });
    void queryClient.invalidateQueries({ queryKey: [POSITIONS_QUERY_KEY, chainId, address] });
  }, [address, chainId, queryClient]);

  const onNestChain = isConnected && walletChainId === chainId;
  const deposit = lastDeposit?.owner === address ? lastDeposit : undefined;
  const permissions = chainId === HYPEREVM_CHAIN_ID ? hyperEvmPermissions : (deposit?.permissions ?? []);

  return (
    <div className="flex flex-col gap-6">
      <ConnectWallet targetChainId={chainId} />

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
          This wallet is on chain {walletChainId ?? 'unknown'}. Switch to {nestChains[chainId].name}{' '}
          ({chainId}) to quote or send a transaction.
        </p>
      )}

      {farms && onNestChain && (
        <PositionsPanel
          key={address}
          chainId={chainId}
          farms={farms}
          expectChangeUntil={deposit?.pollUntil}
          permissions={permissions}
        />
      )}

      {farms && (
        <section className="flex flex-col gap-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500">
            Open a position — Nest farms ({openable.length})
          </h2>
          <FarmList
            farms={openable}
            selected={selected}
            onSelect={farm => setSelectedFarmKey(farmKey(farm))}
          />
        </section>
      )}

      {selected && onNestChain && (
        // Keyed on the farm: the panel holds a token choice and an amount that
        // mean nothing once the pair changes.
        <DepositPanel
          key={`${farmKey(selected)}:${address}`}
          chainId={chainId}
          farm={selected}
          supportsDustDeposit={chainId === ELYSIUM_CHAIN_ID && supportsDustDeposit === true}
          onDeposited={onDeposited}
        />
      )}
      {selected && !isConnected && (
        <p className="text-sm text-zinc-500">
          Connect a wallet to quote and open a position.
        </p>
      )}

    </div>
  );
}
