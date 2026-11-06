// Daily candles (Coinbase, 300 per request) for the 8 coins of runs 7-9, June 2018 to today, oldest first: writes daily-long.json.
import fs from 'node:fs';
const COINS = ['BTC-USD', 'ETH-USD', 'SOL-USD', 'XRP-USD', 'DOGE-USD', 'ADA-USD', 'LINK-USD', 'LTC-USD'];
const START = Date.parse('2018-06-01T00:00:00Z'), END = Math.floor(Date.now() / 86400000) * 86400000, D = 86400000, out = {};
for (const a of COINS) {
  const rows = new Map();
  for (let t = START; t < END; t += 300 * D) {
    const s = new Date(t).toISOString(), e = new Date(Math.min(END, t + 300 * D)).toISOString();
    for (let k = 0; k < 4; k++) {
      const r = await fetch(`https://api.exchange.coinbase.com/products/${a}/candles?granularity=86400&start=${s}&end=${e}`);
      if (r.ok) { for (const [ts, low, high, open, close, volume] of await r.json()) rows.set(ts * 1000, { t: ts * 1000, open, high, low, close, volume }); break; }
      await new Promise(z => setTimeout(z, 1500 * (k + 1)));
    }
    await new Promise(z => setTimeout(z, 250));
  }
  out[a] = [...rows.values()].sort((x, y) => x.t - y.t);
  console.log(a, out[a].length, new Date(out[a][0].t).toISOString().slice(0, 10), '→', new Date(out[a].at(-1).t).toISOString().slice(0, 10));
}
fs.writeFileSync('daily-long.json', JSON.stringify(out));
