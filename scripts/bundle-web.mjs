// Bundles the React web app with esbuild into lib/web/bundles/:
//   app-[hash].js            src/web/main.tsx and everything it imports
//   app-[hash].css           src/web/theme/app.css (library, tokens, components)
//   password-worker-[hash].js  the Argon2id worker (src/web/workers/password.ts)
//   theme-boot.js            unhashed; index.html loads it first, synchronously
//   index.html               the shell, naming the hashed files
// The fonts stay where assetRoutes serves them (/assets/fonts/…). The server
// serves the files under /assets/web/ (src/node/webRoutes.ts).
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const outdir = path.join(root, 'lib', 'web', 'bundles')
const assets = '/assets/web'

rmSync(outdir, { recursive: true, force: true })
mkdirSync(outdir, { recursive: true })

const common = {
  bundle: true,
  platform: 'browser',
  target: 'es2022',
  minify: true,
  legalComments: 'none',
  outdir,
  logLevel: 'warning',
  absWorkingDir: root,
  metafile: true,
}

/** The output file esbuild wrote for an entry point, by its path in the repository. */
const output = (result, entry) => {
  const found = Object.entries(result.metafile.outputs).find(
    ([, meta]) => meta.entryPoint === entry,
  )
  if (found == null) throw new Error(`No output for ${entry}`)
  return path.basename(found[0])
}

const scripts = await build({
  ...common,
  entryPoints: {
    app: 'src/web/main.tsx',
    'password-worker': 'src/web/workers/password.ts',
  },
  entryNames: '[name]-[hash]',
  format: 'esm',
  jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' },
})
const styles = await build({
  ...common,
  entryPoints: { app: 'src/web/theme/app.css' },
  entryNames: '[name]-[hash]',
  external: ['/assets/fonts/*'],
})
await build({
  ...common,
  stdin: {
    contents: "import { bootTheme } from './theme-boot.js'\nbootTheme()\n",
    resolveDir: path.join(root, 'src', 'web', 'theme'),
    sourcefile: 'theme-boot-entry.ts',
    loader: 'ts',
  },
  outfile: path.join(outdir, 'theme-boot.js'),
  outdir: undefined,
  format: 'iife',
})

const app = output(scripts, 'src/web/main.tsx')
const worker = output(scripts, 'src/web/workers/password.ts')
const css = output(styles, 'src/web/theme/app.css')
writeFileSync(
  path.join(outdir, 'index.html'),
  `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="dark light">
<meta name="mason-password-worker" content="${assets}/${worker}">
<title>Mason</title>
<link rel="icon" href="/favicon.ico">
<script src="${assets}/theme-boot.js"></script>
<link rel="stylesheet" href="${assets}/${css}">
<script type="module" src="${assets}/${app}"></script>
</head>
<body>
<div id="root"></div>
</body>
</html>
`,
)
