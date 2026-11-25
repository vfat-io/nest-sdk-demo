import { getChain } from '@vfat-io/sickle-sdk';
import { defineChain, Hash } from 'viem';

export const HYPEREVM_CHAIN_ID = 999;
export const ELYSIUM_CHAIN_ID = 99901;
export type NestChainId = typeof HYPEREVM_CHAIN_ID | typeof ELYSIUM_CHAIN_ID;

export const nestChains = {
  [HYPEREVM_CHAIN_ID]: {
    ...getChain(HYPEREVM_CHAIN_ID),
    id: HYPEREVM_CHAIN_ID,
    name: 'HyperEVM',
  },
  [ELYSIUM_CHAIN_ID]: defineChain({
    id: ELYSIUM_CHAIN_ID,
    name: 'Elysium',
    nativeCurrency: { name: 'Hyperliquid', symbol: 'HYPE', decimals: 18 },
    rpcUrls: { default: { http: ['https://rpc.elysium.kinetiq.xyz'] } },
    blockExplorers: {
      default: { name: 'Elysium Explorer', url: 'https://elysiumexplore.com' },
    },
  }),
} as const;

export function transactionUrl(chainId: NestChainId, hash: Hash): string {
  return `${nestChains[chainId].blockExplorers!.default.url}/tx/${hash}`;
}
