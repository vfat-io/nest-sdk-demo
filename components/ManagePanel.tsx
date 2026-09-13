'use client';

import { useCallback, useRef, useState } from 'react';
import { Address, erc20Abi, parseUnits } from 'viem';
import { useAccount, useReadContract, useWriteContract } from 'wagmi';
import { ContractCallData, NftPool } from '@vfat-io/sickle-sdk';
import {
  NEST_CHAIN_ID,
  NestPosition,
  farmTokens,
  positionValueUsd,
} from '@/lib/nest';
import {
  explainGasStatus,
  formatAmount,
  formatUsd,
  shortAddress,
  shortWriteError,
} from '@/lib/format';
import { gasWithHeadroom } from '@/lib/gas';
import { useBoundQuote } from '@/lib/quote';
import { useTxOutcome } from '@/lib/receipt';

interface Props {
  entry: NestPosition;
  /** Called after a transaction confirms on-chain, so the list can refresh. */
  onChanged: () => void;
}

type Action = 'increase' | 'decrease' | 'rebalance' | 'harvest' | 'compound' | 'exit';

/**
 * `label` names the tab, `submit` names the button that signs.
 *
 * They differ on purpose: a button that says the same thing as the tab you
 * just pressed does not tell you it is about to send a transaction.
 */
const ACTIONS: { id: Action; label: string; submit: string; blurb: string }[] = [
  { id: 'increase', label: 'Increase', submit: 'Increase position', blurb: 'Add a token to the position.' },
  { id: 'decrease', label: 'Decrease', submit: 'Withdraw from position', blurb: 'Take part of it back out.' },
  { id: 'rebalance', label: 'Rebalance', submit: 'Move the range', blurb: 'Move the range around spot. Mints a new NFT.' },
  { id: 'harvest', label: 'Harvest', submit: 'Claim rewards', blurb: 'Claim rewards without swapping.' },
  { id: 'compound', label: 'Compound', submit: 'Compound rewards', blurb: 'Put the rewards back in.' },
  { id: 'exit', label: 'Exit', submit: 'Close position', blurb: 'Close it and take the funds back.' },
];

/**
 * Everything that determines what the transaction will do.
 *
 * The quote is keyed on this, so changing any of it retires the quote rather
 * than leaving calldata that no longer matches the screen.
 */
interface ManageRequest {
  action: Action;
  nftId: bigint;
  tokenAddress: Address | undefined;
  amount: bigint;
  percent: number;
  margin: number;
}

