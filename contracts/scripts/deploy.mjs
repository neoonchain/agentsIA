// Deploys KairosGuard to Elysium testnet (chain 99801), allows the markets, and optionally hands ownership to your wallet.
//   DEPLOYER_KEY=0x...         key that pays the gas (testnet HYPE from https://testnet.elysium.kinetiq.xyz/faucet)
//   OWNER=0x...  (optional)    your wallet: becomes the owner (limits, markets, router, unpause)
//   AGENT=0x...  (optional)    the Kairos app's key that proposes orders; default: the deployer
//   RPC=...      (optional)    default https://testnet-rpc.elysium.kinetiq.xyz
//   node scripts/deploy.mjs
import fs from 'node:fs';
import { JsonRpcProvider, Wallet, ContractFactory, Contract, keccak256, toUtf8Bytes } from 'ethers';

const RPC = process.env.RPC || 'https://testnet-rpc.elysium.kinetiq.xyz', CHAIN = 99801;
if (!process.env.DEPLOYER_KEY) { console.error('Set DEPLOYER_KEY (a testnet-only key funded with testnet HYPE).'); process.exit(1); }
const provider = new JsonRpcProvider(RPC, CHAIN), wallet = new Wallet(process.env.DEPLOYER_KEY, provider);
const art = JSON.parse(fs.readFileSync(new URL('../out/KairosGuard.json', import.meta.url)));
const agent = process.env.AGENT || wallet.address;
// Kairos's default rules: 3% risk per order, 6% daily loss, 25% drawdown, 9 open positions (Dip buyer 4 + Trend rider 5),
// $5,000 max order, on a $10,000 paper account.
const limits = [300, 600, 2500, 9, 5000n * 10n ** 6n], equity = 10000n * 10n ** 6n;
const MARKETS = ['BTC-PERP', 'ETH-PERP', 'SOL-PERP', 'XRP-PERP', 'DOGE-PERP', 'ADA-PERP', 'LINK-PERP', 'LTC-PERP', 'XYZ100-XYZ', 'SP500-XYZ', 'GOLD-XYZ'];

const bal = await provider.getBalance(wallet.address);
console.log(`deployer ${wallet.address} · balance ${Number(bal) / 1e18} HYPE · chain ${(await provider.getNetwork()).chainId}`);
if (bal === 0n) { console.error('The deployer has no testnet HYPE yet: use the faucet, then run this again.'); process.exit(1); }

const guard = await new ContractFactory(art.abi, art.bytecode, wallet).deploy(agent, limits, equity);
await guard.waitForDeployment();
const address = await guard.getAddress();
console.log('KairosGuard deployed at', address);
for (const m of MARKETS) { const tx = await guard.setMarket(keccak256(toUtf8Bytes(m)), true); await tx.wait(); }
console.log('markets allowed:', MARKETS.join(', '));
if (process.env.OWNER) { await (await guard.transferOwnership(process.env.OWNER)).wait(); console.log('ownership transferred to', process.env.OWNER); }
const out = { network: 'elysium-testnet', chainId: CHAIN, address, owner: process.env.OWNER || wallet.address, agent, limits: { maxRiskBps: 300, maxDailyLossBps: 600, maxDrawdownBps: 2500, maxOpenPositions: 9, maxOrderUsd: 5000 }, startEquityUsd: 10000, markets: MARKETS, deployedAt: new Date().toISOString(), explorer: `https://elysium.kinetiq.xyz/testnet-explorer/address/${address}` };
fs.mkdirSync(new URL('../deployments', import.meta.url), { recursive: true });
fs.writeFileSync(new URL('../deployments/elysium-testnet.json', import.meta.url), JSON.stringify(out, null, 2) + '\n');
console.log('saved deployments/elysium-testnet.json');
