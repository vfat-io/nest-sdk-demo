import DemoPage from '@/components/DemoPage';
import { ELYSIUM_CHAIN_ID } from '@/lib/chains';

export default function Elysium() {
  return <DemoPage chainId={ELYSIUM_CHAIN_ID} />;
}
