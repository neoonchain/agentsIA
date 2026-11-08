// Compiles src/*.sol with solc (0.8.28, optimizer on) into out/<Name>.json { abi, bytecode }.
import fs from 'node:fs';
import solc from 'solc';
const src = Object.fromEntries(fs.readdirSync(new URL('../src', import.meta.url)).filter(f => f.endsWith('.sol')).map(f => [f, { content: fs.readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8') }]));
const out = JSON.parse(solc.compile(JSON.stringify({ language: 'Solidity', sources: src, settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: 'cancun', outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } } })));
const errors = (out.errors || []).filter(e => e.severity === 'error');
for (const e of out.errors || []) console.error(e.formattedMessage);
if (errors.length) process.exit(1);
fs.mkdirSync(new URL('../out', import.meta.url), { recursive: true });
for (const [file, contracts] of Object.entries(out.contracts)) for (const [name, c] of Object.entries(contracts)) {
  fs.writeFileSync(new URL(`../out/${name}.json`, import.meta.url), JSON.stringify({ abi: c.abi, bytecode: '0x' + c.evm.bytecode.object }, null, 1));
  console.log(`compiled ${file}:${name} · ${c.evm.bytecode.object.length / 2} bytes`);
}
