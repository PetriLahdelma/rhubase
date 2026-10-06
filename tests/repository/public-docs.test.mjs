import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const listing = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: repository, encoding: 'utf8' });
assert.equal(listing.status, 0, listing.stderr);
const publicMarkdown = listing.stdout.split('\0').filter((file) => file.endsWith('.md')).sort();

function localReferences(markdown) {
  const prose = markdown.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '');
  const values = [];
  for (const match of prose.matchAll(/!?(?:\[[^\]]*\])\((?:<([^>]+)>|([^\s)]+))(?:\s+["'][^"']*["'])?\)/g)) values.push(match[1] ?? match[2]);
  for (const match of prose.matchAll(/\b(?:src|srcset)=["']([^"']+)["']/g)) {
    for (const part of match[1].split(',').map((value) => value.trim().split(/\s+/)[0])) values.push(part);
  }
  return values.filter((value) => !/^(?:https?:|mailto:|#)/i.test(value));
}

test('public documentation links resolve within the repository', async () => {
  for (const relative of publicMarkdown) {
    const source = path.join(repository, relative);
    const markdown = await fs.readFile(source, 'utf8');
    for (const reference of localReferences(markdown)) {
      assert.equal(path.isAbsolute(reference), false, `${relative} contains an absolute filesystem link: ${reference}`);
      const target = path.resolve(path.dirname(source), decodeURIComponent(reference.split('#')[0]));
      assert.ok(target === repository || target.startsWith(`${repository}${path.sep}`), `${relative} link escapes repository: ${reference}`);
      await assert.doesNotReject(fs.access(target), `${relative} has a broken link: ${reference}`);
    }
  }
});

test('public header SVGs are transparent static assets without active or external content', async () => {
  for (const relative of ['assets/brand/rhubase/header-light.svg', 'assets/brand/rhubase/header-dark.svg']) {
    const svg = await fs.readFile(path.join(repository, relative), 'utf8');
    assert.match(svg, /^\s*<svg\b/i, `${relative} must be a standalone SVG`);
    assert.doesNotMatch(svg, /<(?:script|foreignObject|image|iframe|audio|video|animate|set)\b/i, `${relative} contains active or embedded content`);
    assert.doesNotMatch(svg, /\son[a-z]+\s*=/i, `${relative} contains an event handler`);
    assert.doesNotMatch(svg, /(?:href|src)\s*=\s*["'](?:https?:|\/\/|data:)/i, `${relative} references external or embedded content`);
    assert.doesNotMatch(svg, /url\s*\(\s*["']?(?:https?:|\/\/|data:)/i, `${relative} contains an external paint reference`);
    assert.doesNotMatch(svg, /<rect\b[^>]*(?:width=["']100%["']|height=["']100%["'])/i, `${relative} must not paint a full-canvas background`);
  }
});
