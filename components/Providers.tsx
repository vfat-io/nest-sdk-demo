'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { WagmiProvider, createConfig, http } from 'wagmi';
import { injected } from 'wagmi/connectors';
import { ELYSIUM_CHAIN_ID, HYPEREVM_CHAIN_ID, nestChains } from '@/lib/chains';

const queryClient = new QueryClient();

/**
 * `injected()` alone.
 *
 * It covers MetaMask, Rabby and every other injected wallet. The dedicated
 * `metaMask()` connector pulls in the MetaMask SDK and, through it, the
 * Coinbase CDP SDK, which does not resolve under Turbopack.
 */
const config = createConfig({
  chains: [nestChains[HYPEREVM_CHAIN_ID], nestChains[ELYSIUM_CHAIN_ID]],
  connectors: [injected()],
  transports: { [HYPEREVM_CHAIN_ID]: http(), [ELYSIUM_CHAIN_ID]: http() },
  ssr: false,
});

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </WagmiProvider>
  );
}
