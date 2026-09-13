import NestDemoClient from '@/components/NestDemoClient';

export default function Home() {
  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-black">
      <main className="mx-auto flex min-h-screen w-full max-w-2xl flex-col gap-8 bg-[var(--background)] px-6 py-16 sm:px-10">
        <header className="flex flex-col gap-2">
          <h1 className="text-3xl font-semibold tracking-tight">
            Nest × vfat SDK
          </h1>
          <p className="leading-7 text-zinc-600 dark:text-zinc-400">
            A working example of opening and managing a Nest position through{' '}
            <code className="font-mono text-sm">@vfat-io/sickle-sdk</code>.
            Farms, quotes and approvals all come from the live vfat API.
          </p>
        </header>

        <NestDemoClient />

        <footer className="border-t border-zinc-200 pt-6 text-xs text-zinc-500 dark:border-zinc-800">
          Transactions are real. This connects to HyperEVM mainnet and spends
          real funds.
        </footer>
      </main>
    </div>
  );
}
