'use client';

import { useAccount, useConnect, useDisconnect, useSwitchChain } from 'wagmi';
import { NestChainId, nestChains } from '@/lib/chains';
import { shortAddress, shortWriteError } from '@/lib/format';

export default function ConnectWallet({ targetChainId }: { targetChainId: NestChainId }) {
  const { address, isConnected, chainId } = useAccount();
  const { connectors, connect, isPending } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain, error, isPending: isSwitching } = useSwitchChain();

  const wrongChain = isConnected && chainId !== targetChainId;
  const chainName = nestChains[targetChainId].name;

  if (!isConnected) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        {connectors.map(connector => (
          <button
            key={connector.uid}
            onClick={() => connect({ connector, chainId: targetChainId })}
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
          onClick={() => switchChain({ chainId: targetChainId })}
          disabled={isSwitching}
          className="rounded bg-amber-500 px-3 py-1.5 text-sm font-medium text-white hover:bg-amber-600 disabled:opacity-50"
        >
          Switch to {chainName}
        </button>
      ) : (
        <span className="text-zinc-500">{chainName}</span>
      )}
      <button
        onClick={() => disconnect()}
        className="text-zinc-500 underline-offset-2 hover:underline"
      >
        Disconnect
      </button>
      {wrongChain && error && (
        <p role="alert" className="basis-full text-red-600 dark:text-red-400">
          {shortWriteError(error)}
        </p>
      )}
    </div>
  );
}
