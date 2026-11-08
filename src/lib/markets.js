// Human names for market ids. The ids stay as they are in strategy notes and code (XYZ100-XYZ, CL-XYZ, KPEPE-PERP);
// screens and the models' prompts show the real name next to them. Used by the app (browser) and by core (prompts).
const XYZ = {
  XYZ100: 'Nasdaq 100', SP500: 'S&P 500', JP225: 'Nikkei 225', KR200: 'KOSPI 200', NIFTY: 'Nifty 50',
  GOLD: 'Gold', SILVER: 'Silver', PLATINUM: 'Platinum', PALLADIUM: 'Palladium', COPPER: 'Copper',
  CL: 'Oil (WTI)', BRENTOIL: 'Oil (Brent)', NATGAS: 'Natural gas', HO: 'Heating oil',
  EUR: 'Euro', JPY: 'Japanese yen', GBP: 'British pound',
  TSLA: 'Tesla', NVDA: 'Nvidia', AAPL: 'Apple', MSFT: 'Microsoft', GOOGL: 'Alphabet', AMZN: 'Amazon', META: 'Meta',
  NFLX: 'Netflix', AMD: 'AMD', INTC: 'Intel', TSM: 'TSMC', AVGO: 'Broadcom', ASML: 'ASML', ARM: 'Arm', QCOM: 'Qualcomm',
  MU: 'Micron', AMAT: 'Applied Materials', LRCX: 'Lam Research', MRVL: 'Marvell', DELL: 'Dell', IBM: 'IBM', ORCL: 'Oracle',
  NOW: 'ServiceNow', NET: 'Cloudflare', CRWD: 'CrowdStrike', PLTR: 'Palantir', COIN: 'Coinbase', HOOD: 'Robinhood',
  MSTR: 'Strategy (MicroStrategy)', CRCL: 'Circle', RDDT: 'Reddit', COST: 'Costco', LLY: 'Eli Lilly', MRNA: 'Moderna',
  BABA: 'Alibaba', RIVN: 'Rivian', GME: 'GameStop', DKNG: 'DraftKings', HIMS: 'Hims & Hers', RKLB: 'Rocket Lab',
  EBAY: 'eBay', ZM: 'Zoom', NOK: 'Nokia', SNDK: 'SanDisk', WDC: 'Western Digital', IREN: 'IREN', CVX: 'Chevron',
  BX: 'Blackstone', ICE: 'Intercontinental Exchange', SMSN: 'Samsung', HYUNDAI: 'Hyundai', SOFTBANK: 'SoftBank',
  KIOXIA: 'Kioxia', RELIANCE: 'Reliance', SKHX: 'SK Hynix', SKHY: 'SK Hynix',
  SMH: 'Semiconductor ETF', SOXL: 'Semiconductors 3x ETF', XLE: 'Energy ETF', XBI: 'Biotech ETF', TLT: 'US Treasuries 20y+ ETF',
  EWY: 'South Korea ETF', EWJ: 'Japan ETF', EWZ: 'Brazil ETF', EWT: 'Taiwan ETF', URNM: 'Uranium miners ETF', MAGS: 'Magnificent 7 ETF',
};
const CRYPTO = {
  BTC: 'Bitcoin', ETH: 'Ethereum', SOL: 'Solana', XRP: 'XRP', DOGE: 'Dogecoin', ADA: 'Cardano', LINK: 'Chainlink', LTC: 'Litecoin',
  HYPE: 'Hyperliquid', PEPE: 'PEPE', SHIB: 'Shiba Inu', BONK: 'Bonk', WIF: 'dogwifhat', FLOKI: 'Floki', POPCAT: 'Popcat',
  BRETT: 'Brett', MOODENG: 'Moo Deng', PENGU: 'Pudgy Penguins', FARTCOIN: 'Fartcoin', TRUMP: 'Official Trump',
};

/** "XYZ100-XYZ" -> "Nasdaq 100", "KPEPE-PERP" -> "PEPE ×1000", "BTC-USD" -> "Bitcoin". Unknown ids come back unchanged. */
export function marketName(id) {
  const [base, quote] = String(id || '').toUpperCase().split('-');
  if (quote === 'XYZ') return XYZ[base] || base;
  if (/^K[A-Z]{3,}$/.test(base) && CRYPTO[base.slice(1)]) return `${CRYPTO[base.slice(1)]} ×1000`;
  return CRYPTO[base] || base || String(id || '');
}

/** Where it trades: "Spot", "Hyperliquid perp" or "Hyperliquid · Trade.xyz". */
export function marketVenue(id) {
  const quote = String(id || '').toUpperCase().split('-')[1];
  return quote === 'PERP' ? 'Hyperliquid perp' : quote === 'XYZ' ? 'Hyperliquid · Trade.xyz' : 'Spot';
}
