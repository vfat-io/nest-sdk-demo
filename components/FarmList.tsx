'use client';

import { FarmInfo } from '@vfat-io/sickle-sdk';
import { farmPair } from '@/lib/nest';
import { formatAprPercent, formatUsd, shortAddress } from '@/lib/format';

interface Props {
  farms: FarmInfo[];
  selected: FarmInfo | undefined;
  onSelect: (farm: FarmInfo) => void;
}

export default function FarmList({ farms, selected, onSelect }: Props) {
  return (
    <div className="flex max-h-96 flex-col divide-y divide-zinc-200 overflow-y-auto rounded border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
      {farms.map(farm => {
        const isSelected = selected?.address === farm.address;
        return (
          <button
            key={farm.address}
            onClick={() => onSelect(farm)}
            className={`flex items-center justify-between gap-4 px-4 py-3 text-left text-sm transition-colors ${
              isSelected
                ? 'bg-zinc-100 dark:bg-zinc-900'
                : 'hover:bg-zinc-50 dark:hover:bg-zinc-950'
            }`}
          >
            <div className="flex min-w-0 flex-col">
              <span className="font-medium">{farmPair(farm)}</span>
              <span className="truncate font-mono text-xs text-zinc-500">
                {shortAddress(farm.address)}
                {farm.nftManagerAddress &&
                  ` · manager ${shortAddress(farm.nftManagerAddress)}`}
              </span>
            </div>
            <div className="flex shrink-0 flex-col items-end">
              <span className="font-medium">
                {formatAprPercent(farm.snapshot?.apr)}
              </span>
              <span className="text-xs text-zinc-500">
                {formatUsd(farm.snapshot?.stakedLiquidity)} staked
              </span>
            </div>
          </button>
        );
      })}
    </div>
  );
}
