import { ApiCallError, ContractCallData, NftPool, NftSettings, QuoteAPI } from '@vfat-io/sickle-sdk';
import { Address, encodeAbiParameters } from 'viem';
import { AutomationSelection, permissionsForSettings, settingsForDeposit } from './automation';
import { mintedRangeFromCallData } from './ticks';

const priceMargin = { min: 5, max: 5 };

function mintRange(data: ContractCallData, chainId: number) {
  if (data.chainId !== chainId) throw new Error('The quote returned a different chain.');
  const minted = mintedRangeFromCallData(data);
  if (!minted) throw new Error('The quote did not include its mint range.');
  return minted;
}

function checkQuotedSettings(data: ContractCallData, settings: NftSettings) {
  const deposit = data.abi.find(item => item.type === 'function' && item.name === data.functionName);
  const index = deposit && 'inputs' in deposit ? deposit.inputs.findIndex(input => input.name === 'settings') : -1;
  const param = deposit && 'inputs' in deposit ? deposit.inputs[index] : undefined;
  if (!param || !('components' in param) || !Array.isArray(param.components)) {
    throw new Error('The quoted transaction cannot store the requested automation settings.');
  }
  if (settings.autoDeposit && !param.components.some((item: { name: string }) => item.name === 'autoDeposit')) {
    throw new Error('The quoted transaction does not include auto-deposit.');
  }
  if (encodeAbiParameters([param], [data.args[index]]) !== encodeAbiParameters([param], [settings])) {
    throw new Error('The quote returned different automation settings. Get a fresh quote.');
  }
}

export async function quoteDeposit(
  pool: NftPool,
  walletAddress: Address,
  tokenAddress: Address,
  amount: bigint,
  selection: AutomationSelection,
  spacing: number | undefined,
) {
  const input = { tokenAddress, amount, slippage: 0.5, priceImpact: 5 };
  const plain = () => pool.deposit({ pricePercentageMargin: priceMargin })
    .withToken(input).getCallData(walletAddress);

  if (!selection.rebalance && !selection.exit && !selection.depositDust && selection.rewards === 'off') {
    const callData = await plain();
    return { callData, detail: { minted: mintRange(callData, pool.chainId), permissions: [] } };
  }

  let range;
  if (selection.rebalance || selection.exit) {
    if (!spacing || !Number.isInteger(spacing) || spacing < 1) {
      throw new Error('The pool is missing its tick spacing.');
    }
    range = { minted: mintRange(await plain(), pool.chainId), spacing };
  }

  const { settings, trigger } = settingsForDeposit(pool, selection, tokenAddress, range);
  // Pin both ticks on the second quote so a price update cannot change the
  // width used by the registry or put the exit trigger inside the new NFT.
  const mintParams = range
    ? { tickLower: range.minted.min, tickUpper: range.minted.max }
    : { minPricePercentage: priceMargin.min, maxPricePercentage: priceMargin.max };
  let callData;
  try {
    callData = await QuoteAPI.DepositTokenToNft({
      chainId: pool.chainId,
      walletAddress,
      farmAddress: pool.address,
      ...pool.nftPoolParams,
      ...input,
      ...mintParams,
      nftSettings: settings,
    });
  } catch (error) {
    if (error instanceof ApiCallError && error.responseBody?.includes('"AVR_AUTOMATION_UNAVAILABLE"')) {
      throw new Error('The quote API has not enabled automation for this pool yet. Turn off the selected automations to quote a manual deposit.');
    }
    throw error;
  }

  const minted = mintRange(callData, pool.chainId);
  if (range && (minted.min !== range.minted.min || minted.max !== range.minted.max)) {
    throw new Error('The quote changed the requested mint range. Get a fresh quote.');
  }
  checkQuotedSettings(callData, settings);
  return { callData, detail: { minted, trigger, permissions: permissionsForSettings(settings) } };
}
