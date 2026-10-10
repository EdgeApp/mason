import {
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
  private readonly clone: string
  private readonly identity: string
  constructor(
    private readonly store: BuilderStore,
    readonly job: Job,
    private readonly execution: Execution,
    private readonly resolveRepository: RepositoryResolver = (value) =>
      value,
  ) {
    this.identity = hash(
      job.definition.repository.replace(
        /^git@github\.com:/,
        'https://github.com/',
      ),
    )
    this.clone = path.join(store.config.workspace, 'git', this.identity)
    this.checkout = path.join(
      store.config.workspace,
      job.definition.workspace,
      hash(this.identity + ':' + job.branch),
    )
  }
  static discardCheckout(store: BuilderStore, job: Job): void {
    const repository = hash(
      job.definition.repository.replace(
        /^git@github\.com:/,
        'https://github.com/',
      ),
    )
    const directory = path.join(
      store.config.workspace,
      job.definition.workspace,
      hash(repository + ':' + job.branch),
    )
    noSymlinks(directory)
    if (
      store.own(
        'worktree:' +
          hash(
            repository + ':' + job.branch + ':' + job.definition.workspace,
          ),
        directory,
      )
    )
      rmSync(directory, { recursive: true, force: true })
  }
  async prepare(): Promise<string> {
    const git = async (args: string[], cwd: string): Promise<string> =>
      await this.execution.run(
        'git',
        ['-c', 'core.hooksPath=/dev/null', ...args],
        cwd,
        undefined,
        true,
      )
    privateDirectory(path.dirname(this.checkout))
    for (const target of [this.clone, this.checkout]) noSymlinks(target)
    this.store.own('clone:' + this.identity, this.clone)
    const owner = path.join(this.clone, 'mason-owner')
    noSymlinks(owner)
    // The database reserved this exact path before clone started. A stopped
    // clone may not have reached marker creation; retry only this owned path.
    if (existsSync(this.clone) && !existsSync(owner))
      rmSync(this.clone, { recursive: true })
    if (!existsSync(this.clone)) {
      await git(
        [
          'clone',
          '--bare',
          '--',
          this.resolveRepository(this.job.definition.repository),
          this.clone,
        ],
        this.store.config.workspace,
      )
      writeFileSync(path.join(this.clone, 'mason-owner'), this.identity, {
        mode: 0o600,
        flag: 'wx',
      })
    }
    noSymlinks(path.join(this.clone, 'mason-owner'))
    if (
      readFileSync(path.join(this.clone, 'mason-owner'), 'utf8') !==
      this.identity
    )
      throw new Error('Foreign clone')
    const ref = 'refs/mason/' + this.job.id
    await git(
      [
        'fetch',
        '--no-tags',
        '--',
        this.resolveRepository(this.job.definition.repository),
        `+${this.job.requested_commit ?? `refs/heads/${this.job.branch}`}:${ref}`,
      ],
      this.clone,
    )
    const commit = await git(
      ['rev-parse', '--verify', `${ref}^{commit}`],
      this.clone,
    )
    this.store.commit(this.job.id, commit)
    this.store.own(
      'worktree:' +
        hash(
          this.identity +
            ':' +
            this.job.branch +
            ':' +
            this.job.definition.workspace,
        ),
      this.checkout,
    )
    if (!existsSync(this.checkout)) {
      await git(['worktree', 'prune', '--expire', 'now'], this.clone)
      await git(
        ['worktree', 'add', '--detach', '--', this.checkout, commit],
        this.clone,
      )
    }
    const gitFile = path.join(this.checkout, '.git')
    noSymlinks(gitFile)
    const common = await git(
      ['rev-parse', '--path-format=absolute', '--git-common-dir'],
      this.checkout,
    )
    if (path.resolve(common) !== this.clone)
      throw new Error('Foreign worktree repository')
    await git(['reset', '--hard', commit], this.checkout)
    await git(['clean', '-ffdx'], this.checkout)
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
    await git(['update-ref', '-d', ref], this.clone)
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
