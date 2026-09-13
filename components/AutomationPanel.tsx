'use client';

import { useCallback, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAccount, useWriteContract } from 'wagmi';
import { Automation, Chains, MainAPI } from '@vfat-io/sickle-sdk';
import { NEST_CHAIN_ID } from '@/lib/nest';
import { shortAddress, shortWriteError } from '@/lib/format';
import { useTxOutcome } from '@/lib/receipt';
import { indexDeadline, pollWhileIndexing } from '@/lib/indexing';

/** Shared so a deposit can invalidate this panel when it deploys the Sickle. */
export const AUTOMATION_QUERY_KEY = 'nest-automation';

interface Props {
  /**
   * Deadline until which a deposit's Sickle deployment is still expected.
   *
   * Set by the deposit, because this panel cannot see that one happened, and
   * the Sickle it deployed will not be in the API's answer for a few seconds.
   */
  expectDeployedUntil?: number;
}

/**
 * Auto-exit does not fire until the Sickle owner consents.
 *
 * On chains whose `sickle.automationRequiresConsent` is true the keeper reverts
 * `ActionNotConsented`, silently as far as the user is concerned. HyperEVM is
 * one of them.
 */
export default function AutomationPanel({ expectDeployedUntil = 0 }: Props) {
  const { address, chainId } = useAccount();
  const wrongChain = chainId !== NEST_CHAIN_ID;

  // Set when a consent confirms, so the poll below knows what it is waiting
  // for. A ref because it is written from an event, never from render.
  const consentDeadline = useRef(0);
  const [, forcePoll] = useState(0);

  const { data, error, refetch } = useQuery({
    queryKey: [AUTOMATION_QUERY_KEY, address],
    enabled: Boolean(address),
    refetchInterval: query => {
      const entry = query.state.data?.entry;
      const deployed = Boolean(entry?.sickleAddress);
      const consented = entry?.automation?.consented?.nftExit === true;

      const waitingForSickle = pollWhileIndexing(expectDeployedUntil, deployed);
      if (waitingForSickle !== false) return waitingForSickle;
      return pollWhileIndexing(consentDeadline.current, consented);
    },
    queryFn: async () => {
      const [sickles, requiresConsent, strategy] = await Promise.all([
        MainAPI.fetchUserSickles(address!),
        Chains.automationRequiresConsent(NEST_CHAIN_ID),
        Chains.fetchAutomationStrategyAddress(NEST_CHAIN_ID),
      ]);
      return {
        entry: sickles[String(NEST_CHAIN_ID)],
        requiresConsent,
        strategy,
      };
    },
  });

  const {
    writeContract,
    data: txHash,
    isPending,
    error: writeError,
    reset,
  } = useWriteContract();

  // A granted consent only shows as granted once this is re-read; the write
  // alone leaves the panel claiming it is still unconsented.
  const onConfirmed = useCallback(() => {
    reset();
    // Keep asking until the granted consent actually shows up. One refetch
    // here would usually read the pre-consent mask and cache it.
    consentDeadline.current = indexDeadline();
    forcePoll(n => n + 1);
    void refetch();
  }, [reset, refetch]);

  const { isConfirming, reverted } = useTxOutcome(txHash, onConfirmed);

  if (!address || !data) return null;

  const { entry, requiresConsent, strategy } = data;
  if (!entry) return null;

  const sickleAddress = entry.sickleAddress;
  const consentMask = entry.automation?.consentMask;
  const consented = entry.automation?.consented?.nftExit === true;
  const busy = isPending || isConfirming;

  function grantExitConsent() {
    if (!strategy || !sickleAddress) return;
    // setActionConsent overwrites the mask, so the current one is OR-ed in
    // rather than replaced — otherwise this would revoke everything else.
    const call = Automation.buildSetActionConsent({
      chainId: NEST_CHAIN_ID,
      automationStrategyAddress: strategy,
      sickleAddress,
      permissions: ['nftExit'],
      currentConsentMask: consentMask,
    });
    writeContract({
      chainId: NEST_CHAIN_ID,
      abi: call.abi,
      address: call.address,
      functionName: call.functionName,
      args: call.args,
      value: call.value,
    });
  }

  return (
    <section className="flex flex-col gap-3 rounded border border-zinc-200 p-4 text-sm dark:border-zinc-800">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500">
          Automation
        </h2>
        <button
          onClick={() => void refetch()}
          className="text-xs text-zinc-500 underline-offset-2 hover:underline"
        >
          Refresh
        </button>
      </div>

      {error && (
        <p className="text-red-600 dark:text-red-400">
          {error instanceof Error ? error.message : String(error)}
        </p>
      )}

      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 font-mono text-xs">
        <dt className="text-zinc-500">sickle</dt>
        <dd>
          {sickleAddress
            ? shortAddress(sickleAddress)
            : `not deployed (would be ${shortAddress(entry.predictedSickleAddress)})`}
        </dd>
        <dt className="text-zinc-500">consent required</dt>
        <dd>{requiresConsent ? 'yes' : 'no'}</dd>
        <dt className="text-zinc-500">mask</dt>
        <dd>{consentMask ?? '0'}</dd>
      </dl>

      {requiresConsent && !consented && (
        <div className="flex flex-col gap-2">
          <p className="text-zinc-600 dark:text-zinc-400">
            Auto-exit will not fire until you consent to it. Without this the
            keeper reverts and nothing tells you.
          </p>
          <button
            onClick={grantExitConsent}
            disabled={!sickleAddress || !strategy || busy || wrongChain}
            className="self-start rounded border border-zinc-900 px-4 py-2 font-medium disabled:opacity-40 dark:border-zinc-100"
          >
            {isPending
              ? 'Confirm in wallet…'
              : isConfirming
                ? 'Consenting…'
                : 'Consent to auto-exit'}
          </button>
          {!sickleAddress && (
            <p className="text-xs text-zinc-500">
              Deposit first — consent is granted on a deployed Sickle. This
              panel refreshes itself once the deposit deploys one.
            </p>
          )}
          {writeError && (
            <p className="text-xs text-red-600 dark:text-red-400">
              The wallet rejected it: {shortWriteError(writeError)}
            </p>
          )}
          {reverted && (
            <p className="text-xs text-red-600 dark:text-red-400">
              That consent transaction reverted on-chain.
            </p>
          )}
        </div>
      )}

      {consented && (
        <p className="text-emerald-700 dark:text-emerald-400">
          Auto-exit is consented.
        </p>
      )}
    </section>
  );
}
