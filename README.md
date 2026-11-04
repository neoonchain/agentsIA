# agentsIA

A local trading journal in an Obsidian vault, plus AI models (Claude Opus 5.5, Fable 5.1, Sonnet 5.5, GPT-6.1 Terra, GPT-6 Astra, Gemini, Grok, all through OpenRouter) that learn from it and **paper trade** crypto. A strategy may only ask for real capital once it beats the marks you set, and you approve every step.

> **This version is paper only.** Approving a promotion is recorded, but no real-money orders are placed.

## Run it

Needs Node.js 20 or newer. No dependencies to install.

```bash
npm start
```

Then open http://localhost:4317/app. The landing page is at http://localhost:4317/.

### Desktop app

```bash
cd desktop
npm install
npm start
```

This opens the same app in its own window (Electron), on a free port.

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

## API keys and the free trial

- Each user adds their own **OpenRouter** key in Team settings. It is stored in `~/.agentsia/config.json` (mode 600), never in the vault.
- **Free trial**: if the app is started with `AGENTSIA_FREE_KEY=<operator OpenRouter key>`, users without a key get **2 free instructions** (Ask or Analyse). From the 3rd on they need their own key. Paper trading always needs the user's own key, because it runs on a schedule and would use up a shared key.
- ⚠️ In a local or desktop app, a key shipped inside the app can be extracted by the user. Before distributing it, put the free key behind a small proxy server you control, with per-user limits.

## Development

`AGENTSIA_LLM=mock npm start` replaces the models with fake answers, so you can click through the whole app without spending credits. Never use it for real.
