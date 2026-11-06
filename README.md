# Kairos

A local trading journal in an Obsidian vault, plus AI models (Claude Opus 5.5, Fable 5.1, Sonnet 5.5, GPT-6.1 Terra, GPT-6 Astra, Gemini, Grok, all through OpenRouter) that learn from it and **paper trade** crypto. A strategy may only ask for real capital once it beats the marks you set, and you approve every step.

> Real money runs on **Kraken spot** (long only, no leverage), only for strategies whose promotion you approved, and only after you type the strategy name to confirm. Trading can lose money; paper results do not guarantee live results.

## Use it on the web

Open **/app** on the website: no install and no account. The same app and engine run inside your browser.
- **Your vault:** pick your Obsidian folder (Chrome, Edge, Brave) or keep it in the browser. You can export it as a `.zip` to open it in Obsidian.
- **Your data:** your OpenRouter key and notes stay in your browser. Model calls go straight from your browser to OpenRouter.
- **Paper trading** runs while the tab is open. For 24/7 trading and real money on Kraken, use the desktop app.

**Deploying to Netlify:** connect the repository. `netlify.toml` runs `node scripts/build-web.mjs` and publishes `site/`. To offer the free trial on the web, set `KAIROS_FREE_PROXY` in Netlify's environment variables.

## Run it

Needs Node.js 20 or newer. No dependencies to install.

```bash
npm start
```

Then open http://localhost:4317/app. The landing page is at http://localhost:4317/.

### Desktop app

Download the installer from [Releases](https://github.com/neoonchain/agentsIA/releases/latest): `.dmg` (macOS), `.exe` (Windows), `.AppImage` or `.deb` (Linux).

The installers are not code-signed yet:
- **macOS:** right-click the app, choose Open, then Open again.
- **Windows:** in SmartScreen, click More info, then Run anyway.

To sign them, add an Apple Developer ID and a Windows certificate as GitHub secrets.

**Building installers.** The *Desktop installers* GitHub Action builds all three platforms on every push that touches the app. To publish a release, push a tag:

```bash
git tag v0.1.0
```

```bash
git push origin v0.1.0
```

**Local build** (only for the platform you are on):

```bash
cd desktop
npm install
npm run dist
```

During development, `cd desktop && npm start` runs the app in a window without packaging it.

### Tests

```bash
npm test
```

## How it works

- **Vault**: `~/TradingVault` by default (change it in Team settings). Open that folder in Obsidian as a vault. The app creates:
  - `Trades/`: your journal, one note per trade
  - `Strategies/`: strategies the models trade on paper
  - `Psychology/`, `Insights/`
  - `Agents/<strategy>/`: one note per paper trade, with thesis, second opinion and sources
  - `Log/`: every order, block, pause and promotion
  - `rules.md`: your marks and limits; only you edit it
- **Team or Solo** (switch at the top of the app):
  - **Team**: each model takes a role (lead, psychology, scribe, second opinion, charts, plus optional context and sentiment with web search). The reviewer must agree before any paper order.
  - **Solo**: one model of your choice does everything.
- **Brake** is plain code, not a model. It enforces strategy assets and hours, the stop, max risk per trade, the daily loss pause, the max drawdown stop, and one position per asset.
- **Evaluator**: checks paper trades, days, profit factor, max drawdown, adherence to the strategy and net profit against `rules.md`. Only then can you request and approve real capital.
- **Prices**: public Coinbase API (Kraken fallback). Paper fills include fees and slippage from `rules.md`.

## Real money (Kraken)

1. In **Team settings → Kraken**, connect an API key with only *Query Funds*, *Query Open/Closed Orders & Trades*, *Create & Modify Orders* and *Cancel/Close Orders*. The app refuses any key that can withdraw.
2. When a strategy beats your marks, request and approve the promotion. The approved tier (`first_tier_usd`, $250 by default) becomes its real-money allocation.
3. On the strategy page, **Go live · validate mode**: Kraken checks every order but executes nothing, and fills are simulated at the live bid/ask. Use it to confirm everything works.
4. **Go live · real money**, typing the strategy name to confirm. From then on:
   - **Orders:** market buys sized so the loss at the stop is the strategy's risk on the allocation, capped by the allocation and your USD balance.
   - **Stops:** every buy is followed immediately by a **stop-loss order on Kraken**, so it protects you even if the app is closed. If placing the stop fails, the position is sold straight back.
   - **Exits:** take profit is watched by the app; reaching it cancels the stop and sells. If a stop disappears on Kraken, the position is sold.
   - **Brake checks before each buy:** long only, `min_24h_volume_usd` and `max_spread_pct`, which matter most for memecoins. Daily-loss pause and max-drawdown stop on the allocation; the drawdown stop sells everything and sends the strategy back to paper.
5. **Back to paper** closes every live position at market.

**Assets:** anything Kraken lists against USD, written as `BASE-USD`. That covers BTC, ETH and SOL, and memecoins such as DOGE, SHIB, PEPE, BONK, WIF, FLOKI, TRUMP and PENGU. Tokens that only trade on decentralized exchanges (pump.fun and similar) are not available.

## API keys and the free trial

- Each user can add their own **OpenRouter** key in Team settings. It is stored in `~/.kairos/config.json` (mode 600), never in the vault, and calls go straight to OpenRouter.
- **Free trial**: users without a key get **2 free instructions** (Ask or Analyse) through the free-trial proxy in [`proxy/`](proxy/README.md). The proxy holds your OpenRouter key on your server, so it never ships inside the app, and it counts usage server-side.
  - Point the app at your proxy with `KAIROS_FREE_PROXY=https://…`, or set `DEFAULT_FREE_PROXY` in `src/lib/config.js` before building the desktop app.
- Paper trading always needs the user's own key, because it runs on a schedule.

## Development

`KAIROS_LLM=mock npm start` replaces the models with fake answers, so you can click through the whole app without spending credits. Never use it for real.
