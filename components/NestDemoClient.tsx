'use client';

import dynamic from 'next/dynamic';

/**
 * The interactive tree is client-only.
 *
 * Everything below depends on wallet state, which does not exist on the
 * server. Rendering it server-side produced markup that never matched the
 * client's first paint, and React discarded and re-rendered the tree with a
 * hydration error in the console.
 */
const NestDemo = dynamic(() => import('./NestDemo'), {
  ssr: false,
  loading: () => <p className="text-sm text-zinc-500">Loading…</p>,
});

export default function NestDemoClient() {
  return <NestDemo />;
}
