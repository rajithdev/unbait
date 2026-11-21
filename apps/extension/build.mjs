// Builds the extension into dist/ (load it with "Load unpacked"), and with
// --zip also writes unbait-extension.zip for the Chrome Web Store or a release.
//
//   UNBAIT_API_URL=https://your-server node build.mjs --zip
import { build } from 'esbuild';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const out = `${here}dist`;
const apiUrl = (process.env.UNBAIT_API_URL ?? 'http://localhost:8787').replace(/\/+$/, '');
const { version } = JSON.parse(readFileSync(`${here}package.json`, 'utf8'));

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

await build({
  entryPoints: { content: 'src/content.ts', background: 'src/background.ts', popup: 'src/popup.ts' },
  absWorkingDir: here,
  outdir: out,
  bundle: true,
  format: 'esm',
  target: 'chrome114',
  minify: false,
  sourcemap: false,
  legalComments: 'none',
  define: { __API_URL__: JSON.stringify(apiUrl) },
});

const manifest = JSON.parse(readFileSync(`${here}static/manifest.json`, 'utf8'));
manifest.version = version;
writeFileSync(`${out}/manifest.json`, JSON.stringify(manifest, null, 2));
cpSync(`${here}static/popup.html`, `${out}/popup.html`);
cpSync(`${here}static/icons`, `${out}/icons`, { recursive: true });
console.log(`Built Unbait ${version} into dist/ (server: ${apiUrl})`);

if (process.argv.includes('--zip')) {
  rmSync(`${here}unbait-extension.zip`, { force: true });
  execFileSync('zip', ['-qr', `${here}unbait-extension.zip`, '.'], { cwd: out });
  console.log('Wrote unbait-extension.zip');
}
