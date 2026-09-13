'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { WagmiProvider, createConfig, http } from 'wagmi';
import { injected } from 'wagmi/connectors';
import { getChain } from '@vfat-io/sickle-sdk';
import { NEST_CHAIN_ID } from '@/lib/nest';

const queryClient = new QueryClient();

/**
 * Only HyperEVM.
 *
 * The SDK's `supportedChains` carries every chain viem knows about; Nest is on
 * one, so naming it directly keeps the wagmi config and the bundle small.
 */
const nestChain = getChain(NEST_CHAIN_ID);

/**
 * `injected()` alone.
 *
 * It covers MetaMask, Rabby and every other injected wallet. The dedicated
 * `metaMask()` connector pulls in the MetaMask SDK and, through it, the
 * Coinbase CDP SDK, which does not resolve under Turbopack.
 */
const config = createConfig({
  chains: [nestChain],
  connectors: [injected()],
  transports: { [nestChain.id]: http() },
  ssr: false,
});

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </WagmiProvider>
  );
}
