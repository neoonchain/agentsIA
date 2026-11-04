# agentsIA — landing

Landing page for agentsIA: a local, Obsidian-based trading journal where a team of AI models (Claude Opus 5.5, Fable 5.1, Sonnet 5.5, GPT, Gemini, Astra, Grok) learns from your logged trades together, prove themselves in paper trading, and only get real capital once they beat the marks you set.

Single file (`index.html`, HTML + CSS + vanilla JS, no build step). Open it in a browser, or:

```bash
python3 -m http.server 8000
```

## Sections

1. Hero + "works with" marquee
2. **The vault** — interactive Obsidian-style preview: click trade, strategy and psychology notes (frontmatter, thesis, psychology, went well / went wrong)
3. **Agents** — seven models working as one team, each in the role it does best; every trade needs a second model to agree. Brake (risk) is plain code, not a model
4. **Promotion** — 7 interactive cases of the paper → real evaluator (passes, models disagree, drawdown too deep, too few trades, off-strategy, daily loss hit live, user kill switch)
5. **Rules** — 9 rules with animated SVGs (trial period, max drawdown, strategy scope, capital tiers, daily loss, traceable decisions, manual approval, trade-only keys, markdown log)
6. **Your control** — milestone path and what agents can never do
7. **How it works** — journal → learn → paper → real money
8. **The team** — each model's role and who it hands work to, plus the user's stack
9. **Real money** + risk warning

All figures are illustrative examples. Responsive down to 390px; honours `prefers-reduced-motion`.
