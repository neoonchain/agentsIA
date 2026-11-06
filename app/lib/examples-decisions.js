// The 10 decisions of Kairos paper test 4 (Range breakout on BTC, ETH and SOL, 18-25 Sep 2026), with the prices at each
// moment. Shown as an example decision history before a strategy has made decisions of its own.
export const RUN4_DECISIONS = [
 {
  "at": "2026-09-18T09:00:00.000Z",
  "action": "open",
  "asset": "SOL-USD",
  "side": "long",
  "stop": 102.4,
  "takeProfit": 116.2,
  "riskPct": 1,
  "thesis": "SOL closed above its 5-day high 104.90 at 03h on 2.4x volume, new high at 09h on 1.6x; BTC and ETH confirm (+2-3% 24h). Stop 102.4 under the breakout base (3.7%), target 2.5R.",
  "outcome": "opened",
  "entry": 106.37,
  "context": {
   "prices": {
    "BTC-USD": 78148.1,
    "ETH-USD": 2505.76,
    "SOL-USD": 106.32
   }
  }
 },
 {
  "at": "2026-09-18T21:00:00.000Z",
  "action": "move_stop",
  "asset": "SOL-USD",
  "side": null,
  "stop": 108.5,
  "takeProfit": null,
  "riskPct": null,
  "thesis": "+1.7R after a market-wide move on 3-5x volume (lesson 4: protect at +1R). Stop to 108.5, above entry plus fees, under the 13h breakout candle body. Target 116.2 stays.",
  "outcome": "stop moved",
  "entry": null,
  "context": {
   "prices": {
    "BTC-USD": 81223.8,
    "ETH-USD": 2626.27,
    "SOL-USD": 113.17
   }
  }
 },
 {
  "at": "2026-09-19T09:00:00.000Z",
  "action": "hold",
  "asset": null,
  "side": null,
  "stop": null,
  "takeProfit": null,
  "riskPct": null,
  "thesis": "Bull flag after the impulse: tight range, volume 0.3-0.6x. Stop already locks profit; let the 116.2 target work.",
  "outcome": "hold",
  "entry": null,
  "context": {
   "prices": {
    "BTC-USD": 81298.8,
    "ETH-USD": 2640.19,
    "SOL-USD": 111.79
   }
  }
 },
 {
  "at": "2026-09-19T21:00:00.000Z",
  "action": "hold",
  "asset": null,
  "side": null,
  "stop": null,
  "takeProfit": null,
  "riskPct": null,
  "thesis": "SOL slipping to the flag low on 0.8-1.1x volume, no panic volume. The protected stop at 108.5 decides; no reason to override the plan.",
  "outcome": "hold",
  "entry": null,
  "context": {
   "prices": {
    "BTC-USD": 81063.7,
    "ETH-USD": 2627.16,
    "SOL-USD": 110.5
   }
  }
 },
 {
  "at": "2026-09-20T09:00:00.000Z",
  "action": "hold",
  "asset": null,
  "side": null,
  "stop": null,
  "takeProfit": null,
  "riskPct": null,
  "thesis": "Just stopped out in profit; market drifting lower on 0.5x volume. No setup; no re-entry without a fresh close above structure on volume.",
  "outcome": "hold",
  "entry": null,
  "context": {
   "prices": {
    "BTC-USD": 80430,
    "ETH-USD": 2578.8,
    "SOL-USD": 108.25
   }
  }
 },
 {
  "at": "2026-09-20T21:00:00.000Z",
  "action": "hold",
  "asset": null,
  "side": null,
  "stop": null,
  "takeProfit": null,
  "riskPct": null,
  "thesis": "Range 80.1k-81.9k BTC, 2563-2667 ETH, 107.3-114.6 SOL, all mid-range on 0.5-0.6x volume. Wait for a close outside on volume.",
  "outcome": "hold",
  "entry": null,
  "context": {
   "prices": {
    "BTC-USD": 80920.3,
    "ETH-USD": 2630.59,
    "SOL-USD": 109.88
   }
  }
 },
 {
  "at": "2026-09-21T09:00:00.000Z",
  "action": "open",
  "asset": "BTC-USD",
  "side": "long",
  "stop": 81600,
  "takeProfit": 92200,
  "riskPct": 1,
  "thesis": "BTC closed above its 3-day range top 81925 at 08h on 3.8x volume and 09h on 4.3x; ETH and SOL confirm. Breakout is 2h old, not chased. Stop 81600 under the breakout candle (3.6%), target 2.6R.",
  "outcome": "opened",
  "entry": 84678,
  "context": {
   "prices": {
    "BTC-USD": 84635.5,
    "ETH-USD": 2720.01,
    "SOL-USD": 115.91
   }
  }
 },
 {
  "at": "2026-09-21T21:00:00.000Z",
  "action": "hold",
  "asset": null,
  "side": null,
  "stop": null,
  "takeProfit": null,
  "riskPct": null,
  "thesis": "BTC +0.6R, higher highs and higher lows on 2x volume. Below the +1R protect line; keep the original stop and target.",
  "outcome": "hold",
  "entry": null,
  "context": {
   "prices": {
    "BTC-USD": 86557.3,
    "ETH-USD": 2768.01,
    "SOL-USD": 119.11
   }
  }
 },
 {
  "at": "2026-09-22T09:00:00.000Z",
  "action": "hold",
  "asset": null,
  "side": null,
  "stop": null,
  "takeProfit": null,
  "riskPct": null,
  "thesis": "BTC holding above the breakout (6h lows 85059-85265, well over the old 81925 top) on 1.7x volume. Healthy pause; hold.",
  "outcome": "hold",
  "entry": null,
  "context": {
   "prices": {
    "BTC-USD": 86238.8,
    "ETH-USD": 2750.21,
    "SOL-USD": 117.43
   }
  }
 },
 {
  "at": "2026-09-22T21:00:00.000Z",
  "action": "move_stop",
  "asset": "BTC-USD",
  "side": null,
  "stop": 84000,
  "takeProfit": null,
  "riskPct": null,
  "thesis": "Last decision before 2 unattended days. Stop to 84000, under every 6h low since the breakout (84110): a failed breakout now costs ~0.2R instead of 1R. Target 92200 stays.",
  "outcome": "stop moved",
  "entry": null,
  "context": {
   "prices": {
    "BTC-USD": 86187,
    "ETH-USD": 2747.31,
    "SOL-USD": 118.1
   }
  }
 }
];
