'use client';

import { useCallback, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAccount, usePublicClient, useWriteContract } from 'wagmi';
import { Automation, AutomationPermissionName, Chains, MainAPI } from '@vfat-io/sickle-sdk';
import { isAddressEqual, zeroAddress } from 'viem';
import { ELYSIUM_CHAIN_ID, NestChainId, nestChains } from '@/lib/chains';
import { elysiumSettingsAbi, permissionLabel, permissionsForSettings, sickleApprovalAbi } from '@/lib/automation';
import { shortAddress, shortWriteError } from '@/lib/format';
import { pollWhileIndexing } from '@/lib/indexing';
import type { NestPosition } from '@/lib/nest';
import { useTxOutcome } from '@/lib/receipt';

export const AUTOMATION_QUERY_KEY = 'nest-automation';

interface Props {
  chainId: NestChainId;
  permissions: AutomationPermissionName[];
  position?: NestPosition;
  expectDeployedUntil: number;
}

export default function AutomationPanel({ chainId, permissions, position, expectDeployedUntil }: Props) {
  const { address, chainId: walletChainId } = useAccount();
  const client = usePublicClient({ chainId });
  const { writeContract, data: txHash, isPending, error: writeError, reset } = useWriteContract();
  const [isPreparing, setIsPreparing] = useState(false);
  const [prepareError, setPrepareError] = useState<string>();

  const selectedSickle = chainId === ELYSIUM_CHAIN_ID ? position?.position.sickleAddress : undefined;
  const nftManager = position?.position.nft?.managerAddress ?? position?.farm.nftManagerAddress;
  const isRelevant = permissions.length > 0 || Boolean(selectedSickle);
  const wallet = useQuery({
    queryKey: [AUTOMATION_QUERY_KEY, chainId, address],
    enabled: Boolean(address && isRelevant),
    queryFn: async () => {
      const [sickles, chain] = await Promise.all([MainAPI.fetchUserSickles(address!), Chains.fetchNetwork(chainId)]);
      return { entry: sickles[String(chainId)], contracts: chain.sickle };
    },
    refetchInterval: query => pollWhileIndexing(expectDeployedUntil, Boolean(query.state.data?.entry?.sickleAddress)),
  });
  const entry = wallet.data?.entry;
  const contracts = wallet.data?.contracts;
  const sickleAddress = entry?.sickleAddress;
  const strategy = contracts?.v5?.automationStrategy;
  const registry = contracts?.v5?.nftSettingsRegistry;
  const requiresConsent = contracts?.automationRequiresConsent === true;

  // The v4 balance response can omit settings. For held Elysium NFTs, read the
  // published registry with the exact Sickle, manager and token ID.
  const saved = useQuery({
    queryKey: ['nest-nft-settings', chainId, registry, selectedSickle, nftManager, position?.nftId.toString()],
    enabled: Boolean(client && registry && selectedSickle && nftManager && position),
    queryFn: () => client!.readContract({
      address: registry!,
      abi: elysiumSettingsAbi,
      functionName: 'getNftSettings',
      args: [{ sickle: selectedSickle!, nftManager: nftManager!, tokenId: position!.nftId }],
    }),
  });
  const configured = saved.data && saved.data.poolId.toLowerCase() === position?.farm.pool.poolId?.toLowerCase() &&
    isAddressEqual(saved.data.pool, position.farm.pool.address) ? permissionsForSettings(saved.data) : [];
  const requested = [...new Set([...permissions, ...configured])];
  const keeper = useQuery({
    queryKey: ['nest-keeper', chainId, sickleAddress, strategy],
    enabled: Boolean(client && sickleAddress && strategy && requested.length > 0),
    queryFn: async () => {
      const [approved, mask] = await Promise.all([
        client!.readContract({ abi: sickleApprovalAbi, address: sickleAddress!, functionName: 'approved' }),
        requiresConsent
          ? client!.readContract(Automation.getActionConsentCallData(sickleAddress!, strategy!))
          : undefined,
      ]);
      return { approved, mask };
    },
  });
  const { refetch: refreshKeeper } = keeper;
  const onConfirmed = useCallback(() => {
    reset();
    void refreshKeeper();
  }, [refreshKeeper, reset]);
  const { isConfirming, reverted } = useTxOutcome(txHash, chainId, onConfirmed);

  if (!isRelevant) return null;

  const active = Boolean(keeper.data && strategy && isAddressEqual(keeper.data.approved, strategy));
  const mask = keeper.data?.mask;
  const missing = requiresConsent && mask !== undefined
    ? requested.filter(permission => (mask & Automation.AutomationPermissionBit[permission]) === 0n)
    : [];
  const busy = isPending || isConfirming || isPreparing;
  const mayWrite = Boolean(address && walletChainId === chainId && strategy && sickleAddress && !busy);
  const error = wallet.error ?? saved.error ?? keeper.error;

  function enableKeeper() {
    if (!mayWrite || !strategy || !sickleAddress) return;
    setPrepareError(undefined);
    writeContract({
      account: address,
      chainId,
      address: sickleAddress,
      abi: sickleApprovalAbi,
      functionName: 'setApproved',
      args: [strategy],
    });
  }

  async function grantConsent() {
    if (!mayWrite || !active || !client || !strategy || !sickleAddress) return;
    setIsPreparing(true);
    setPrepareError(undefined);
    try {
      // Each write replaces the whole mask. Refresh immediately before signing
      // so grants made elsewhere are preserved, including unrecognized bits.
      const currentConsentMask = await client.readContract(
        Automation.getActionConsentCallData(sickleAddress, strategy),
      );
      const ungranted = missing.filter(permission =>
        (currentConsentMask & Automation.AutomationPermissionBit[permission]) === 0n,
      );
      if (ungranted.length === 0) {
        void refreshKeeper();
        return;
      }
      const call = Automation.buildSetActionConsent({
        chainId,
        automationStrategyAddress: strategy,
        sickleAddress,
        permissions: ungranted,
        currentConsentMask,
      });
      writeContract({
        account: address, chainId, abi: call.abi, address: call.address,
        functionName: call.functionName, args: call.args, value: call.value,
      });
    } catch (error) {
      setPrepareError(shortWriteError(error));
    } finally {
      setIsPreparing(false);
    }
  }

  return (
    <section className="flex flex-col gap-3 rounded border border-zinc-200 p-4 text-sm dark:border-zinc-800">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500">Keeper setup</h2>
        <button
          type="button"
          onClick={() => {
            void wallet.refetch();
            if (registry && selectedSickle && nftManager) void saved.refetch();
            if (keeper.data) void refreshKeeper();
          }}
          className="text-xs text-zinc-500 underline-offset-2 hover:underline"
        >
          Refresh
        </button>
      </div>

      {error && <p role="alert" className="text-red-600 dark:text-red-400">{shortWriteError(error)}</p>}
      {requested.length === 0 && saved.isSuccess && !saved.isFetching && (
        <p className="text-zinc-500">This position has no saved keeper actions.</p>
      )}
      {requested.length > 0 && (
        <>
          <p className="text-zinc-600 dark:text-zinc-400">
            {requested.map(permissionLabel).join(', ')}
            {selectedSickle && configured.length > 0 && ` · NFT #${position?.nftId.toString()}`}
          </p>
          {sickleAddress ? (
            <p className="font-mono text-xs text-zinc-500">
              Sickle {shortAddress(sickleAddress)} · {keeper.data ? (active ? 'Keeper approved' : 'Keeper approval needed') : 'Reading approval'}
            </p>
          ) : (
            entry && <p className="text-zinc-500">Deposit to create your Sickle before granting consent.</p>
          )}
          {keeper.data && !active && (
            <>
              <p className="text-xs text-zinc-500">
                Approval applies to all configured positions in this Sickle on {nestChains[chainId].name}.
                {keeper.data.approved !== zeroAddress && ' This replaces its current approved address.'}
              </p>
              <button type="button" onClick={enableKeeper} disabled={!mayWrite} className={buttonStyle}>
                {busy ? 'Confirming…' : 'Approve keeper for this Sickle'}
              </button>
            </>
          )}
          {active && missing.length > 0 && (
            <button type="button" onClick={() => void grantConsent()} disabled={!mayWrite} className={buttonStyle}>
              {busy ? 'Confirming…' : `Consent to ${missing.map(permissionLabel).join(', ')}`}
            </button>
          )}
          {active && (!requiresConsent || (mask !== undefined && missing.length === 0)) && (
            <p className="text-emerald-700 dark:text-emerald-400">Keeper approval and action permissions are ready.</p>
          )}
          <p className="text-xs text-zinc-500">
            Runs still depend on position triggers and gas economics.{' '}
            <a href="https://vfat.io/docs/automation" className="underline underline-offset-2">
              Automation and funding
            </a>
          </p>
        </>
      )}
      {(writeError || prepareError || reverted) && (
        <p role="alert" className="text-red-600 dark:text-red-400">
          {prepareError ?? (writeError ? shortWriteError(writeError) : 'The keeper setup transaction reverted.')}
        </p>
      )}
    </section>
  );
}

const buttonStyle = 'self-start rounded border border-zinc-900 px-4 py-2 font-medium disabled:opacity-40 dark:border-zinc-100';
