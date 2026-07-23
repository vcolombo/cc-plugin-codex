import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const SKILLS = fileURLToPath(new URL('../plugins/claude/skills', import.meta.url));
const EXPECTED = ['adversarial-review', 'cancel', 'rescue', 'result', 'review', 'setup', 'status', 'transfer'];

test('all eight skills exist with matching frontmatter', () => {
  assert.deepEqual(readdirSync(SKILLS).sort(), EXPECTED);
  for (const name of EXPECTED) {
    const md = readFileSync(join(SKILLS, name, 'SKILL.md'), 'utf8');
    const fm = md.match(/^---\n([\s\S]*?)\n---/);
    assert.ok(fm, `${name}: missing frontmatter`);
    assert.match(fm[1], new RegExp(`^name: ${name}$`, 'm'));
    assert.match(fm[1], /^description: .+$/m);
    assert.match(md, /Locating the plugin scripts/, `${name}: missing script-locating block`);
  }
});
