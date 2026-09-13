'use client';

import { useCallback, useRef, useState } from 'react';
import { Address, erc20Abi, parseUnits } from 'viem';
import { useAccount, useReadContract, useWriteContract } from 'wagmi';
import {
  ContractCallData,
  FarmInfo,
  NftPool,
  PlanApproval,
} from '@vfat-io/sickle-sdk';
import { NEST_CHAIN_ID, farmTokens } from '@/lib/nest';
import { explainGasStatus, formatAmount, shortAddress } from '@/lib/format';
import { gasWithHeadroom } from '@/lib/gas';
import { shortWriteError } from '@/lib/format';
import {
  TickRange,
  encloses,
  mintedRangeFromCallData,
  triggerEnclosing,
} from '@/lib/ticks';
import { useBoundQuote } from '@/lib/quote';
import { useTxOutcome } from '@/lib/receipt';

interface Props {
  farm: FarmInfo;
  /** Called after a deposit confirms on-chain. */
  onDeposited?: () => void;
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

/** Price range around spot for the new position, in percent. */
const PRICE_MARGIN = { min: 5, max: 5 };

/**
 * Everything that determines what the deposit will do.
 *
 * Complete on purpose. Nothing the calldata depends on may be derived from
 * mutable page state outside this object, or an unrelated refresh could change
 * the transaction while the key — and so the quote — looked unchanged. That is
 * why the auto-exit trigger is no longer computed from `farm.pool.tick`: it is
 * resolved from the quote's own minted range instead, and travels in the
 * quote's `detail`.
 */
interface DepositRequest {
  farmAddress: Address;
  tokenAddress: Address | undefined;
  amount: bigint;
  autoExit: boolean;
}

/** What quoting resolved, for display and for the containment assertion. */
interface DepositDetail {
  minted: TickRange;
  trigger?: TickRange;
}

/** How many times to re-quote if spot moves out from under the trigger. */
const CONTAINMENT_ATTEMPTS = 3;

export default function DepositPanel({ farm, onDeposited }: Props) {
  const { address, chainId } = useAccount();
  const tokens = farmTokens(farm);

  const [tokenIndex, setTokenIndex] = useState(0);
  const [amountText, setAmountText] = useState('');
  const [autoExit, setAutoExit] = useState(false);

  const token = tokens[tokenIndex];
  const decimals = token?.decimals ?? 18;
  const wrongChain = chainId !== NEST_CHAIN_ID;

  // Plain, not memoised: useBoundQuote keys on the serialised value.
  const request: DepositRequest = {
    farmAddress: farm.address as Address,
    tokenAddress: token?.address as Address | undefined,
    amount: parseAmount(amountText, decimals),
    autoExit,
  };

  const { quote, stale, error, isQuoting, build, discard } = useBoundQuote<
    DepositRequest,
    DepositDetail
  >(request);

  const { data: balance } = useReadContract({
    abi: erc20Abi,
    chainId: NEST_CHAIN_ID,
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
  const inFlight = useRef<'approval' | 'deposit' | undefined>(undefined);

  const onConfirmed = useCallback(() => {
    if (inFlight.current === 'approval') {
      inFlight.current = undefined;
      reset();
      return;
    }
    inFlight.current = undefined;
    discard();
    onDeposited?.();
  }, [discard, onDeposited, reset]);

  const { isConfirming, succeeded, reverted } = useTxOutcome(txHash, onConfirmed);

  /**
   * Whether auto-exit can be offered at all.
   *
   * Only the tick spacing is needed up front, and that is a fixed property of
   * the pool contract — unlike the current tick, which is a moving number this
   * page must not build calldata from. The range itself is resolved at quote
   * time from what the quote says it will mint.
   */
  const tickSpacing = farm.pool.tickSpacing as number | undefined;
  const exitAvailable =
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
    chainId: NEST_CHAIN_ID,
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
    if (!address) return;
    reset();
    await build(async req => {
      if (!req.tokenAddress) throw new Error('Pick a token');
      if (req.amount === 0n) throw new Error('Enter an amount');

      const tokenAddress = req.tokenAddress;

      // fromFarmInfo carries the NFT manager, pool address and pool id across
      // from the API — the NFT endpoints reject a request without the manager.
      // Rebuilt each pass rather than reused, so addAutoExit cannot stack.
      const base = () =>
        NftPool.fromFarmInfo(farm)
          .deposit({ pricePercentageMargin: PRICE_MARGIN })
          .withToken({
            tokenAddress,
            amount: req.amount,
            slippage: 0.5,
            priceImpact: 5,
          });

      const rangeOf = (data: ContractCallData) => {
        const minted = mintedRangeFromCallData(data);
        if (!minted) {
          throw new Error(
            'The quote did not say which tick range it will mint, so an ' +
              'auto-exit range cannot be guaranteed to contain it.'
          );
        }
        return minted;
      };

      // Pass one tells us the range the API actually prices, which is the only
      // honest basis for a trigger. It is also the quote itself when auto-exit
      // is off, so nothing is wasted.
      const plain = await base().getCallData(address);
      if (!req.autoExit) {
        return { callData: plain, detail: { minted: rangeOf(plain) } };
      }
      if (!exitAvailable) {
        throw new Error(`Unusable tick spacing: ${tickSpacing}`);
      }

      let trigger = triggerEnclosing(rangeOf(plain), tickSpacing!);

      // Pass two quotes with that trigger and checks it against the range
      // *this* calldata mints — the one about to be signed. If spot moved
      // enough to shift the range out from under it, widen to the new range
      // and try again rather than signing a trigger that sits inside it.
      for (let attempt = 0; attempt < CONTAINMENT_ATTEMPTS; attempt++) {
        const callData = await base()
          .addAutoExit({
            triggerTicks: trigger,
            exitTokenOutLow: tokenAddress,
            exitTokenOutHigh: tokenAddress,
            priceImpactBP: 500,
            slippageBP: 100,
          })
          .getCallData(address);

        const minted = rangeOf(callData);
        if (encloses(trigger, minted)) {
          return { callData, detail: { minted, trigger } };
        }
        trigger = triggerEnclosing(minted, tickSpacing!);
      }

      throw new Error(
        'Spot kept moving out from under the auto-exit range. Try again, or ' +
          'deposit without auto-exit.'
      );
    });
  }

  function sendApproval(approval: PlanApproval) {
    inFlight.current = 'approval';
    writeContract({
      abi: erc20Abi,
      chainId: NEST_CHAIN_ID,
      address: approval.tokenAddress,
      functionName: 'approve',
      args: [approval.spender, BigInt(approval.amount ?? '0')],
    });
  }

  function sendDeposit() {
    if (!quote) return;
    inFlight.current = 'deposit';
    const { callData } = quote;
    writeContract({
      // Pinned: without it the connector uses whichever chain the wallet is
      // on, and HyperEVM calldata would go to those addresses elsewhere.
      chainId: NEST_CHAIN_ID,
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

      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          checked={autoExit}
          onChange={e => setAutoExit(e.target.checked)}
          disabled={!exitAvailable}
          className="mt-1"
        />
        <span>
          Auto-exit to {token?.symbol} if the price leaves the range
          <span className="block text-xs text-zinc-500">
            {exitAvailable
              ? 'The exact trigger is resolved when you quote, from the range the quote says it will mint, and shown below before you sign. Needs consent on this chain — see below.'
              : `Unavailable for this pool: unusable tick spacing (${tickSpacing}).`}
          </span>
        </span>
      </label>

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
            <dt className="text-zinc-500">auto-exit</dt>
            <dd>
              {quote.detail.trigger
                ? `outside ${quote.detail.trigger.min} … ${quote.detail.trigger.max}`
                : 'no'}
            </dd>
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

          {quote.detail.trigger && (
            <p className="text-xs text-zinc-500">
              The trigger sits outside the position at both ends, checked
              against this calldata — in range means no exit.
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
                  disabled={busy || wrongChain}
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
              disabled={busy || wrongChain}
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
            href={`https://www.hyperscan.com/tx/${txHash}`}
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
