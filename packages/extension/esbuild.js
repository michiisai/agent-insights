// @ts-check
const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const watch  = process.argv.includes('--watch');
const minify = process.argv.includes('--minify');

function copySqlWasm() {
  const src = require.resolve('sql.js/dist/sql-wasm.wasm');
  const outDir = path.resolve(__dirname, 'dist');
  const dest = path.join(outDir, 'sql-wasm.wasm');
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }
  fs.copyFileSync(src, dest);
}

function copyCodicons() {
  const outDir = path.resolve(__dirname, 'dist');
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }
  for (const name of ['codicon.css', 'codicon.ttf']) {
    const src = require.resolve(`@vscode/codicons/dist/${name}`);
    fs.copyFileSync(src, path.join(outDir, name));
  }
}

// The VSIX is packaged from this directory, but README.md and LICENSE are at the
// repo root. Copy them in at build time so the root files stay the single source
// of truth while the packaged extension still ships its docs and licence.
function copyDocs() {
  const root = path.resolve(__dirname, '..', '..');
  for (const name of ['README.md', 'LICENSE']) {
    const src = path.join(root, name);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(__dirname, name));
    }
  }
}

/** @type {import('esbuild').BuildOptions} */
const config = {
  entryPoints: ['src/extension.ts'],
  bundle:      true,
  outfile:     'dist/extension.js',
  external:    ['vscode'],
  format:      'cjs',
  platform:    'node',
  target:      'node20',
  sourcemap:   true,
  minify,
};

if (watch) {
  esbuild.context(config).then(ctx => {
    copySqlWasm();
    copyCodicons();
    copyDocs();
    ctx.watch();
    console.log('[esbuild] watching…');
  });
} else {
  esbuild.build(config)
    .then(() => { copySqlWasm(); copyCodicons(); copyDocs(); })
    .catch(() => process.exit(1));
}
