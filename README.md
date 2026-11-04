# agentsIA — landing

Single-file landing page (`index.html`, HTML + CSS + vanilla JS, no build step) modelled on the layout of an "intent workspace" for on-chain AI agents.

Open `index.html` in a browser, or serve it:

```bash
python3 -m http.server 8000
```

## Interactive parts

- Animated pixel wave on canvas (hero and footer)
- Asset and agent marquee (pauses on hover)
- Agent session terminal that steps through each line
- "The Guard": 6 scenarios that re-render the planbook checks and the wires
- 9 rules with animated SVG illustrations
- Step grid (done / sign / next) that advances on its own
- Copy-to-clipboard for addresses, scroll reveals, counters
- Responsive down to 390px; honours `prefers-reduced-motion`

All addresses are placeholders (`0x000…0001`, etc.) and "Connect" is not wired to a real wallet.
