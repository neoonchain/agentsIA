# agentsIA — landing

Landing page for agentsIA: a local, Obsidian-based trading journal where AI agents learn from your logged trades, prove themselves in paper trading, and only get real capital once they beat the marks you set.

Single file (`index.html`, HTML + CSS + vanilla JS, no build step). Open it in a browser, or:

```bash
python3 -m http.server 8000
```

## Sections

1. Hero + "works with" marquee
2. **The vault** — interactive Obsidian-style preview: click trade, strategy and psychology notes (frontmatter, thesis, psychology, went well / went wrong)
3. **Agents** — Scribe (logs), Lens (analyses), Pulse (trades), Brake (risk); multiple models can compete
4. **Promotion** — 6 interactive cases of the paper → real evaluator (passes, drawdown too deep, too few trades, off-strategy, daily loss hit live, user kill switch)
5. **Rules** — 9 rules with animated SVGs (trial period, max drawdown, strategy scope, capital tiers, daily loss, traceable decisions, manual approval, trade-only keys, markdown log)
6. **Your control** — milestone path and what agents can never do
7. **How it works** — journal → learn → paper → real money
8. **The league** — agent leaderboard and the user's stack
9. **Real money** + risk warning

All figures are illustrative examples. Responsive down to 390px; honours `prefers-reduced-motion`.
