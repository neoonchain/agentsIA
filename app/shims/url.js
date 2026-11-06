// Browser stand-in for node:url.
export const fileURLToPath = u => new URL(u).pathname;
export const pathToFileURL = p => new URL('file://' + p);
export default { fileURLToPath, pathToFileURL };
