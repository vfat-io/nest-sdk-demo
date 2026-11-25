'use client';

import { useCallback, useRef, useState } from 'react';
import { Address, erc20Abi, parseUnits } from 'viem';
import { useAccount, useReadContract, useWriteContract } from 'wagmi';
import {
  AutomationPermissionName,
  FarmInfo,
  NftPool,
  PlanApproval,
} from '@vfat-io/sickle-sdk';
import { farmKey, farmTokens } from '@/lib/nest';
import { ELYSIUM_CHAIN_ID, NestChainId, transactionUrl } from '@/lib/chains';
import { explainGasStatus, formatAmount, shortAddress } from '@/lib/format';
import { gasWithHeadroom } from '@/lib/gas';
import { shortWriteError } from '@/lib/format';
import { AutomationSelection, manualSelection, permissionLabel } from '@/lib/automation';
import { quoteDeposit } from '@/lib/depositQuote';
import { useBoundQuote } from '@/lib/quote';
import { useTxOutcome } from '@/lib/receipt';

interface Props {
  chainId: NestChainId;
  farm: FarmInfo;
  supportsDustDeposit: boolean;
  onDeposited?: (permissions: AutomationPermissionName[]) => void;
}

/** Returns 0n for anything that is not a positive number. */
function parseAmount(text: string, decimals: number): bigint {
  if (!text.trim()) return 0n;
  try {
    const parsed = parseUnits(text.trim(), decimals);
    return parsed > 0n ? parsed : 0n;
  } catch {
    return 0n;
  }
}

interface DepositRequest {
  chainId: NestChainId;
  farm: string;
  walletAddress: Address | undefined;
  tokenAddress: Address | undefined;
  amount: bigint;
  automation: AutomationSelection;
}

type DepositDetail = Awaited<ReturnType<typeof quoteDeposit>>['detail'];

type DepositWrite =
  | { kind: 'approval' }
  | { kind: 'deposit'; permissions: AutomationPermissionName[] };

