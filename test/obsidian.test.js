process.env.KAIROS_EXAMPLES = '0';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The vault must open cleanly in Obsidian: portable file names, properties Obsidian can read,
// and every [[link]] / ![[embed]] resolving to a file in the vault.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kairos-obsidian-'));
process.env.KAIROS_VAULT = path.join(tmp, 'vault'); process.env.KAIROS_HOME = path.join(tmp, 'home');
const { App } = await import('../src/lib/core.js');
const V = await import('../src/lib/vault.js');
const { parse } = await import('../src/lib/frontmatter.js');

function walk(root) { const out = []; (function w(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (e.name.startsWith('.')) continue; const f = path.join(d, e.name); e.isDirectory() ? w(f) : out.push(f); } })(root); return out; }

test('a seeded vault (examples, charts, strategies, lessons, a chat) is valid for Obsidian', async () => {
  process.env.KAIROS_EXAMPLES = '1';
  const app = new App(); await app.chartsReady;
  process.env.KAIROS_EXAMPLES = '0';
  app.saveChatTurn(null, 'Where do I lose the most money?', 'Mostly on ETH breakouts: see [[Range breakout]] and [[An invented note]].', 'Claude Opus 5.5');
  const files = walk(app.vault), names = V.vaultNames(app.vault);
  assert.ok(files.length > 60, `only ${files.length} files`);
  for (const f of files) {
    const name = path.basename(f);
    assert.doesNotMatch(name, /[\\:*?"<>|#^[\]]/, `${name}: character Obsidian or Windows rejects`);
    assert.doesNotMatch(name.replace(/\.[^.]+$/, ''), /[. ]$/, `${name}: ends in a dot or space`);
    if (!f.endsWith('.md')) continue;
    const text = fs.readFileSync(f, 'utf8');
    if (text.startsWith('---\n')) {
      assert.ok(text.indexOf('\n---', 4) > 0, `${name}: frontmatter not closed`);
      const { data } = parse(text);
      if ('tags' in data) assert.ok(Array.isArray(data.tags) && data.tags.every(t => /^[\p{L}\p{N}_\-/]+$/u.test(t)), `${name}: tags ${JSON.stringify(data.tags)}`);
      if (data.image) assert.ok(fs.existsSync(path.join(app.vault, data.image)), `${name}: image ${data.image} missing`);
    }
    if (f.includes(`${path.sep}Chats${path.sep}`)) assert.doesNotMatch(text, /\[\[An invented note\]\]/, 'model-made links to missing notes are unlinked');
    for (const m of text.matchAll(/!?\[\[([^\]|#]+)/g)) {
      const t = m[1].trim().toLowerCase();
      assert.ok(names.has(t) || names.has(t.split('/').pop()), `${path.relative(app.vault, f)}: [[${m[1]}]] does not resolve`);
    }
  }
});
