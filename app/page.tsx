import DemoPage from '@/components/DemoPage';
import { HYPEREVM_CHAIN_ID } from '@/lib/chains';

export default function Home() {
  return <DemoPage chainId={HYPEREVM_CHAIN_ID} />;
}
