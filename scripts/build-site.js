'use strict';

const fs = require('node:fs');
const path = require('node:path');

const PUBLIC_FILES = ['index.html', 'velos-face-login.js', 'THIRD_PARTY_NOTICES.md'];
const PUBLIC_DIRECTORIES = ['assets', 'app', 'quorum'];
const PUBLIC_EXTENSIONS = new Set(['.html', '.css', '.js', '.mjs', '.svg', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.ico', '.woff', '.woff2', '.ttf', '.wasm', '.mp3', '.mp4', '.webm']);

function buildSite(root = path.resolve(__dirname, '..')) {
  root = fs.realpathSync(root);
  const output = path.resolve(root, 'dist');
  if (path.dirname(output) !== root) throw new Error('Static output must stay inside the project.');
  if (fs.existsSync(output) && (fs.lstatSync(output).isSymbolicLink() || fs.realpathSync(output) !== output)) {
    throw new Error('Refusing to replace a redirected static output directory.');
  }
  // dist is exclusively generated website output. Never copy the project root:
  // it contains the room server, environment files and private runtime state.
  fs.rmSync(output, { recursive: true, force: true });
  fs.mkdirSync(output);
  function copyPublic(source, destination) {
    const entry = fs.lstatSync(source);
    if (entry.isSymbolicLink()) throw new Error(`Public assets must not be symlinks: ${source}`);
    if (path.basename(source).startsWith('.')) return;
    if (entry.isDirectory()) {
      fs.mkdirSync(destination, { recursive: true });
      for (const name of fs.readdirSync(source)) copyPublic(path.join(source, name), path.join(destination, name));
    } else if (PUBLIC_EXTENSIONS.has(path.extname(source).toLowerCase())) {
      fs.copyFileSync(source, destination);
    }
  }
  for (const name of PUBLIC_FILES) fs.copyFileSync(path.join(root, name), path.join(output, name));
  for (const name of PUBLIC_DIRECTORIES) copyPublic(path.join(root, name), path.join(output, name));
  for (const name of ['app/index.html', 'quorum/index.html', 'quorum/focus-core.mjs', 'quorum/decisions.mjs', 'assets/velos-logo.svg']) {
    if (!fs.existsSync(path.join(output, name))) throw new Error(`Missing required website asset: ${name}`);
  }
  return output;
}

if (require.main === module) console.log(`Static website built: ${buildSite()}`);
module.exports = { buildSite };
