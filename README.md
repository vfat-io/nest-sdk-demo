# Nest × vfat SDK

A working example of opening and managing a [Nest](https://app.usenest.xyz)
position through [`@vfat-io/sickle-sdk`](https://www.npmjs.com/package/@vfat-io/sickle-sdk).

Everything on the page comes from the live vfat API — the farm list, the quote,
the approvals and the automation state. It connects a real wallet to HyperEVM
and sends real transactions.

## Running it

```bash
npm install
npm run dev
```

Then open http://localhost:3000 and connect an injected wallet (MetaMask,
Rabby, …) on HyperEVM.

The SDK is an ordinary npm dependency, so installing needs nothing but the
public npm registry.

## What it shows

Each of these is one SDK call, and each was broken or missing until recently.

**Farms.** `MainAPI.fetchFarms(999)` filtered to Nest. Note the manager address
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
- *Every write is pinned to chain 999.* `writeContract` without `chainId` uses
  whatever chain the wallet is on, which would send HyperEVM calldata to
  whatever occupies those addresses elsewhere. The panels are also hidden off
  HyperEVM, so there is nothing to press.
- *A killed farm hides the deposit, not the position.* Killed farms are still
  loaded and matched, so a holder can see and exit an old NFT; only the picker
  filters them. Filtering earlier made the position disappear along with every
  action that could close it.
- *A reverted transaction is not "Confirmed".* `useWaitForTransactionReceipt`'s
  `isSuccess` only means the receipt query resolved; `receipt.status` is what
  says the chain accepted it. `lib/receipt.ts` acts on each outcome once, from
  an effect rather than from render.

**Auto-exit ticks come from the quote, not from a cached tick.** Quoting a
deposit reveals the exact range it will mint — the API puts it in the calldata
at `addLiquidityParams.tickLower/tickUpper` — so the trigger is derived from
*that*, with one tick spacing of clearance, and then checked against the range
the final calldata mints before the button appears. In range means no exit; a
tick outside means exit, and the panel shows both numbers before you sign.

Two weaker versions came before it. One absolute tick pair cannot work across
pools at all: Nest's farms span roughly -388673 to 264454, so a fixed low tick
sits above spot for some of them and a fresh position is immediately
exit-eligible. Deriving from `farm.pool.tick` is better but still wrong — that
tick is whatever `/v4/farms` returned when the page loaded, so on a page left
open the trigger ends up centred on a stale spot while the position is minted
around the current one, and a band-width buffer only buys about 1% of drift
before the trigger falls *inside* the position it is supposed to contain.
`lib/ticks.ts`.

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

**Automation consent.** HyperEVM sets `sickle.automationRequiresConsent`, which
means the keeper reverts `ActionNotConsented` until the Sickle owner has
consented — silently, as far as the user can tell. `AutomationPanel` reads the
current mask and builds the `setActionConsent` call with
`Automation.buildSetActionConsent`. That helper ORs into the existing mask,
because `setActionConsent` overwrites it and a naive call would revoke consent
the user had already given.

## Shape of the code

```
lib/nest.ts             fetching Nest's farms and the caller's positions
lib/format.ts           display helpers
lib/gas.ts              headroom over the quote's gas estimate
lib/quote.ts            calldata bound to the inputs that produced it
lib/receipt.ts          one-shot, status-aware receipt handling
lib/ticks.ts            auto-exit range derived from the quote's own calldata
lib/indexing.ts         polling a write through the indexer's lag
components/Providers    wagmi, scoped to HyperEVM only
components/FarmList     the farm picker
components/DepositPanel quote -> approve -> deposit
components/PositionsPanel   the caller's open positions
components/ManagePanel  increase, decrease, rebalance, harvest, compound, exit
components/AutomationPanel  consent state and the consent call
```

Four deliberate choices worth calling out:

- **The wagmi config names HyperEVM directly** rather than passing the SDK's
  `supportedChains`, which carries every chain viem knows about. Nest is on one
  chain; there is no reason to ship 660.
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

This spends real funds on HyperEVM mainnet. There is no testnet mode. Deposit,
the six manage actions and the consent button all send real transactions;
everything else is read-only.
