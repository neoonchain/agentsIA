// Wallet login and the KAIROS holding check, with no crypto library: Elysium's own node hashes the message (web3_sha3)
// and recovers the signer through the ecrecover precompile, and an ERC-20 balanceOf call reads the holding.
// Works from Node (the local app) and from the browser (the web app): the public RPC allows any origin.

export async function rpc(url, method, params) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(10000) });
  const j = await r.json();
  if (j.error) throw new Error(`RPC ${method}: ${j.error.message || 'error'}`);
  return j.result;
}

const utf8Hex = s => '0x' + [...new TextEncoder().encode(s)].map(b => b.toString(16).padStart(2, '0')).join('');
export const isAddress = a => typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a);

/** The text the user signs: what it is, which wallet, a one-time code. Signing costs nothing and moves nothing. */
export function loginMessage(address, nonce, issuedAt = new Date().toISOString()) {
  return `Kairos wants you to sign in with your wallet:\n${address}\n\nThis proves the wallet is yours. It costs nothing and moves no funds.\n\nNonce: ${nonce}\nIssued at: ${issuedAt}`;
}

/** The address that signed `message` with personal_sign (EIP-191), or null. */
export async function recoverSigner(url, message, signature) {
  const sig = String(signature || '').replace(/^0x/, '');
  if (!/^[0-9a-fA-F]{130}$/.test(sig)) return null;
  const bytes = new TextEncoder().encode(message);
  const hash = await rpc(url, 'web3_sha3', [utf8Hex(`\x19Ethereum Signed Message:\n${bytes.length}`) + utf8Hex(message).slice(2)]);
  let v = parseInt(sig.slice(128, 130), 16); if (v < 27) v += 27;
  const data = hash.slice(2) + v.toString(16).padStart(64, '0') + sig.slice(0, 64) + sig.slice(64, 128);
  const out = await rpc(url, 'eth_call', [{ to: '0x0000000000000000000000000000000000000001', data: '0x' + data }, 'latest']);
  const addr = '0x' + String(out).slice(-40);
  return out && out !== '0x' && !/^0x0{40}$/.test(addr) ? addr.toLowerCase() : null;
}

/** ERC-20 balance as a number of whole tokens. */
export async function tokenBalance(url, token, owner) {
  const pad = a => a.toLowerCase().replace(/^0x/, '').padStart(64, '0');
  const [bal, dec] = await Promise.all([
    rpc(url, 'eth_call', [{ to: token, data: '0x70a08231' + pad(owner) }, 'latest']),
    rpc(url, 'eth_call', [{ to: token, data: '0x313ce567' }, 'latest']),
  ]);
  const decimals = Number(BigInt(dec || '0x12')), raw = BigInt(bal || '0x0');
  return Number(raw) / 10 ** decimals;
}
