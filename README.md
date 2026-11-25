# Nest × vfat SDK

A working example of opening and managing a [Nest](https://app.usenest.xyz)
position through [`@vfat-io/sickle-sdk`](https://www.npmjs.com/package/@vfat-io/sickle-sdk).

The farm list, quotes, approvals and automation state come from the live vfat
API. The demo connects a wallet to HyperEVM or Elysium mainnet.

## Running it

```bash
npm ci
npm run dev
```

Open http://localhost:3000 for HyperEVM (chain 999) or
http://localhost:3000/elysium for Nest Uniswap v4 on Elysium (chain 99901).
Connect an injected wallet such as MetaMask or Rabby. Elysium uses HYPE for gas.

The SDK is an ordinary npm dependency, so installing needs nothing but the
public npm registry.

## Elysium and Uniswap v4

`MainAPI.fetchFarms(99901)` returns Nest v4 and Classic farms. The Elysium
demo selects the Nest `UNISWAP_V4` entries. Several pools share the same
PoolManager and token pair. Use the PoolManager address and `farm.pool.poolId`
to select a pool and match its positions. Pass the farm record to
`NftPool.fromFarmInfo(farm)` to carry the pool ID and NFT manager into the quote.
vfat builds the calldata for the selected pool and its hook.

The wallet config defines Elysium with viem's `defineChain`. The demo pins
the quote, approvals, transaction and receipt lookup to the selected chain.
`NftPool` manages the positions held by the user's Sickle. Wallet-held
positions are displayed with their custody identified.

For a new Elysium position, choose auto-rebalance, auto-harvest or
auto-compound, auto-exit, and auto-deposit of eligible leftover tokens.
Harvest and compound are two modes for the same fee setting. The live quote
API reports availability per pool, and a rejected automation quote leaves
the manual deposit flow available.

After the deposit confirms, **Keeper setup** shows the selected actions and
the wallet transactions needed to approve the keeper and grant missing
permissions. For a held Elysium position, the demo reads its saved settings
from the NFT settings registry. Runs follow the position's triggers and gas
economics. See [vfat's automation and funding guide](https://vfat.io/docs/automation).

The position's Harvest and Compound actions handle fees. Elysium NEST
incentives use the separate wallet or Sickle claim paths described in the
[vfat Quote API](https://quote.vfat.io/openapi.json).

## What it shows

Each of these is one SDK call, and each was broken or missing until recently.

**Farms.** `MainAPI.fetchFarms(chainId)` filtered to Nest. Note the manager address
under each pair: it is never the same as the farm address, and the NFT quote
endpoints answer `400 Farm not supported` without it. `NftPool.fromFarmInfo`
carries it across so you never have to think about it.

**Quoting a deposit.** `NftPool.deposit().withToken().getCallData()` returns
calldata ready for `writeContract`. The SDK asks the API for the approvals you
still owe (`preparePlan`, on by default) and returns them as
`planPreparation.approvals` — the exact token, spender and amount, rather than
you guessing and getting an unexplained `contract_call_failed`.

**Simulation status.** `gasEstimateStatus` says whether the transaction is
expected to go through. Anything other than `success` is worth surfacing;
`contract_call_failed` usually just means one of those approvals is missing.

**Managing an open position.** `PositionsPanel` lists what you hold — from
`MainAPI.fetchUserPositions`, matched against the Nest farm list — and
`ManagePanel` gives each position six actions, one SDK call each:

| Action | Call |
| --- | --- |
| Increase | `pool.increase({ nftId }).withToken(…)` |
| Decrease | `pool.decrease({ nftId, decreasePercentage }).toUnderlying()` |
| Rebalance | `pool.rebalance({ nftId, pricePercentageMargin })` |
| Harvest | `pool.harvest({ nftId })` |
| Compound | `pool.compound({ nftId })` |
| Exit | `pool.exit({ nftId }).toToken(…)` |

A rebalance burns the NFT and mints a new one, so the id changes and the panel
says so before you press the button. Harvest and compound are the two that can
legitimately have nothing to do: the quote API answers `400 No rewards`, so the
panel shows what is actually claimable up front — and distinguishes rewards the
protocol distributes separately, which these actions do not touch.

**Safety properties this page holds, because getting them wrong costs money.**

- *A quote is only valid for the inputs that produced it.* Editing any control
  retires the calldata instead of leaving it behind — quoting a 50% decrease and
  then typing 10 used to submit 50%. An in-flight quote that resolves after you
  switch tabs is inert for the same reason: the response carries the key it was
  requested with. `lib/quote.ts`.
- *Every write is pinned to the demo's selected chain.* Switch the wallet to
  that chain to open the quote and transaction panels. A quote whose returned
  chain differs from the selected chain is discarded.
- *A killed farm hides the deposit, not the position.* Killed farms are still
  loaded and matched, so a holder can see and exit an old NFT; only the picker
  filters them. Filtering earlier made the position disappear along with every
  action that could close it.
- *A reverted transaction is not "Confirmed".* `useWaitForTransactionReceipt`'s
  `isSuccess` only means the receipt query resolved; `receipt.status` is what
  says the chain accepted it. `lib/receipt.ts` acts on each outcome once, from
  an effect rather than from render.

**Rebalance and exit use the quoted mint ticks.** The demo reads the first
quote's range, builds the settings with `buildNftSettings`, and passes both
fixed ticks and the settings to `QuoteAPI.DepositTokenToNft`. It verifies
the final calldata's ticks and settings before offering the deposit. New
rebalance ranges keep the same width. When both actions are on, the demo
places the fixed exit triggers outside the initial range and uses them as
the rebalance cutoffs. `lib/depositQuote.ts` and `lib/automation.ts`.

**A failed send is never silent.** `writeContract` can fail before anything
reaches the chain — a rejection in the wallet, gas estimation reverting on an
insufficient balance — and `useWriteContract`'s `error` is the only place that
shows up. Dropping it makes the button look broken; it is how a real bug here
hid for several runs. `shortWriteError` in `lib/format.ts` pulls the one useful
sentence out of viem's several paragraphs.

**Waiting for the indexer is a poll, not a sleep.** `api.vfat.io` runs a few
seconds behind the chain, so a single refetch after a confirmed write caches
the pre-write answer and never corrects it. Writes open a 30-second window in
which the affected queries re-ask every 3 seconds. `lib/indexing.ts`.

**Gas.** The quote's `gas` is a simulation at quote time, which makes it a lower
bound rather than a limit: a slot that was warm in the simulation can be cold in
the real transaction, and under EIP-150 the innermost call only gets 63/64 of
what is left, so a merely-tight limit surfaces as a revert deep inside the call
tree. Passing the estimate verbatim reverted a deposit here at 950,395 gas with
`ReentrancySentryOOG`; the same deposit then needed 1,301,233. `lib/gas.ts` adds
20% for every write. Unused limit is not charged.

**Automation consent.** HyperEVM and Elysium require per-action consent.
`AutomationPanel` reads the current Sickle approval and on-chain consent mask.
It uses `Automation.buildSetActionConsent` to add the selected action bits
and preserve the rest. Regular Sickle NFT rebalances use `nftRebalanceGeneric`.

## Shape of the code

```
lib/nest.ts             fetching Nest's farms and the caller's positions
lib/chains.ts           wallet definitions for HyperEVM and Elysium
lib/format.ts           display helpers
lib/gas.ts              headroom over the quote's gas estimate
lib/quote.ts            calldata bound to the inputs that produced it
lib/receipt.ts          one-shot, status-aware receipt handling
lib/ticks.ts            quoted mint ranges and exit bands
lib/depositQuote.ts     deposit quotes with verified NFT settings
lib/automation.ts       settings and permission names for each action
lib/indexing.ts         polling a write through the indexer's lag
components/Providers    wagmi, scoped to the demo networks
components/FarmList     the farm picker
components/DepositPanel quote -> approve -> deposit
components/PositionsPanel   the caller's open positions
components/ManagePanel  increase, decrease, rebalance, harvest, compound, exit
components/AutomationPanel  keeper approval and per-action consent
```

Four deliberate choices worth calling out:

- **The wagmi config includes the two demo networks.** HyperEVM uses the SDK
  chain definition, and Elysium uses its public RPC and chain metadata.
- **Quotes are built on an explicit "Get quote" click**, not on every keystroke.
  Quoting per keystroke invites a race where a slow early response overwrites a
  newer one and the Confirm button ends up holding calldata for input the user
  has already changed.
- **Allowances are read from the chain, not from the quote.**
  `planPreparation.allowance` is a snapshot from when the quote was built, and
  the API's view lags a freshly mined approval by a few seconds. The panels poll
  `allowance` directly and stop once it covers the amount, so the Approve button
  turns into the Confirm button on its own.
- **The selected position is derived, not stored.** A rebalance mints a new id
  and an exit removes one, so a stored selection would go dangling exactly when
  the user is looking at it.

Worth knowing if you read positions straight after a write: the data API indexes
a few seconds behind the chain, so the first read back can legitimately return
the pre-write state. The panels poll through that window themselves; Refresh is
there for anything slower than it.

## Contributing

Changes go through a branch and a pull request. `main` is protected with
admin enforcement, so a direct push is refused (`GH006`) rather than relying
on anyone to remember.

CI runs on every push to `main` and every PR, in two jobs:

| Job | What it does | Required to merge |
| --- | --- | --- |
| `check` | `npm ci`, typecheck, lint, build | Yes |
| `audit` | fails on a **critical** advisory in a runtime dependency | Yes |

The advisory gate exists because it was needed. This page shipped `next@16.0.1`
for two commits with an unauthenticated RCE (GHSA-9qr9-h5gf-34mp) while a local
`npm audit` was read from a truncated tail and reported as clean. Verified
against that version: `npm audit --omit=dev --audit-level=critical` exits
non-zero on it. The gate is scoped to criticals and to runtime dependencies, so
it blocks that class without failing a PR over a dev-only moderate — this repo
currently carries high and moderate advisories under the `@reown/appkit` and
`@walletconnect` subtree, on transports the page never instantiates.

One note if you are checking the protection yourself: GitHub hides
`branchProtectionRules` from anyone without admin on the repo, returning an
empty list rather than an error. `GET /repos/{owner}/{repo}/branches/main`
exposes a `protected` boolean that read access can see, and attempting a push
is the only check that does not depend on permissions at all.

### Updating the SDK

`@vfat-io/sickle-sdk` is a normal npm dependency. Move it forward with
`npm install @vfat-io/sickle-sdk@<version>`, then check the demo still
typechecks and builds. Until 1.0.0 a minor version may contain breaking changes,
so read the `CHANGELOG.md` that ships in the package first.

## Safety

This spends real funds on HyperEVM and Elysium mainnet. Deposit,
the six manage actions and the consent button all send real transactions;
everything else is read-only.
