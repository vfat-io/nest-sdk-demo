import {
  AutoCompound,
  AutoHarvest,
  AutoRebalance,
  AutomationPermissionName,
  buildNftSettings,
  NftPool,
  RewardBehavior,
  validateNftSettings,
} from '@vfat-io/sickle-sdk';
import { Address, parseAbi, zeroAddress } from 'viem';
import { encloses, TickRange, triggerEnclosing } from './ticks';

export interface AutomationSelection {
  rebalance: boolean;
  rewards: 'off' | 'harvest' | 'compound';
  exit: boolean;
  depositDust: boolean;
}

export const manualSelection: AutomationSelection = {
  rebalance: false,
  rewards: 'off',
  exit: false,
  depositDust: false,
};

export const automationLabels: Partial<Record<AutomationPermissionName, string>> = {
  nftRebalanceGeneric: 'Auto-rebalance',
  nftHarvest: 'Auto-harvest',
  nftCompound: 'Auto-compound',
  nftExit: 'Auto-exit',
  nftDustDeposit: 'Auto-deposit',
};

export function permissionLabel(permission: AutomationPermissionName): string {
  return automationLabels[permission] ?? permission;
}

interface AutomationFlags {
  autoRebalance: boolean;
  automateRewards: boolean;
  rewardConfig: { rewardBehavior: number };
  autoExit: boolean;
  autoDeposit?: boolean;
}

export function permissionsForSettings(settings: AutomationFlags | undefined): AutomationPermissionName[] {
  if (!settings) return [];
  const permissions: AutomationPermissionName[] = [];
  if (settings.autoRebalance) permissions.push('nftRebalanceGeneric');
  if (settings.automateRewards) {
    if (settings.rewardConfig.rewardBehavior === RewardBehavior.Harvest) permissions.push('nftHarvest');
    if (settings.rewardConfig.rewardBehavior === RewardBehavior.Compound) permissions.push('nftCompound');
  }
  if (settings.autoExit) permissions.push('nftExit');
  if (settings.autoDeposit) permissions.push('nftDustDeposit');
  return permissions;
}

export function settingsForDeposit(
  pool: NftPool,
  selection: AutomationSelection,
  tokenOut: Address,
  range?: { minted: TickRange; spacing: number },
) {
  const autoRewards: AutoHarvest | AutoCompound | undefined =
    selection.rewards === 'harvest' ? { rewardBehavior: RewardBehavior.Harvest } :
    selection.rewards === 'compound' ? { rewardBehavior: RewardBehavior.Compound } : undefined;

  if ((selection.rebalance || selection.exit) && !range) {
    throw new Error('Get the position range before setting rebalance or exit.');
  }

  let trigger: TickRange | undefined;
  if (selection.exit && range) {
    const clearance = selection.rebalance ? range.minted.max - range.minted.min : range.spacing;
    trigger = triggerEnclosing(range.minted, range.spacing, clearance);
    if (!encloses(trigger, range.minted)) {
      throw new Error('The quoted range leaves no room for both exit triggers.');
    }
  }

  let autoRebalance: AutoRebalance | undefined;
  if (selection.rebalance && range) {
    // One tick space holds the active price. The offsets plus that space must
    // equal the minted NFT's width, as checked by the settings registry.
    const offsets = (range.minted.max - range.minted.min) / range.spacing - 1;
    if (!Number.isInteger(offsets) || offsets < 0) {
      throw new Error('The quoted range does not align to the pool tick spacing.');
    }
    autoRebalance = {
      ticksMargin: { min: Math.ceil(offsets / 2), max: Math.floor(offsets / 2) },
      cutoffTicks: trigger,
      rewardConfig: { rewardBehavior: autoRewards?.rewardBehavior ?? RewardBehavior.None, harvestTokenOut: zeroAddress },
    };
  }

  const autoExit = trigger && {
    triggerTicks: trigger,
    exitTokenOutLow: tokenOut,
    exitTokenOutHigh: tokenOut,
    priceImpactBP: 500,
    slippageBP: 100,
  };
  const settings = buildNftSettings(
    pool.resolvedPoolAddress, pool.poolId, autoRebalance, autoRewards, autoExit,
    { autoDeposit: selection.depositDust },
  );
  validateNftSettings(settings);
  return { settings, trigger };
}

export const sickleApprovalAbi = parseAbi([
  'function approved() view returns (address)',
  'function setApproved(address newApproved)',
]);

// Elysium uses the registry layout that includes the auto-deposit flag.
export const elysiumSettingsAbi = parseAbi([
  'struct NftKey { address sickle; address nftManager; uint256 tokenId; }',
  'struct RewardConfig { uint8 rewardBehavior; address harvestTokenOut; }',
  'struct RebalanceConfig { uint24 tickSpacesBelow; uint24 tickSpacesAbove; int24 bufferTicksBelow; int24 bufferTicksAbove; uint256 dustBP; uint256 priceImpactBP; uint256 slippageBP; int24 cutoffTickLow; int24 cutoffTickHigh; uint8 delayMin; RewardConfig rewardConfig; }',
  'struct ExitConfig { int24 triggerTickLow; int24 triggerTickHigh; address exitTokenOutLow; address exitTokenOutHigh; uint256 priceImpactBP; uint256 slippageBP; }',
  'struct NftSettings { address pool; bytes32 poolId; bool autoRebalance; RebalanceConfig rebalanceConfig; bool automateRewards; RewardConfig rewardConfig; bool autoExit; ExitConfig exitConfig; bytes extraData; bool autoDeposit; }',
  'function getNftSettings(NftKey key) view returns (NftSettings)',
]);
