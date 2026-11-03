// Builds the offline Counter demo page (one HTML page + supporting scripts).
//   node demo/build.mjs          (expects demo/build/fixtures.json from capture.ts)
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const out = join(here, 'site');
mkdirSync(out, { recursive: true });
const web = join(root, 'apps/web');
const pos = join(root, 'apps/pos');

const common = {
  bundle: true, format: 'iife', platform: 'browser', target: ['safari15', 'chrome100'], minify: true, legalComments: 'none',
  define: { 'process.env.NODE_ENV': '"production"', 'process.env.NEXT_PUBLIC_API_URL': '"https://demo.counter.invalid"' },
  logLevel: 'warning', alias: { '@retail/shared': join(root, 'packages/shared/src/index.ts') },
};

// 1) demo backend
await esbuild.build({ ...common, entryPoints: [join(here, 'src/backend.ts')], outfile: join(out, 'backend.js') });

// 2) back office (the real apps/web pages) as a single-page app
const nextShims = {
  name: 'next-shims',
  setup(b) {
    b.onResolve({ filter: /^next\/link$/ }, () => ({ path: join(here, 'src/shims/next-link.tsx') }));
    b.onResolve({ filter: /^next\/navigation$/ }, () => ({ path: join(here, 'src/shims/next-navigation.ts') }));
    b.onResolve({ filter: /^next\/font\/google$/ }, () => ({ path: join(here, 'src/shims/next-font-google.ts') }));
    b.onResolve({ filter: /^@\// }, (a) => {
      const base = join(web, a.path.slice(2));
      for (const ext of ['', '.tsx', '.ts', '/index.tsx', '/index.ts']) if (existsSync(base + ext) && !base.endsWith('/') && (ext || /\.\w+$/.test(base))) return { path: base + ext };
      return { path: base + '.tsx' };
    });
  },
};
await esbuild.build({ ...common, entryPoints: [join(here, 'src/office.tsx')], outfile: join(out, 'office.js'), jsx: 'automatic',
  plugins: [nextShims], nodePaths: [join(root, 'node_modules')] });

// 3) back-office styles (Tailwind, scanning apps/web)
const cssOut = join(here, 'build/office.css');
execFileSync(join(root, 'node_modules/.bin/tailwindcss'), ['-i', join(web, 'app/globals.css'), '-o', cssOut, '--minify'], { cwd: web, stdio: 'pipe' });
const officeCss = readFileSync(cssOut, 'utf8');

// 4) till (the real apps/pos Expo web export), icons inlined as data URIs
execFileSync('npx', ['expo', 'export', '--platform', 'web', '--clear'], { cwd: pos, stdio: 'pipe' });
const jsDir = join(pos, 'dist/_expo/static/js/web');
let posJs = readFileSync(join(jsDir, readdirSync(jsDir).find((f) => f.endsWith('.js'))), 'utf8');
posJs = posJs.replace(/uri:"\/(assets\/[^"]+\.png)"/g, (_m, p) => {
  const file = join(pos, 'dist', p);
  return existsSync(file) ? `uri:"data:image/png;base64,${readFileSync(file).toString('base64')}"` : `uri:""`;
});
writeFileSync(join(out, 'pos.js'), posJs);

// 5) captured shop data
writeFileSync(join(out, 'data.js'), `window.__DEMO_DATA__=${readFileSync(join(here, 'build/fixtures.json'), 'utf8')};`);

// 6) the page
const page = readFileSync(join(here, 'src/page.html'), 'utf8').replace('/*OFFICE_CSS*/', () => officeCss);
writeFileSync(join(out, 'counter-demo.html'), page);
for (const f of readdirSync(out)) console.log(f.padEnd(20), (readFileSync(join(out, f)).length / 1024).toFixed(0), 'KB');
