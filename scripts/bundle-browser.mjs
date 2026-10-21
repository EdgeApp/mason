// Bundles the master's browser code with esbuild: its page script and the
// password worker, which carries hash-wasm. The output ships in lib/.
import { build } from 'esbuild'

await build({
  entryPoints: {
    'password-worker': 'src/browser/passwordWorker.ts',
    master: 'src/browser/master.ts',
  },
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  minify: true,
  legalComments: 'none',
  outdir: 'lib/browser/bundles',
  logLevel: 'warning',
})
