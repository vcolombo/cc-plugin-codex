import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => JSON.parse(readFileSync(new URL(`../${p}`, import.meta.url), 'utf8'));

test('package.json is valid and dependency-free', () => {
  const pkg = read('package.json');
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.dependencies, undefined);
  assert.equal(pkg.devDependencies, undefined);
});

test('marketplace.json has required policy', () => {
  const mkt = read('.agents/plugins/marketplace.json');
  assert.equal(mkt.name, 'cc-plugin-codex');
  const p = mkt.plugins[0];
  assert.equal(p.name, 'claude');
  assert.equal(p.source.path, './plugins/claude');
  assert.equal(p.policy.installation, 'AVAILABLE');
  assert.equal(p.policy.authentication, 'ON_INSTALL');
});

test('plugin manifest has validator-required fields and no hooks key', () => {
  const m = read('plugins/claude/.codex-plugin/plugin.json');
  assert.equal(m.name, 'claude');
  assert.match(m.version, /^\d+\.\d+\.\d+$/);
  assert.ok(m.description);
  assert.ok(m.author?.name);
  for (const f of ['displayName', 'shortDescription', 'longDescription', 'developerName', 'defaultPrompt', 'category', 'capabilities']) {
    assert.ok(m.interface?.[f], `interface.${f} missing`);
  }
  assert.equal(m.hooks, undefined, 'manifest must not declare hooks (validator rejects it)');
});
