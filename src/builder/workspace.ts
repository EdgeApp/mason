import {
  chmodSync,
  existsSync,
  lstatSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { noSymlinks, privateDirectory } from '../config.js'
import { BuilderStore, hash, type Job } from './store.js'
import { Execution } from './execution.js'

export type RepositoryResolver = (repository: string) => string
export class Workspace {
  private readonly injected: string[] = []
  readonly checkout: string
  private static readonly owner = 'mason-shared-checkout-v1\n'
  constructor(
    private readonly store: BuilderStore,
    readonly job: Job,
    private readonly execution: Execution,
    private readonly resolveRepository: RepositoryResolver = (
      repository,
    ) => repository,
  ) {
    this.checkout = path.join(store.config.workspace, 'checkout')
  }
  static discardCheckout(store: BuilderStore, job: Job): void {
    const directory = path.join(store.config.workspace, 'checkout')
    noSymlinks(directory)
    if (store.own('checkout:shared', directory))
      Workspace.removeCheckout(directory)
    // Recovery must also handle a guardian started before the shared-checkout upgrade.
    const repository = hash(
      job.definition.repository.replace(
        /^git@github\.com:/,
        'https://github.com/',
      ),
    )
    const legacy = path.join(
      store.config.workspace,
      job.definition.workspace,
      hash(repository + ':' + job.branch),
    )
    const owned = store.db
      .prepare('SELECT directory FROM workspaces WHERE identity=?')
      .get(
        'worktree:' +
          hash(
            repository +
              ':' +
              job.branch +
              ':' +
              job.definition.workspace,
          ),
      )
    if (owned?.directory === legacy) {
      noSymlinks(legacy)
      rmSync(legacy, { recursive: true, force: true })
    }
  }
  private static removeCheckout(directory: string): void {
    noSymlinks(directory)
    if (!existsSync(directory)) return
    // A build can make its root read-only. Restore the owned root before removing
    // it so a failed injection cleanup does not poison the shared checkout.
    chmodSync(directory, 0o700)
    rmSync(directory, { recursive: true, force: true })
  }
  async prepare(): Promise<string> {
    const git = async (
      args: string[],
      cwd = this.checkout,
    ): Promise<string> =>
      await this.execution.run(
        'git',
        ['-c', 'core.hooksPath=/dev/null', ...args],
        cwd,
        undefined,
        true,
      )
    noSymlinks(this.checkout)
    this.store.own('checkout:shared', this.checkout)
    const gitDir = path.join(this.checkout, '.git')
    const owner = path.join(gitDir, 'mason-owner')
    noSymlinks(owner)
    // An interrupted initial clone has no completion marker. Only database-owned
    // paths reach this point, so an incomplete clone can be recreated safely.
    if (existsSync(this.checkout) && !existsSync(owner))
      Workspace.removeCheckout(this.checkout)
    const repository = this.resolveRepository(
      this.job.definition.repository,
    )
    if (existsSync(this.checkout)) {
      if (
        !lstatSync(gitDir).isDirectory() ||
        readFileSync(owner, 'utf8') !== Workspace.owner
      )
        throw new Error('Foreign checkout repository')
      if (
        path.resolve(await git(['rev-parse', '--absolute-git-dir'])) !==
        gitDir
      )
        throw new Error('Foreign checkout repository')
      const normalize = (url: string): string =>
        url.replace(/^git@github\.com:/, 'https://github.com/')
      if (
        normalize(await git(['remote', 'get-url', 'origin'])) !==
        normalize(repository)
      )
        Workspace.removeCheckout(this.checkout)
    }
    if (!existsSync(this.checkout)) {
      await git(
        ['clone', '--no-checkout', '--', repository, this.checkout],
        this.store.config.workspace,
      )
      writeFileSync(owner, Workspace.owner, { mode: 0o600, flag: 'wx' })
    }
    // One fixed fetch ref prevents a ref from accumulating for every completed job.
    const ref = 'refs/mason/current'
    await git([
      'fetch',
      '--no-tags',
      '--',
      repository,
      `+${this.job.requested_commit ?? `refs/heads/${this.job.branch}`}:${ref}`,
    ])
    const commit = await git(['rev-parse', '--verify', `${ref}^{commit}`])
    this.store.commit(this.job.id, commit)
    await git(['checkout', '--detach', '--force', commit])
    await git(['reset', '--hard', commit])
    await git(['clean', '-ffdx'])
    if (existsSync(path.join(this.checkout, '.gitmodules'))) {
      await git(['submodule', 'sync', '--recursive'], this.checkout)
      const cleanSubmodules = [
        'submodule',
        'foreach',
        '--recursive',
        'git reset --hard && git clean -ffdx',
      ]
      await git(cleanSubmodules, this.checkout)
      // Update initialized dependencies to this parent's gitlinks. Masonfiles may
      // initialize additional submodules using their own dependency setup.
      await git(
        ['submodule', 'update', '--recursive', '--force', '--checkout'],
        this.checkout,
      )
      await git(cleanSubmodules, this.checkout)
    }
    await git(['update-ref', '-d', ref])
    return commit
  }
  inject(): Record<string, string> {
    const env: Record<string, string> = {}
    for (const file of this.job.definition.files) {
      const destination = path.join(this.checkout, file.destination)
      noSymlinks(destination)
      if (existsSync(destination))
        throw new Error('Injected file would overwrite checkout content')
      privateDirectory(
        path.dirname(destination) === this.checkout
          ? this.checkoutPrivate()
          : this.privateParent(destination),
      )
      this.injected.push(destination)
      writeFileSync(
        path.join(
          this.store.config.workspace,
          'executions',
          this.job.id + '.files.json',
        ),
        JSON.stringify(this.injected),
        { mode: 0o600 },
      )
      writeFileSync(destination, Buffer.from(file.contents, 'base64'), {
        flag: 'wx',
        mode: 0o600,
      })
      if (file.env != null) env[file.env] = destination
    }
    return env
  }
  // Git creates directories with the service umask; never relax existing permissions.
  private checkoutPrivate(): string {
    return this.checkout
  }
  private privateParent(destination: string): string {
    return path.dirname(destination)
  }
  cleanup(): void {
    for (const destination of this.injected) {
      noSymlinks(destination)
      if (existsSync(destination)) {
        if (!lstatSync(destination).isFile())
          throw new Error('Injected file was replaced')
        rmSync(destination)
      }
    }
    rmSync(
      path.join(
        this.store.config.workspace,
        'executions',
        this.job.id + '.files.json',
      ),
      { force: true },
    )
  }
  entrypoint(): string {
    const candidates =
      this.job.definition.entrypoint == null
        ? ['Masonfile.ts', 'Masonfile.js']
        : [this.job.definition.entrypoint]
    const file = candidates
      .map((candidate) => path.join(this.checkout, candidate))
      .find((file) => existsSync(file))
    if (file == null) throw new Error('Masonfile not found')
    noSymlinks(file)
    if (!lstatSync(file).isFile() || !/\.(ts|js|mts|mjs)$/.test(file))
      throw new Error('Invalid Masonfile')
    return file
  }
}