export default function DepositPanel({ chainId, farm, supportsDustDeposit, onDeposited }: Props) {
  const { address, chainId: walletChainId } = useAccount();
  const tokens = farmTokens(farm);

  const [tokenIndex, setTokenIndex] = useState(0);
  const [amountText, setAmountText] = useState('');
  const [automation, setAutomation] = useState(manualSelection);

  const token = tokens[tokenIndex];
  const decimals = token?.decimals ?? 18;
  const wrongChain = walletChainId !== chainId;

  // Plain, not memoised: useBoundQuote keys on the serialised value.
  const request: DepositRequest = {
    chainId,
    farm: farmKey(farm),
    walletAddress: address,
    tokenAddress: token?.address as Address | undefined,
    amount: parseAmount(amountText, decimals),
    automation: { ...automation, depositDust: supportsDustDeposit && automation.depositDust },
  };

  const { quote, stale, error, isQuoting, build, discard } = useBoundQuote<
    DepositRequest,
    DepositDetail
  >(request);

  const { data: balance } = useReadContract({
    abi: erc20Abi,
    chainId,
    address: token?.address as Address | undefined,
    functionName: 'balanceOf',
    args: address ? [address] : undefined,
    query: { enabled: Boolean(address && token?.address) },
  });

  const {
    writeContract,
    data: txHash,
    isPending,
    error: writeError,
    reset,
  } = useWriteContract();

  /**
   * Which write is in flight.
   *
   * An approval and the spend both confirm through the same hook, and
   * discarding the quote on *any* confirmation retired it the moment the
   * approval landed — taking the button that spends it away with it. A ref,
   * not state, so the handler always reads the current value rather than
   * whatever was captured when the effect first ran.
   */
  const inFlight = useRef<DepositWrite | undefined>(undefined);

  const onConfirmed = useCallback(() => {
    const confirmed = inFlight.current;
    inFlight.current = undefined;
    if (!confirmed) return;
    if (confirmed.kind === 'approval') {
      reset();
      return;
    }
    discard();
    onDeposited?.(confirmed.permissions);
  }, [discard, onDeposited, reset]);

  const { isConfirming, succeeded, reverted } = useTxOutcome(txHash, chainId, onConfirmed);

  /**
   * Whether range-based automation can be offered.
   *
   * Only the tick spacing is needed up front, and that is a fixed property of
   * the pool contract — unlike the current tick, which is a moving number this
   * page must not build calldata from. The range itself is resolved at quote
   * time from what the quote says it will mint.
   */
  const tickSpacing = farm.pool.tickSpacing as number | undefined;
  const rangeAutomationAvailable =
    typeof tickSpacing === 'number' &&
    Number.isInteger(tickSpacing) &&
    tickSpacing > 0;

  // Read the approvals from the quote's own snapshot, so an edited amount can
  // never be checked against the figure a previous quote asked for.
  const erc20Approvals = (quote?.callData.planPreparation?.approvals ?? []).filter(
    approval => approval.kind === 'erc20'
  );
  const needed = erc20Approvals.reduce(
    (most, approval) =>
      BigInt(approval.amount ?? '0') > most ? BigInt(approval.amount ?? '0') : most,
    0n
  );
  const quotedToken = quote?.request.tokenAddress;

  /**
   * The allowance read from the chain, polled until it covers what is needed.
   *
   * Two things make the quote's own `planPreparation.allowance` unusable here:
   * it is a snapshot from when the quote was built, and the API's view lags a
   * freshly mined approval by a few seconds. Watching the chain also covers an
   * approval granted somewhere else entirely, and does not depend on this tab
   * seeing the receipt.
   */
  const { data: onChainAllowance } = useReadContract({
    abi: erc20Abi,
    chainId,
    address: quotedToken,
    functionName: 'allowance',
    args: address && quote?.callData.planPreparation?.spender
      ? [address, quote.callData.planPreparation.spender]
      : undefined,
    query: {
      enabled: Boolean(
        address &&
          quote?.callData.planPreparation?.spender &&
          quotedToken &&
          needed > 0n
      ),
      refetchInterval: query => {
        const granted = query.state.data as bigint | undefined;
        return granted !== undefined && granted >= needed ? false : 4000;
      },
    },
  });

  /** Approvals still genuinely outstanding, judged against the chain. */
  const outstanding: PlanApproval[] = erc20Approvals.filter(approval => {
    const amount = BigInt(approval.amount ?? '0');
    const granted =
      onChainAllowance !== undefined
        ? onChainAllowance
        : BigInt(approval.allowance ?? '0');
    return granted < amount;
  });

  async function buildQuote() {
    if (wrongChain) return;
    reset();
    await build(async req => {
      if (!req.walletAddress) throw new Error('Connect a wallet to quote');
      if (!req.tokenAddress) throw new Error('Pick a token');
      if (req.amount === 0n) throw new Error('Enter an amount');

      return quoteDeposit(
        NftPool.fromFarmInfo(farm), req.walletAddress, req.tokenAddress,
        req.amount, req.automation, tickSpacing,
      );
    });
  }

  function sendApproval(approval: PlanApproval) {
    if (wrongChain || !quote || failedAutomationQuote) return;
    inFlight.current = { kind: 'approval' };
    writeContract({
      abi: erc20Abi,
      chainId,
      address: approval.tokenAddress,
      functionName: 'approve',
      args: [approval.spender, BigInt(approval.amount ?? '0')],
    });
  }

  function sendDeposit() {
    if (wrongChain || !quote || failedAutomationQuote) return;
    inFlight.current = { kind: 'deposit', permissions: quote.detail.permissions };
    const { callData } = quote;
    writeContract({
      chainId,
      abi: callData.abi,
      address: callData.address,
      functionName: callData.functionName,
      args: callData.args,
      value: callData.value,
      ...gasWithHeadroom(callData),
    });
  }

  const busy = isPending || isConfirming;
  const ready = Boolean(address && request.amount > 0n && !wrongChain);
  const failedAutomationQuote = Boolean(
    quote?.detail.permissions.length && quote.callData.gasEstimateStatus !== 'success'
  );

  return (
    <section className="flex flex-col gap-4 rounded border border-zinc-200 p-4 dark:border-zinc-800">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500">
        Deposit
      </h2>

      <div className="flex flex-wrap gap-2">
        {tokens.map((t, i) => (
          <button
            key={t.address}
            onClick={() => setTokenIndex(i)}
            className={`rounded border px-3 py-1.5 text-sm ${
              i === tokenIndex
                ? 'border-zinc-900 font-medium dark:border-zinc-100'
                : 'border-zinc-300 text-zinc-600 dark:border-zinc-700 dark:text-zinc-400'
            }`}
          >
            {t.symbol}
          </button>
        ))}
      </div>

      <label className="flex flex-col gap-1 text-sm">
        <span className="flex justify-between text-zinc-500">
          <span>Amount</span>
          {balance !== undefined && (
            <button
              onClick={() => setAmountText(formatAmount(balance, decimals))}
              className="underline-offset-2 hover:underline"
            >
              Balance: {formatAmount(balance, decimals)} {token?.symbol}
            </button>
          )}
        </span>
        <input
          value={amountText}
          onChange={e => setAmountText(e.target.value)}
          inputMode="decimal"
          placeholder="0.0"
          className="rounded border border-zinc-300 px-3 py-2 font-mono dark:border-zinc-700 dark:bg-black"
        />
      </label>

      <fieldset className="flex flex-col gap-3 text-sm">
        <legend className="mb-2 font-medium">Automation</legend>
        {chainId === ELYSIUM_CHAIN_ID && (
          <>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={automation.rebalance}
                disabled={!rangeAutomationAvailable}
                onChange={event => setAutomation({ ...automation, rebalance: event.target.checked })}
              />
              Auto-rebalance outside the range, keeping the same width
            </label>
            <label className="flex flex-wrap items-center gap-2">
              <span>Trading fees</span>
              <select
                value={automation.rewards}
                onChange={event => setAutomation({
                  ...automation,
                  rewards: event.target.value as AutomationSelection['rewards'],
                })}
                className="rounded border border-zinc-300 px-2 py-1 dark:border-zinc-700 dark:bg-black"
              >
                <option value="off">Manual</option>
                <option value="harvest">Auto-harvest to wallet</option>
                <option value="compound">Auto-compound into this position</option>
              </select>
            </label>
          </>
        )}
        <label className="flex items-start gap-2">
          <input
            type="checkbox"
            checked={automation.exit}
            disabled={!rangeAutomationAvailable}
            onChange={event => setAutomation({ ...automation, exit: event.target.checked })}
            className="mt-1"
          />
          <span>
            Auto-exit to {token?.symbol} at the quoted trigger ticks
            {automation.rebalance && (
              <span className="block text-xs text-zinc-500">
                The exit band is fixed. Rebalance stops at its bounds.
              </span>
            )}
          </span>
        </label>
        {supportsDustDeposit && (
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={automation.depositDust}
              onChange={event => setAutomation({ ...automation, depositDust: event.target.checked })}
            />
            Auto-deposit eligible leftover tokens
          </label>
        )}
      </fieldset>

      <button
        onClick={buildQuote}
        disabled={!ready || isQuoting}
        className="rounded bg-zinc-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-40 dark:bg-zinc-100 dark:text-black"
      >
        {isQuoting ? 'Quoting…' : 'Get quote'}
      </button>

      {stale && !isQuoting && (
        <p className="rounded bg-amber-50 p-3 text-sm text-amber-800 dark:bg-amber-950 dark:text-amber-200">
          Inputs changed since that quote, so it no longer describes what you
          see. Quote again before sending.
        </p>
      )}

      {error && (
        <p className="rounded bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
          {error}
        </p>
      )}

      {quote && (
        <div className="flex flex-col gap-3 text-sm">
          <p className="text-zinc-600 dark:text-zinc-400">
            {explainGasStatus(quote.callData.gasEstimateStatus)}
          </p>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 font-mono text-xs">
            <dt className="text-zinc-500">depositing</dt>
            <dd>
              {formatAmount(quote.request.amount, decimals)} {token?.symbol}
            </dd>
            <dt className="text-zinc-500">position range</dt>
            <dd>
              {quote.detail.minted.min} … {quote.detail.minted.max}
            </dd>
            <dt className="text-zinc-500">automation</dt>
            <dd>{quote.detail.permissions.map(permissionLabel).join(', ') || 'off'}</dd>
            {quote.detail.trigger && (
              <>
                <dt className="text-zinc-500">exit band</dt>
                <dd>{quote.detail.trigger.min} … {quote.detail.trigger.max}</dd>
              </>
            )}
            <dt className="text-zinc-500">contract</dt>
            <dd>{shortAddress(quote.callData.address)}</dd>
            <dt className="text-zinc-500">function</dt>
            <dd>{quote.callData.functionName}</dd>
            {quote.callData.gas !== undefined && (
              <>
                <dt className="text-zinc-500">gas</dt>
                <dd>{quote.callData.gas.toString()}</dd>
              </>
            )}
          </dl>

          {quote.detail.permissions.length > 0 && (
            <p className="text-xs text-zinc-500">
              {failedAutomationQuote
                ? 'Get a successful simulation before submitting an automated deposit.'
                : 'After the deposit confirms, approve the keeper and any missing action permissions.'}
            </p>
          )}

          {outstanding.length > 0 ? (
            <div className="flex flex-col gap-2">
              <p className="text-zinc-600 dark:text-zinc-400">
                Approve first — the API returned exactly what is owed:
              </p>
              {outstanding.map(approval => (
                <button
                  key={approval.tokenAddress}
                  onClick={() => sendApproval(approval)}
                  disabled={busy || wrongChain || failedAutomationQuote}
                  className="rounded border border-zinc-900 px-4 py-2 text-sm font-medium disabled:opacity-40 dark:border-zinc-100"
                >
                  Approve {formatAmount(BigInt(approval.amount ?? '0'), decimals)}{' '}
                  {token?.symbol} for {shortAddress(approval.spender)}
                </button>
              ))}
              <p className="text-xs text-zinc-500">
                Once the approval confirms this becomes a Deposit button.
              </p>
            </div>
          ) : (
            <button
              onClick={sendDeposit}
              disabled={busy || wrongChain || failedAutomationQuote}
              className="rounded bg-emerald-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
            >
              {isPending
                ? 'Confirm in wallet…'
                : isConfirming
                  ? 'Depositing…'
                  : 'Deposit'}
            </button>
          )}
        </div>
      )}


      {writeError && (
        <p className="rounded bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
          The wallet rejected it: {shortWriteError(writeError)}
        </p>
      )}

      {txHash && (
        <p className="break-all font-mono text-xs text-zinc-500">
          {succeeded ? 'Confirmed: ' : reverted ? 'Reverted on-chain: ' : 'Sent: '}
          <a
            href={transactionUrl(chainId, txHash)}
            target="_blank"
            rel="noreferrer"
            className="underline underline-offset-2"
          >
            {txHash}
          </a>
        </p>
      )}
    </section>
  );
}
