'use strict';

const path = require('node:path');
const { buildSync } = require('esbuild');

const root = path.join(__dirname, '..');
const shared = {
  entryPoints: [path.join(root, 'lib', 'index.ts')],
  bundle: true,
  target: 'es2020',
  logLevel: 'warning',
  banner: { js: '// Generated from lib/*.ts. Run npm run build:core to regenerate.' }
};

buildSync({ ...shared, platform: 'node', format: 'cjs', outfile: path.join(root, 'lib', 'quorum-core.cjs') });
buildSync({ ...shared, platform: 'browser', format: 'esm', outfile: path.join(root, 'quorum', 'focus-core.mjs') });