export default function ManagePanel({ entry, onChanged }: Props) {
  const { address, chainId } = useAccount();
  const tokens = farmTokens(entry.farm);

  const [action, setAction] = useState<Action>('increase');
  const [tokenIndex, setTokenIndex] = useState(0);
  const [amountText, setAmountText] = useState('');
  const [percentText, setPercentText] = useState('50');
  const [marginText, setMarginText] = useState('5');

  const token = tokens[tokenIndex];
  const decimals = token?.decimals ?? 18;

  // Plain, not memoised: useBoundQuote keys on the serialised value, so the
  // object's identity is never load-bearing.
  const request: ManageRequest = {
    action,
    nftId: entry.nftId,
    tokenAddress: token?.address as Address | undefined,
    amount: safeParse(amountText, decimals),
    percent: Number(percentText),
    margin: Number(marginText),
  };

  const { quote, stale, error, isQuoting, build, discard } =
    useBoundQuote<ManageRequest>(request);

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
  const inFlight = useRef<'approval' | 'action' | undefined>(undefined);

  const onConfirmed = useCallback(() => {
    if (inFlight.current === 'approval') {
      // The allowance poll will see it and swap in the submit button. The
      // quote is still exactly what the user asked for, so it stays.
      inFlight.current = undefined;
      reset();
      return;
    }
    // The quote is spent: its calldata must not be submittable again.
    inFlight.current = undefined;
    discard();
    onChanged();
  }, [discard, onChanged, reset]);

  const { isConfirming, succeeded, reverted } = useTxOutcome(txHash, onConfirmed);

  const wrongChain = chainId !== NEST_CHAIN_ID;

  // Read the approval requirement from the quote's own snapshot, never from
  // the live controls — otherwise an edited amount checks the wrong figure.
  const spender = quote?.callData.planPreparation?.spender;
  const quotedAmount =
    quote?.request.action === 'increase' ? quote.request.amount : 0n;
  const quotedToken = quote?.request.tokenAddress;

  const { data: onChainAllowance } = useReadContract({
    abi: erc20Abi,
    chainId: NEST_CHAIN_ID,
    address: quotedToken,
    functionName: 'allowance',
    args: address && spender ? [address, spender] : undefined,
    query: {
      enabled: Boolean(address && spender && quotedToken && quotedAmount > 0n),
      refetchInterval: query => {
        const granted = query.state.data as bigint | undefined;
        return granted !== undefined && granted >= quotedAmount ? false : 4000;
      },
    },
  });

  const needsApproval =
    quotedAmount > 0n &&
    spender !== undefined &&
    (onChainAllowance ?? 0n) < quotedAmount;

  function retireQuote() {
    discard();
    reset();
  }

  async function buildQuote() {
    if (!address) return;
    reset();
    await build(async req => {
      const pool = NftPool.fromFarmInfo(entry.farm);
      const nftId = req.nftId;
      let built: ContractCallData;

      switch (req.action) {
        case 'increase': {
          if (req.amount === 0n) throw new Error('Enter an amount');
          if (!req.tokenAddress) throw new Error('Pick a token');
          built = await pool
            .increase({ nftId })
            .withToken({
              tokenAddress: req.tokenAddress,
              amount: req.amount,
              slippage: 1,
              priceImpact: 10,
            })
            .getCallData(address);
          break;
        }
        case 'decrease': {
          if (!Number.isFinite(req.percent) || req.percent <= 0 || req.percent > 100) {
            throw new Error('Percentage must be between 1 and 100');
          }
          built = await pool
            .decrease({ nftId, decreasePercentage: req.percent })
            .toUnderlying()
            .getCallData(address);
          break;
        }
        case 'rebalance': {
          if (!Number.isFinite(req.margin) || req.margin <= 0) {
            throw new Error('Margin must be a positive percentage');
          }
          built = await pool
            .rebalance({
              nftId,
              pricePercentageMargin: { min: req.margin, max: req.margin },
              slippage: 1,
              priceImpact: 10,
            })
            .getCallData(address);
          break;
        }
        case 'harvest':
          // No .toToken(): the API harvests the reward tokens as they are.
          built = await pool.harvest({ nftId }).getCallData(address);
          break;
        case 'compound':
          built = await pool
            .compound({ nftId, slippage: 1, priceImpact: 10 })
            .getCallData(address);
          break;
        case 'exit':
          if (!req.tokenAddress) throw new Error('Pick a token to exit to');
          built = await pool
            .exit({ nftId })
            .toToken({
              tokenAddress: req.tokenAddress,
              slippage: 1,
              priceImpact: 10,
            })
            .getCallData(address);
          break;
      }

      // No resolved extras for these actions; the request is the whole story.
      return { callData: built, detail: undefined };
    });
  }

  function approve() {
    if (!spender || !quotedToken || quotedAmount === 0n) return;
    inFlight.current = 'approval';
    writeContract({
      abi: erc20Abi,
      chainId: NEST_CHAIN_ID,
      address: quotedToken,
      functionName: 'approve',
      args: [spender, quotedAmount],
    });
  }

  function submit() {
    if (!quote) return;
    inFlight.current = 'action';
    const { callData } = quote;
    writeContract({
      // Pinned, so the connector cannot send HyperEVM calldata to whatever
      // occupies these addresses on whichever chain the wallet is on.
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
  const chosen = ACTIONS.find(a => a.id === action)!;
  const value = positionValueUsd(entry.position);
  const quotedAction = quote && ACTIONS.find(a => a.id === quote.request.action)!;

  return (
    <div className="flex flex-col gap-4 border-t border-zinc-200 pt-4 dark:border-zinc-800">
      <div className="flex flex-wrap gap-2">
        {ACTIONS.map(a => (
          <button
            key={a.id}
            onClick={() => {
              setAction(a.id);
              retireQuote();
            }}
            className={`rounded border px-3 py-1.5 text-sm ${
              a.id === action
                ? 'border-zinc-900 font-medium dark:border-zinc-100'
                : 'border-zinc-300 text-zinc-600 dark:border-zinc-700 dark:text-zinc-400'
            }`}
          >
            {a.label}
          </button>
        ))}
      </div>

      <p className="text-sm text-zinc-500">{chosen.blurb}</p>

      {(action === 'harvest' || action === 'compound') && (
        <RewardSummary entry={entry} />
      )}

      {(action === 'increase' || action === 'exit') && (
        <div className="flex flex-wrap gap-2">
          {tokens.map((t, i) => (
            <button
              key={t.address}
              onClick={() => setTokenIndex(i)}
              className={`rounded border px-3 py-1 text-xs ${
                i === tokenIndex
                  ? 'border-zinc-900 font-medium dark:border-zinc-100'
                  : 'border-zinc-300 text-zinc-600 dark:border-zinc-700 dark:text-zinc-400'
              }`}
            >
              {action === 'exit' ? `to ${t.symbol}` : t.symbol}
            </button>
          ))}
        </div>
      )}

      {action === 'increase' && (
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-zinc-500">Amount of {token?.symbol}</span>
          <input
            value={amountText}
            onChange={e => setAmountText(e.target.value)}
            inputMode="decimal"
            placeholder="0.0"
            className="rounded border border-zinc-300 px-3 py-2 font-mono dark:border-zinc-700 dark:bg-black"
          />
        </label>
      )}

      {action === 'decrease' && (
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-zinc-500">
            Percent to withdraw {value !== undefined && `(of ${formatUsd(value)})`}
          </span>
          <input
            value={percentText}
            onChange={e => setPercentText(e.target.value)}
            inputMode="numeric"
            className="rounded border border-zinc-300 px-3 py-2 font-mono dark:border-zinc-700 dark:bg-black"
          />
        </label>
      )}

      {action === 'rebalance' && (
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-zinc-500">New range, ± percent around spot</span>
          <input
            value={marginText}
            onChange={e => setMarginText(e.target.value)}
            inputMode="decimal"
            className="rounded border border-zinc-300 px-3 py-2 font-mono dark:border-zinc-700 dark:bg-black"
          />
        </label>
      )}

      <button
        onClick={buildQuote}
        disabled={isQuoting || !address || wrongChain}
        className="rounded bg-zinc-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-40 dark:bg-zinc-100 dark:text-black"
      >
        {isQuoting ? 'Quoting…' : `Quote ${chosen.label.toLowerCase()}`}
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

      {quote && quotedAction && (
        <div className="flex flex-col gap-3 text-sm">
          <p className="text-zinc-600 dark:text-zinc-400">
            {explainGasStatus(quote.callData.gasEstimateStatus)}
          </p>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 font-mono text-xs">
            <dt className="text-zinc-500">action</dt>
            <dd>{quotedAction.label}</dd>
            {quote.request.action === 'increase' && (
              <>
                <dt className="text-zinc-500">adding</dt>
                <dd>
                  {formatAmount(quote.request.amount, decimals)} {token?.symbol}
                </dd>
              </>
            )}
            {quote.request.action === 'decrease' && (
              <>
                <dt className="text-zinc-500">withdrawing</dt>
                <dd>{quote.request.percent}%</dd>
              </>
            )}
            {quote.request.action === 'rebalance' && (
              <>
                <dt className="text-zinc-500">new range</dt>
                <dd>± {quote.request.margin}%</dd>
              </>
            )}
            <dt className="text-zinc-500">contract</dt>
            <dd>{shortAddress(quote.callData.address)}</dd>
            <dt className="text-zinc-500">function</dt>
            <dd>{quote.callData.functionName}</dd>
          </dl>

          {needsApproval ? (
            <button
              onClick={approve}
              disabled={busy || wrongChain}
              className="rounded border border-zinc-900 px-4 py-2 font-medium disabled:opacity-40 dark:border-zinc-100"
            >
              {busy ? 'Confirm in wallet…' : `Approve ${token?.symbol}`}
            </button>
          ) : (
            <button
              onClick={submit}
              disabled={busy || wrongChain}
              className="rounded bg-emerald-600 px-4 py-2 font-medium text-white disabled:opacity-40"
            >
              {busy ? 'Sending…' : quotedAction.submit}
            </button>
          )}

          {quote.request.action === 'rebalance' && (
            <p className="text-xs text-zinc-500">
              A rebalance burns this NFT and mints a new one, so the id changes.
            </p>
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
    </div>
  );
}

/**
 * What this position has to claim, before you press Quote.
 *
 * Two lists, and only one of them is harvestable. `rewards` are on-chain —
 * the pool's accrued fees and any emissions the farm contract holds — and
 * that is what `harvest`/`compound` move. `offChainRewards` are distributed
 * separately by the protocol, so the quote API does not count them: a
 * position holding only those gets a 400 "No rewards" back.
 */
function RewardSummary({ entry }: { entry: NestPosition }) {
  const onChain = entry.position.rewards ?? [];
  const offChain = entry.position.offChainRewards ?? [];

  const describe = (list: typeof onChain) =>
    list
      .filter(r => r.amount > 0n)
      .map(r => `${formatAmount(r.amount, r.token.decimals ?? 18)} ${r.token.symbol}`)
      .join(', ');

  const claimable = describe(onChain);
  const separate = describe(offChain);

  return (
    <div className="rounded bg-zinc-50 p-3 text-xs dark:bg-zinc-900">
      <p>
        <span className="text-zinc-500">Claimable here: </span>
        {claimable || 'nothing yet'}
      </p>
      {separate && (
        <p className="mt-1 text-zinc-500">
          Distributed separately, not by this action: {separate}
        </p>
      )}
    </div>
  );
}

function safeParse(text: string, decimals: number): bigint {
  if (!text.trim()) return 0n;
  try {
    const parsed = parseUnits(text.trim(), decimals);
    return parsed > 0n ? parsed : 0n;
  } catch {
    return 0n;
  }
}
