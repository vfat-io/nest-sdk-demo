import Link from 'next/link';
import NestDemoClient from '@/components/NestDemoClient';
import { ELYSIUM_CHAIN_ID, HYPEREVM_CHAIN_ID, NestChainId, nestChains } from '@/lib/chains';

const demos = [
  { chainId: HYPEREVM_CHAIN_ID, href: '/', label: 'HyperEVM' },
  { chainId: ELYSIUM_CHAIN_ID, href: '/elysium', label: 'Elysium · Uniswap v4' },
] as const;

export default function DemoPage({ chainId }: { chainId: NestChainId }) {
  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-black">
      <main className="mx-auto flex min-h-screen w-full max-w-2xl flex-col gap-8 bg-[var(--background)] px-6 py-16 sm:px-10">
        <header className="flex flex-col gap-2">
          <h1 className="text-3xl font-semibold tracking-tight">
            Nest × vfat SDK
          </h1>
          <p className="leading-7 text-zinc-600 dark:text-zinc-400">
            Open and manage Nest positions with{' '}
            <code className="font-mono text-sm">@vfat-io/sickle-sdk</code>.
            Farms, quotes and approvals come from the live vfat API.
          </p>
        </header>

        <nav aria-label="Demo network" className="flex flex-wrap gap-2 text-sm">
          {demos.map(demo => (
            <Link
              key={demo.chainId}
              href={demo.href}
              aria-current={demo.chainId === chainId ? 'page' : undefined}
              className="rounded border border-zinc-300 px-3 py-1.5 hover:bg-zinc-100 aria-[current=page]:border-zinc-900 aria-[current=page]:font-semibold dark:border-zinc-700 dark:hover:bg-zinc-900 dark:aria-[current=page]:border-zinc-100"
            >
              {demo.label}
            </Link>
          ))}
        </nav>

        <NestDemoClient key={chainId} chainId={chainId} />

        <footer className="border-t border-zinc-200 pt-6 text-xs text-zinc-500 dark:border-zinc-800">
          Transactions on {nestChains[chainId].name} mainnet spend real funds.
        </footer>
      </main>
    </div>
  );
}
