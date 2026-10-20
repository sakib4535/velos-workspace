'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { test } = require('node:test');
const { buildSite } = require('../scripts/build-site');

const project = path.resolve(__dirname, '..');

test('static deployment includes browser dependencies without server or private files', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'velos-static-test-'));
  t.after(() => {
    assert.equal(path.dirname(root), fs.realpathSync(os.tmpdir()));
    fs.rmSync(root, { recursive: true, force: true });
  });
  for (const name of ['index.html', 'velos-face-login.js', 'THIRD_PARTY_NOTICES.md', 'assets', 'app', 'quorum']) {
    fs.cpSync(path.join(project, name), path.join(root, name), { recursive: true });
  }
  for (const name of ['server.js', '.env', 'package.json', 'quorum/.private.json', 'quorum/debug.log']) {
    fs.writeFileSync(path.join(root, name), 'private fixture');
  }
  fs.mkdirSync(path.join(root, 'dist'));
  fs.writeFileSync(path.join(root, 'dist', 'stale.js'), 'stale');

  const output = buildSite(root);
  for (const name of ['server.js', '.env', 'package.json', 'lib', 'node_modules', 'quorum/.private.json', 'quorum/debug.log', 'stale.js']) {
    assert.equal(fs.existsSync(path.join(output, name)), false, `Must not publish ${name}`);
  }
  for (const name of ['index.html', 'app/index.html', 'quorum/index.html']) {
    const html = fs.readFileSync(path.join(output, name), 'utf8');
    // Validate locally hosted script, image and stylesheet dependencies used by each page.
    for (const [, tag, attributes] of html.matchAll(/<(script|img|link)\b([^>]*)>/gi)) {
      const reference = attributes.match(/\b(?:src|href)=["']([^"']+)["']/i)?.[1];
      if (!reference || /^(?:[a-z]+:|\/\/|#)/i.test(reference)) continue;
      const relative = reference.split(/[?#]/)[0];
      const target = relative.startsWith('/')
        ? path.join(output, relative)
        : path.resolve(output, path.dirname(name), relative);
      assert.ok(fs.existsSync(target), `${name}: missing ${tag} dependency ${reference}`);
    }
  }
  const browserCore = await import(pathToFileURL(path.join(output, 'quorum/focus-core.mjs')).href);
  assert.equal(browserCore.initFocus().energy, 62);
  assert.equal(typeof browserCore.focusTick, 'function');
  assert.equal(typeof browserCore.computeSessionScore, 'function');
  const config = JSON.parse(fs.readFileSync(path.join(project, 'vercel.json'), 'utf8'));
  assert.equal(config.framework, null);
  assert.equal(config.outputDirectory, 'dist');
  assert.equal(config.functions, undefined);
  const favicon = config.rewrites.find((route) => route.source === '/favicon.ico');
  assert.ok(fs.existsSync(path.join(output, favicon.destination)));
});

test('static build fails when the generated focus browser module is missing', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'velos-static-test-'));
  t.after(() => {
    assert.equal(path.dirname(root), fs.realpathSync(os.tmpdir()));
    fs.rmSync(root, { recursive: true, force: true });
  });
  for (const name of ['index.html', 'velos-face-login.js', 'THIRD_PARTY_NOTICES.md', 'assets', 'app', 'quorum']) {
    fs.cpSync(path.join(project, name), path.join(root, name), { recursive: true });
  }
  fs.unlinkSync(path.join(root, 'quorum/focus-core.mjs'));
  assert.throws(() => buildSite(root), /Missing required website asset: quorum\/focus-core.mjs/);
});
