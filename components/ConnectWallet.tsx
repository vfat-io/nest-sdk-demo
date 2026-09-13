'use client';

import { useAccount, useConnect, useDisconnect, useSwitchChain } from 'wagmi';
import { NEST_CHAIN_ID } from '@/lib/nest';
import { shortAddress } from '@/lib/format';

export default function ConnectWallet() {
  const { address, isConnected, chainId } = useAccount();
  const { connectors, connect, isPending } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain } = useSwitchChain();

  const wrongChain = isConnected && chainId !== NEST_CHAIN_ID;

  if (!isConnected) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        {connectors.map(connector => (
          <button
            key={connector.uid}
            onClick={() => connect({ connector })}
            disabled={isPending}
            className="rounded border border-zinc-300 px-3 py-1.5 text-sm font-medium hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-900"
          >
            Connect {connector.name}
          </button>
        ))}
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-3 text-sm">
      <span className="font-mono">{address && shortAddress(address)}</span>
      {wrongChain ? (
        <button
          onClick={() => switchChain({ chainId: NEST_CHAIN_ID })}
          className="rounded bg-amber-500 px-3 py-1.5 text-sm font-medium text-white hover:bg-amber-600"
        >
          Switch to HyperEVM
        </button>
      ) : (
        <span className="text-zinc-500">HyperEVM</span>
      )}
      <button
        onClick={() => disconnect()}
        className="text-zinc-500 underline-offset-2 hover:underline"
      >
        Disconnect
      </button>
    </div>
  );
}
