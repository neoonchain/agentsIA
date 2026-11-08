# KairosGuard

Brake as a contract on [Elysium](https://elysium.kinetiq.xyz/docs), Kinetiq's Layer 2 for Hyperliquid. The Kairos agent proposes orders; the contract checks each one against limits only the owner can change, and is the only path an order can take. Every decision, accepted order, rejection and result is an event, so the record can be checked by anyone.

**Status: unaudited, testnet only.** Any version that routes real orders will be audited first.

## What it enforces

- **Roles.**
  - The **owner** (your wallet) sets the limits, the allowed markets, the agent and the router, and is the only one who can resume after a pause.
  - The **agent** (the Kairos app's key) can propose orders, log decisions and pause. It can't do anything else.
- **Limits.** Risk per order (size × distance to the stop), maximum order size, the stop on the correct side, maximum open positions, one position per market, daily loss (reset at each UTC day) and maximum drawdown from the peak (reaching it pauses the Guard by itself).
- **The record.**
  - **`Decision`:** a hash of the decision note the app keeps (holds included).
  - **`OrderAccepted` / `OrderRejected`:** every proposed order, with the reason when the Guard blocks it.
  - **`Settled`:** the result of each accepted order, counted once even if the callback repeats.

## Paper mode now, HyperCore later

Elysium's `ElysiumCoreWriter` predeploy will place orders on your own HyperCore account through a trade-only agent that cannot withdraw. Its interface hasn't been published yet: it ships in an ArbOS upgrade about four weeks after mainnet. Until then the router is unset and the Guard runs in **paper mode**: every order is checked and recorded on-chain, and nothing is sent. In paper mode the agent reports results itself, so those results are only as reliable as the app that sends them.

When the interface is published, a small adapter implementing `IOrderRouter` will be connected with `setRouter`. From then on only the router can report results.

## Use it

```bash
npm install
npm test
```

`npm test` compiles with solc 0.8.28 and runs the tests on a local EVM: roles, every limit, rejections, settlement, the daily reset, the drawdown pause and routing.

To deploy to the Elysium testnet (chain 99801), first fund a testnet-only key with testnet HYPE from the [faucet](https://testnet.elysium.kinetiq.xyz/faucet), then run:

```bash
DEPLOYER_KEY=0x... OWNER=0xYourWallet node scripts/deploy.mjs
```

The address is saved in `deployments/elysium-testnet.json`.
