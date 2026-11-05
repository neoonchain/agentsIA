// Browser stand-in for node:crypto. Signing is only needed for Kraken private calls, which the web app never makes.
const unavailable = () => { throw new Error('Real money runs only in the desktop app'); };
export const randomUUID = () => globalThis.crypto.randomUUID();
export const createHash = unavailable;
export const createHmac = unavailable;
export default { randomUUID, createHash, createHmac };
