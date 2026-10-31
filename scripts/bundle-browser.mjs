// Bundles the browser code with esbuild: the master's page script, the
// password worker, which carries hash-wasm, and the run view's script, which
// shares the server's log renderer. The output ships in lib/.
import { build } from 'esbuild'

await build({
  entryPoints: {
    'password-worker': 'src/browser/passwordWorker.ts',
    master: 'src/browser/master.ts',
    run: 'src/browser/run.ts',
    secrets: 'src/browser/secrets.ts',
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
