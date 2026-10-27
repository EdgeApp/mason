import type {
  AppleOptions,
  ApprovalOptions,
  BuildNumberOptions,
  MatrixAxes,
  MatrixOptions,
  NodeSelector,
  ParallelOptions,
  ParamSpec,
  ParamValue,
  PostStages,
  Role,
  SequenceStage,
  Setup,
  StageOptions,
  StageRef,
  StageStatus,
  Tools,
  Trigger,
  TriggerKind,
  When,
  WorkflowBuilder,
  WorkflowOptions,
} from '../../types/mason/index.js'
import { asScheme, type BuildNumberScheme } from '../master/buildNumbers.js'
import { matches } from '../master/rules.js'

/** The Masonfile API versions this Mason major version runs. */
export const apiVersions = [1]

export const limits = {
  stages: 500,
  matrix: 256,
  graphBytes: 1024 * 1024,
  outputBytes: 64 * 1024,
}

export type PostCondition = keyof PostStages
export const postConditions: PostCondition[] = [
  'always',
  'success',
  'unstable',
  'failure',
  'aborted',
  'fixed',
  'regression',
]

/** One stage of a recorded graph, with defaults filled and `needs` resolved to stage names. */
export interface GraphStage {
  name: string
  kind: 'stage' | 'approval' | 'script'
  /** The parallel group or matrix the stage belongs to. */
  group?: string
  /** The export the stage run calls. */
  run?: string
  on?: NodeSelector
  needs: string[]
  when?: When
  tools?: Tools
  secrets: string[]
  env: Record<string, string>
  /** Seconds. */
  timeout: number
  activityTimeout?: number
  retry: { attempts: number; on: Array<'failed' | 'interrupted' | 'timed_out'> }
  lock: string[]
  apple?: AppleOptions
  publishes: string[]
  buildNumbers: string[]
  checkout: {
    enabled: boolean
    submodules: boolean
    lfs: boolean
    depth?: number
  }
  workspace: { mode: 'clean' | 'reuse'; path?: string }
  cache: Array<{ key: string; paths: string[] }>
  continueOnError: boolean
  requireSuccess: boolean
  failFast: boolean
  matrix: Record<string, string | number | boolean>
  approval?: {
    roles: Role[]
    message?: string
    timeout?: number
    params: Record<string, ParamSpec>
  }
  post?: PostCondition
}

export interface GraphWorkflow {
  name: string
  triggers: Trigger[]
  params: Record<string, ParamSpec>
  env: Record<string, string>
  timeout: number
  concurrency: { group: string; cancelPrevious: boolean }
  keep: { runs?: number; days?: number; artifactDays?: number; stashes: number }
  failFast: boolean
  stages: GraphStage[]
  post: GraphStage[]
}

/** What a setup run records: every workflow, the build-number schemes and warnings. */
export interface Graph {
  apiVersion: number
  format: 'pipeline' | 'script'
  workflows: GraphWorkflow[]
  buildNumbers: Record<string, BuildNumberScheme>
  warnings: string[]
}

export interface SetupContext {
  workflow: string
  branch: string
  commit: string
  trigger: TriggerKind
  params: Record<string, ParamValue>
}

export class GraphError extends Error {}
export class ParamsError extends Error {}

const durationUnits: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 }

/** A duration such as `'90s'` or `'4h'` in seconds. */
export function seconds(value: unknown, what = 'duration'): number {
  const match =
    typeof value === 'string' ? /^(\d+(?:\.\d+)?)([smhd])$/.exec(value) : null
  if (match == null) throw new GraphError(`Invalid ${what}: ${String(value)}`)
  const out = Number(match[1]) * durationUnits[match[2]!]!
  if (out <= 0 || out > 30 * 86400)
    throw new GraphError(`${what} must be between 1 s and 30 d`)
  return Math.round(out)
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value != null && typeof value === 'object' && !Array.isArray(value)

function strings(value: unknown, what: string): string[] {
  if (value == null) return []
  const list = typeof value === 'string' ? [value] : value
  if (
    !Array.isArray(list) ||
    list.some((item) => typeof item !== 'string' || item.length === 0)
  )
    throw new GraphError(`${what} must be a list of names`)
  return list as string[]
}

function environment(value: unknown, what: string): Record<string, string> {
  if (value == null) return {}
  if (
    !isRecord(value) ||
    Object.entries(value).some(
      ([name, entry]) =>
        !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ||
        name.startsWith('MASON_') ||
        typeof entry !== 'string',
    )
  )
    throw new GraphError(`${what} must map variable names to strings`)
  return value as Record<string, string>
}

export const paramTypes = ['choice', 'boolean', 'number', 'text', 'string']

function paramSpecs(value: unknown, what: string): Record<string, ParamSpec> {
  if (value == null) return {}
  if (!isRecord(value)) throw new GraphError(`${what} must be an object`)
  for (const [name, spec] of Object.entries(value)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
      throw new GraphError(`Invalid parameter name ${name}`)
    if (!isRecord(spec) || !paramTypes.includes(spec.type as string))
      throw new GraphError(`Parameter ${name} has an unknown type`)
    if (
      spec.type === 'choice' &&
      (!Array.isArray(spec.choices) ||
        spec.choices.length === 0 ||
        spec.choices.some((choice) => typeof choice !== 'string'))
    )
      throw new GraphError(`Parameter ${name} needs a list of choices`)
    if (spec.type === 'string' && spec.pattern != null) {
      try {
        new RegExp(String(spec.pattern))
      } catch {
        throw new GraphError(`Parameter ${name} has an invalid pattern`)
      }
    }
    if (spec.default !== undefined)
      checkParam(name, spec as ParamSpec, spec.default, GraphError)
  }
  return value as Record<string, ParamSpec>
}

function checkParam(
  name: string,
  spec: ParamSpec,
  value: unknown,
  Failure: new (message: string) => Error = ParamsError,
): ParamValue {
  const fail = (why: string): never => {
    throw new Failure(`Parameter ${name} ${why}`)
  }
  switch (spec.type) {
    case 'boolean':
      if (typeof value !== 'boolean') fail('must be true or false')
      break
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value))
        fail('must be a number')
      if (spec.min != null && (value as number) < spec.min)
        fail(`must be at least ${spec.min}`)
      if (spec.max != null && (value as number) > spec.max)
        fail(`must be at most ${spec.max}`)
      break
    case 'choice':
      if (!spec.choices.includes(value as string))
        fail(`must be one of ${spec.choices.join(', ')}`)
      break
    case 'text':
    case 'string':
      if (typeof value !== 'string' || value.length > 65536)
        fail('must be text')
      if (spec.type === 'string' && (value as string).includes('\n'))
        fail('must be one line')
      if (
        spec.type === 'string' &&
        spec.pattern != null &&
        !new RegExp(spec.pattern).test(value as string)
      )
        fail(`must match ${spec.pattern}`)
  }
  return value as ParamValue
}

/**
 * Checks a run's parameters against a workflow's `params`: types, choices,
 * limits and patterns; defaults fill missing values; a parameter with no
 * default is required; unknown names are refused.
 */
export function validateParams(
  specs: Record<string, ParamSpec>,
  values: unknown,
): Record<string, ParamValue> {
  if (values == null) values = {}
  if (!isRecord(values)) throw new ParamsError('Parameters must be an object')
  const out: Record<string, ParamValue> = {}
  for (const name of Object.keys(values))
    if (specs[name] == null) throw new ParamsError(`Unknown parameter ${name}`)
  for (const [name, spec] of Object.entries(specs)) {
    const value = values[name] ?? spec.default
    if (value === undefined)
      throw new ParamsError(`Parameter ${name} is required`)
    out[name] = checkParam(name, spec, value)
  }
  return out
}

const oses = ['macos', 'linux', 'windows']
const arches = ['arm64', 'x64']
const toolNames = [
  'node',
  'java',
  'rust',
  'android',
  'xcode',
  'simulators',
  'brew',
  'apt',
  'dnf',
]
const roles: Role[] = ['admin', 'manager', 'developer', 'tester']
const triggerKinds = [
  'push',
  'request',
  'schedule',
  'after',
  'deviceRegistered',
]

function selector(value: unknown, what: string): NodeSelector {
  if (typeof value === 'string' && value.length > 0) return value
  if (!isRecord(value)) throw new GraphError(`${what} needs a node selector`)
  for (const key of Object.keys(value))
    if (!['type', 'os', 'arch', 'labels'].includes(key))
      throw new GraphError(`${what}: unknown selector field ${key}`)
  if (value.os != null && !oses.includes(value.os as string))
    throw new GraphError(`${what}: unknown OS ${String(value.os)}`)
  if (value.arch != null && !arches.includes(value.arch as string))
    throw new GraphError(`${what}: unknown architecture ${String(value.arch)}`)
  strings(value.labels, `${what} labels`)
  return value as NodeSelector
}

export const asNodeSelector = (value: unknown): NodeSelector =>
  selector(value, 'The node selector')

function tools(value: unknown, what: string): Tools | undefined {
  if (value == null) return undefined
  if (!isRecord(value)) throw new GraphError(`${what}: tools must be an object`)
  for (const [name, version] of Object.entries(value)) {
    if (!toolNames.includes(name))
      throw new GraphError(`${what}: unknown tool ${name}`)
    if (['android', 'simulators', 'brew', 'apt', 'dnf'].includes(name))
      strings(version, `${what} ${name}`)
    else if (typeof version !== 'string' || version.length === 0)
      throw new GraphError(`${what}: ${name} needs a version`)
  }
  return value as Tools
}

function when(value: unknown, what: string): When | undefined {
  if (value == null) return undefined
  if (!isRecord(value)) throw new GraphError(`${what}: when must be an object`)
  for (const key of Object.keys(value))
    if (!['branch', 'notBranch', 'trigger', 'params', 'changed'].includes(key))
      throw new GraphError(`${what}: unknown when field ${key}`)
  strings(value.branch, `${what} when.branch`)
  strings(value.notBranch, `${what} when.notBranch`)
  strings(value.changed, `${what} when.changed`)
  if (
    strings(value.trigger, `${what} when.trigger`).some(
      (kind) => !triggerKinds.includes(kind),
    )
  )
    throw new GraphError(`${what}: unknown trigger in when`)
  if (value.params != null && !isRecord(value.params))
    throw new GraphError(`${what}: when.params must be an object`)
  return value as When
}

/**
 * Records what `setup(m)` declares. Stage functions are referenced by value
 * and mapped to their export names; one that is not exported is an error.
 */
export class Recorder {
  private readonly workflows = new Map<string, GraphWorkflow>()
  private readonly schemes: Record<string, BuildNumberScheme> = {}
  private readonly warnings: string[] = []
  private readonly names = new Map<unknown, string>()
  private readonly testflight = new Set<string>()
  private version: number | undefined
  private count = 0
  private buildOptions = false
  private readonly refs = new Map<string, Map<string, string[]>>()

  constructor(
    readonly context: SetupContext,
    exports: Record<string, unknown>,
  ) {
    for (const [name, value] of Object.entries(exports))
      if (typeof value === 'function' && name !== 'setup') {
        this.names.set(value, name)
        if (/\.testflight\s*\(/.test(Function.prototype.toString.call(value)))
          this.testflight.add(name)
      }
  }

  /** The `m` object handed to `setup`. Stage-context methods throw here. */
  setup(): Setup {
    const builder = this.builder(this.workflow('build', {}))
    const m = {
      ...builder,
      apiVersion: (version: 1): void => {
        this.version = version
      },
      buildNumber: (key: string, options?: BuildNumberOptions): void => {
        if (typeof key !== 'string' || key.length === 0 || key.length > 160)
          throw new GraphError('A build-number key is 1–160 characters')
        if (this.schemes[key] != null)
          throw new GraphError(`Build number ${key} is declared twice`)
        try {
          const apps = (options as { apps?: unknown } | undefined)?.apps
          if (
            apps != null &&
            (!Array.isArray(apps) ||
              apps.some(
                (app) =>
                  typeof app !== 'string' ||
                  app.length === 0 ||
                  app.length > 160,
              ))
          )
            throw new Error('apps lists app IDs')
          for (const app of (apps ?? []) as string[]) {
            const other = Object.entries(this.schemes).find(([, scheme]) =>
              scheme.apps?.includes(app),
            )
            if (other != null)
              throw new Error(
                `${app} already takes its numbers from ${other[0]}`,
              )
          }
          this.schemes[key] = {
            ...asScheme(options),
            ...(apps == null ? {} : { apps: [...new Set(apps as string[])] }),
          }
        } catch (error) {
          throw new GraphError(
            `Build number ${key}: ${(error as Error).message}`,
          )
        }
      },
      workflow: (
        name: string,
        options: WorkflowOptions,
        declare: (w: WorkflowBuilder) => void,
      ): void => {
        if (!/^[a-z][a-z0-9-]{0,39}$/.test(name))
          throw new GraphError(`Invalid workflow name ${name}`)
        if (typeof declare !== 'function')
          throw new GraphError(`Workflow ${name} needs a declare function`)
        const existing = this.workflows.get(name)
        if (existing != null && (name !== 'build' || this.buildOptions))
          throw new GraphError(`Workflow ${name} is declared twice`)
        let workflow: GraphWorkflow
        if (existing != null) {
          // Stages declared on `m` and in `m.workflow('build', …)` share one workflow.
          this.buildOptions = true
          workflow = Object.assign(existing, {
            ...this.workflow(name, options),
            stages: existing.stages,
            post: existing.post,
          })
          this.workflows.set(name, workflow)
        } else workflow = this.workflow(name, options)
        declare(this.builder(workflow))
      },
      currentWorkflow: this.context.workflow,
      branch: this.context.branch,
      commit: this.context.commit,
      trigger: this.context.trigger,
      params: Object.freeze({ ...this.context.params }),
    }
    return new Proxy(Object.freeze(m) as Setup, {
      get(target, property, receiver): unknown {
        if (
          typeof property === 'string' &&
          !(property in target) &&
          property !== 'then' &&
          property !== 'toJSON'
        )
          throw new GraphError(
            `m.${property} is not part of setup; stage context methods run only in stage functions`,
          )
        return Reflect.get(target, property, receiver)
      },
    })
  }

  /** The recorded graph; throws a `GraphError` for anything setup got wrong. */
  graph(): Graph {
    if (this.version == null)
      throw new GraphError('setup must call m.apiVersion(1)')
    if (!apiVersions.includes(this.version))
      throw new GraphError(
        `Masonfile API version ${String(this.version)} is not supported; this Mason runs ${apiVersions.join(', ')}`,
      )
    const workflows = [...this.workflows.values()].filter(
      (workflow) =>
        workflow.name !== 'build' ||
        workflow.stages.length > 0 ||
        workflow.post.length > 0,
    )
    for (const workflow of workflows) {
      for (const stage of [...workflow.stages, ...workflow.post]) {
        const branchScoped = [...stage.publishes, ...stage.buildNumbers].filter(
          (key) =>
            this.schemes[key]?.scope === 'branch' &&
            !/YY|MM|DD/.test(this.schemes[key].format),
        )
        if (
          branchScoped.length > 0 &&
          ((stage.run != null && this.testflight.has(stage.run)) ||
            stage.apple?.distribution === 'appStore')
        )
          this.warnings.push(
            `Workflow ${workflow.name} sends ${branchScoped.join(', ')} to TestFlight with a per-branch build number that has no date; two branches can produce the same number`,
          )
      }
    }
    for (const workflow of workflows) {
      const refs = this.refs.get(workflow.name) ?? new Map<string, string[]>()
      for (const stage of [...workflow.stages, ...workflow.post])
        stage.needs = [
          ...new Set(
            stage.needs.flatMap((need) => {
              if (!need.startsWith('\u0000')) return [need]
              const exits = refs.get(need.slice(1))
              if (exits == null)
                throw new GraphError(
                  `Stage ${stage.name} needs ${need.slice(1)}, which is not declared in workflow ${workflow.name}`,
                )
              return exits
            }),
          ),
        ]
    }
    const graph: Graph = {
      apiVersion: this.version,
      format: 'pipeline',
      workflows,
      buildNumbers: this.schemes,
      warnings: [...new Set(this.warnings)],
    }
    checkStructure(graph)
    return graph
  }

  private workflow(name: string, options: WorkflowOptions): GraphWorkflow {
    if (!isRecord(options))
      throw new GraphError(`Workflow ${name} needs an options object`)
    const triggers =
      options.triggers ??
      (name === 'build' ? [{ push: true }, { request: true }] : [])
    if (!Array.isArray(triggers))
      throw new GraphError(`Workflow ${name}: triggers must be a list`)
    for (const trigger of triggers) {
      const keys = isRecord(trigger) ? Object.keys(trigger) : []
      const kind = keys.find((key) => triggerKinds.includes(key))
      if (kind == null)
        throw new GraphError(`Workflow ${name}: unknown trigger`)
      if (kind === 'schedule') {
        const t = trigger as { schedule: unknown; branches?: unknown }
        if (
          typeof t.schedule !== 'string' ||
          t.schedule.trim().split(/\s+/).length !== 5
        )
          throw new GraphError(
            `Workflow ${name}: a schedule is a 5-field cron entry`,
          )
        strings(t.branches, `Workflow ${name} schedule branches`)
      }
      if (kind === 'after') {
        const after = (trigger as { after: unknown }).after
        if (
          !isRecord(after) ||
          typeof after.workflow !== 'string' ||
          (after.status != null &&
            !['success', 'completed'].includes(after.status as string))
        )
          throw new GraphError(
            `Workflow ${name}: after names a workflow and a status`,
          )
      }
    }
    const concurrency = options.concurrency ?? { group: 'branch' }
    if (!isRecord(concurrency) || typeof concurrency.group !== 'string')
      throw new GraphError(`Workflow ${name}: concurrency needs a group`)
    const keep: NonNullable<WorkflowOptions['keep']> = options.keep ?? {}
    for (const [key, value] of Object.entries(keep))
      if (
        !['runs', 'days', 'artifactDays', 'stashes'].includes(key) ||
        !Number.isSafeInteger(value) ||
        (value as number) < 0
      )
        throw new GraphError(`Workflow ${name}: invalid keep.${key}`)
    const workflow: GraphWorkflow = {
      name,
      triggers,
      params: paramSpecs(options.params, `Workflow ${name} params`),
      env: environment(options.env, `Workflow ${name} env`),
      timeout:
        options.timeout == null
          ? 4 * 3600
          : seconds(options.timeout, `Workflow ${name} timeout`),
      concurrency: {
        group: concurrency.group,
        cancelPrevious: concurrency.cancelPrevious === true,
      },
      keep: { ...keep, stashes: keep.stashes ?? 3 },
      failFast: options.failFast !== false,
      stages: [],
      post: [],
    }
    this.workflows.set(name, workflow)
    return workflow
  }

  private builder(workflow: GraphWorkflow): WorkflowBuilder {
    // The exits of the item declared last: what a stage with no `needs` waits for.
    let previous: string[] = []
    const refs = this.refs.get(workflow.name) ?? new Map<string, string[]>()
    this.refs.set(workflow.name, refs)
    const ref = (
      name: string,
      kind: StageRef['kind'],
      exits: string[],
    ): StageRef => {
      refs.set(name, exits)
      previous = exits
      return Object.freeze({ name, kind })
    }
    const resolve = (needs: StageRef[] | undefined, what: string): string[] => {
      if (needs == null) return previous
      if (!Array.isArray(needs))
        throw new GraphError(`${what}: needs must be a list`)
      return [
        ...new Set(
          needs.flatMap((need) => {
            if (typeof need?.name !== 'string')
              throw new GraphError(`${what}: needs lists stage references`)
            // A reference to a stage declared later resolves when setup ends.
            return refs.get(need.name) ?? [`\u0000${need.name}`]
          }),
        ),
      ]
    }
    const add = (stage: GraphStage): void => {
      if (++this.count > limits.stages)
        throw new GraphError(`A graph has at most ${limits.stages} stages`)
      if (
        [...workflow.stages, ...workflow.post].some(
          (other) => other.name === stage.name,
        )
      )
        throw new GraphError(
          `Stage ${stage.name} is declared twice in workflow ${workflow.name}`,
        )
      if (stage.post == null) workflow.stages.push(stage)
      else workflow.post.push(stage)
    }
    const name = (value: unknown): string => {
      if (
        typeof value !== 'string' ||
        !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,59}$/.test(value)
      )
        throw new GraphError(`Invalid stage name ${String(value)}`)
      if (refs.has(value))
        throw new GraphError(
          `Stage ${value} is declared twice in workflow ${workflow.name}`,
        )
      return value
    }
    return {
      stage: (stageName, options): StageRef => {
        stageName = name(stageName)
        const stage = this.stageOf(
          stageName,
          options,
          workflow,
          resolve(options?.needs, `Stage ${stageName}`),
        )
        add(stage)
        return ref(stageName, 'stage', [stage.name])
      },
      parallel: (groupName, members, options?: ParallelOptions): StageRef => {
        groupName = name(groupName)
        if (!isRecord(members) || Object.keys(members).length === 0)
          throw new GraphError(`Parallel group ${groupName} has no members`)
        const needs = resolve(options?.needs, `Parallel group ${groupName}`)
        const failFast = options?.failFast ?? workflow.failFast
        const exits: string[] = []
        for (const [member, value] of Object.entries(members)) {
          if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,59}$/.test(member))
            throw new GraphError(`Invalid member name ${member}`)
          if (Array.isArray(value)) {
            if (value.length === 0)
              throw new GraphError(`Sequence ${groupName}/${member} is empty`)
            let last = needs
            for (const entry of value as SequenceStage[]) {
              const step = typeof entry?.name === 'string' ? entry.name : ''
              if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,59}$/.test(step))
                throw new GraphError(
                  `Sequence ${groupName}/${member} needs stage names`,
                )
              const stage = this.stageOf(
                `${groupName}/${member}/${step}`,
                entry,
                workflow,
                entry.needs == null
                  ? last
                  : resolve(
                      entry.needs,
                      `Stage ${groupName}/${member}/${step}`,
                    ),
                { group: groupName, failFast },
              )
              add(stage)
              last = [stage.name]
            }
            exits.push(...last)
          } else {
            const stage = this.stageOf(
              `${groupName}/${member}`,
              value,
              workflow,
              value?.needs == null
                ? needs
                : resolve(value.needs, `Stage ${groupName}/${member}`),
              { group: groupName, failFast },
            )
            add(stage)
            exits.push(stage.name)
          }
        }
        return ref(groupName, 'group', exits)
      },
      matrix: <const A extends MatrixAxes>(
        matrixName: string,
        options: MatrixOptions<A>,
      ): StageRef => {
        matrixName = name(matrixName)
        if (!isRecord(options) || !isRecord(options.axes))
          throw new GraphError(`Matrix ${matrixName} needs axes`)
        const axes = Object.entries(options.axes)
        if (
          axes.length === 0 ||
          axes.some(
            ([axis, values]) =>
              !/^[A-Za-z_][A-Za-z0-9_]*$/.test(axis) ||
              !Array.isArray(values) ||
              values.length === 0 ||
              values.some(
                (v) => !['string', 'number', 'boolean'].includes(typeof v),
              ),
          )
        )
          throw new GraphError(
            `Matrix ${matrixName}: every axis is a non-empty list of values`,
          )
        let combinations: Array<Record<string, string | number | boolean>> = [
          {},
        ]
        for (const [axis, values] of axes)
          combinations = combinations.flatMap((combination) =>
            (values as Array<string | number | boolean>).map((value) => ({
              ...combination,
              [axis]: value,
            })),
          )
        const exclude = options.exclude ?? []
        if (!Array.isArray(exclude))
          throw new GraphError(`Matrix ${matrixName}: exclude must be a list`)
        combinations = combinations.filter(
          (combination) =>
            !exclude.some(
              (rule) =>
                isRecord(rule) &&
                Object.entries(rule).every(
                  ([axis, value]) => combination[axis] === value,
                ),
            ),
        )
        if (combinations.length === 0)
          throw new GraphError(
            `Matrix ${matrixName} excludes every combination`,
          )
        if (combinations.length > limits.matrix)
          throw new GraphError(
            `Matrix ${matrixName} has ${combinations.length} combinations; at most ${limits.matrix}`,
          )
        const needs = resolve(options.needs, `Matrix ${matrixName}`)
        const failFast = options.failFast ?? workflow.failFast
        const exits: string[] = []
        for (const combination of combinations) {
          const label = Object.entries(combination)
            .map(([axis, value]) => `${axis}=${String(value)}`)
            .join(',')
          const resolved: Record<string, unknown> = {}
          for (const [key, value] of Object.entries(options))
            if (!['axes', 'exclude', 'failFast', 'needs', 'run'].includes(key))
              resolved[key] =
                typeof value === 'function'
                  ? (value as (c: typeof combination) => unknown)(combination)
                  : value
          const stage = this.stageOf(
            `${matrixName}[${label}]`,
            {
              ...(resolved as Partial<StageOptions>),
              run: options.run,
            } as StageOptions,
            workflow,
            needs,
            { group: matrixName, failFast, matrix: combination },
          )
          add(stage)
          exits.push(stage.name)
        }
        return ref(matrixName, 'group', exits)
      },
      approval: (approvalName, options?: ApprovalOptions): StageRef => {
        approvalName = name(approvalName)
        if (options != null && !isRecord(options))
          throw new GraphError(
            `Approval ${approvalName} needs an options object`,
          )
        const allowed = options?.roles ?? ['admin', 'manager']
        if (
          !Array.isArray(allowed) ||
          allowed.length === 0 ||
          allowed.some((role) => !roles.includes(role))
        )
          throw new GraphError(`Approval ${approvalName}: unknown role`)
        add({
          ...defaults(approvalName, workflow.failFast),
          kind: 'approval',
          needs: resolve(
            options?.needs as StageRef[] | undefined,
            `Approval ${approvalName}`,
          ),
          approval: {
            roles: allowed,
            ...(typeof options?.message === 'string'
              ? { message: options.message }
              : {}),
            ...(options?.timeout == null
              ? {}
              : {
                  timeout: seconds(
                    options.timeout,
                    `Approval ${approvalName} timeout`,
                  ),
                }),
            params: paramSpecs(
              options?.params,
              `Approval ${approvalName} params`,
            ),
          },
        })
        return ref(approvalName, 'approval', [approvalName])
      },
      post: (stages: PostStages): void => {
        if (!isRecord(stages)) throw new GraphError('post needs an object')
        for (const [condition, options] of Object.entries(stages)) {
          if (!postConditions.includes(condition as PostCondition))
            throw new GraphError(`Unknown post condition ${condition}`)
          add({
            ...this.stageOf(
              `post/${condition}`,
              options as StageOptions,
              workflow,
              [],
            ),
            post: condition as PostCondition,
          })
        }
      },
    }
  }

  private stageOf(
    stageName: string,
    options: StageOptions,
    workflow: GraphWorkflow,
    needs: string[],
    extra: {
      group?: string
      failFast?: boolean
      matrix?: Record<string, string | number | boolean>
    } = {},
  ): GraphStage {
    const what = `Stage ${stageName}`
    if (!isRecord(options)) throw new GraphError(`${what} needs options`)
    if (typeof options.run !== 'function')
      throw new GraphError(`${what} needs a run function`)
    const run = this.names.get(options.run)
    if (run == null)
      throw new GraphError(
        `${what}: its run function ${options.run.name === '' ? '(anonymous)' : options.run.name} is not exported from the Masonfile`,
      )
    const retry =
      options.retry == null
        ? { attempts: 1, on: ['failed', 'interrupted', 'timed_out'] }
        : typeof options.retry === 'number'
          ? {
              attempts: options.retry,
              on: ['failed', 'interrupted', 'timed_out'],
            }
          : {
              attempts: options.retry.attempts,
              on: options.retry.on ?? ['failed', 'interrupted', 'timed_out'],
            }
    if (
      !Number.isSafeInteger(retry.attempts) ||
      retry.attempts < 1 ||
      retry.attempts > 10 ||
      !Array.isArray(retry.on) ||
      retry.on.some(
        (kind) => !['failed', 'interrupted', 'timed_out'].includes(kind),
      )
    )
      throw new GraphError(`${what}: retry is 1–10 attempts`)
    const checkout =
      options.checkout === false
        ? { enabled: false, submodules: false, lfs: false }
        : {
            enabled: true,
            submodules:
              isRecord(options.checkout) &&
              options.checkout.submodules === true,
            lfs: isRecord(options.checkout) && options.checkout.lfs === true,
            ...(isRecord(options.checkout) && options.checkout.depth != null
              ? { depth: Number(options.checkout.depth) }
              : {}),
          }
    if (
      checkout.depth != null &&
      (!Number.isSafeInteger(checkout.depth) || checkout.depth < 1)
    )
      throw new GraphError(`${what}: checkout depth is a positive whole number`)
    const space = options.workspace ?? 'clean'
    const workspace =
      space === 'clean' || space === 'reuse'
        ? { mode: space }
        : isRecord(space) &&
            typeof space.path === 'string' &&
            space.path.length > 0
          ? { mode: space.mode ?? 'reuse', path: space.path }
          : undefined
    if (workspace == null || !['clean', 'reuse'].includes(workspace.mode))
      throw new GraphError(
        `${what}: workspace is clean, reuse or { path, mode }`,
      )
    if (workspace.path != null && workspace.path.split('/').includes('..'))
      throw new GraphError(`${what}: a workspace path cannot contain ..`)
    const cache = options.cache ?? []
    if (
      !Array.isArray(cache) ||
      cache.some(
        (entry) =>
          !isRecord(entry) ||
          typeof entry.key !== 'string' ||
          strings(entry.paths, `${what} cache paths`).length === 0,
      )
    )
      throw new GraphError(`${what}: cache entries have a key and paths`)
    const apple = options.apple
    if (
      apple != null &&
      (!isRecord(apple) ||
        ![
          'development',
          'adHoc',
          'appStore',
          'developerId',
          'macAppStore',
        ].includes(apple.distribution as string))
    )
      throw new GraphError(`${what}: unknown apple distribution`)
    if (
      apple != null &&
      ((apple.app != null && typeof apple.app !== 'string') ||
        (apple.bundleIds != null &&
          strings(apple.bundleIds, `${what} apple bundle IDs`).length === 0))
    )
      throw new GraphError(
        `${what}: apple.app is an app ID and apple.bundleIds a list of bundle IDs`,
      )
    return {
      ...defaults(stageName, extra.failFast ?? workflow.failFast),
      ...(extra.group == null ? {} : { group: extra.group }),
      run,
      on: selector(options.on, what),
      needs,
      ...(options.when == null ? {} : { when: when(options.when, what) }),
      ...(options.tools == null ? {} : { tools: tools(options.tools, what) }),
      secrets: strings(options.secrets, `${what} secrets`),
      env: environment(options.env, `${what} env`),
      timeout:
        options.timeout == null
          ? 2 * 3600
          : seconds(options.timeout, `${what} timeout`),
      ...(options.activityTimeout == null
        ? {}
        : {
            activityTimeout: seconds(
              options.activityTimeout,
              `${what} activityTimeout`,
            ),
          }),
      retry: retry as GraphStage['retry'],
      lock: strings(options.lock, `${what} lock`),
      ...(apple == null ? {} : { apple }),
      publishes: strings(options.publishes, `${what} publishes`),
      buildNumbers: strings(options.buildNumbers, `${what} buildNumbers`),
      checkout,
      workspace: workspace as GraphStage['workspace'],
      cache: cache.map((entry) => ({
        key: entry.key,
        paths: [...entry.paths],
      })),
      continueOnError: options.continueOnError === true,
      requireSuccess: options.requireSuccess === true,
      matrix: extra.matrix ?? {},
    }
  }
}

function defaults(name: string, failFast: boolean): GraphStage {
  return {
    name,
    kind: 'stage',
    needs: [],
    secrets: [],
    env: {},
    timeout: 2 * 3600,
    retry: { attempts: 1, on: ['failed', 'interrupted', 'timed_out'] },
    lock: [],
    publishes: [],
    buildNumbers: [],
    checkout: { enabled: true, submodules: false, lfs: false },
    workspace: { mode: 'clean' },
    cache: [],
    continueOnError: false,
    requireSuccess: false,
    failFast,
    matrix: {},
  }
}

/** Rejects cycles and oversize graphs; run on recorded and received graphs alike. */
function checkStructure(graph: Graph): void {
  if (Buffer.byteLength(JSON.stringify(graph)) > limits.graphBytes)
    throw new GraphError('The recorded graph is larger than 1 MiB')
  for (const workflow of graph.workflows) {
    const byName = new Map(workflow.stages.map((stage) => [stage.name, stage]))
    const state = new Map<string, 'visiting' | 'done'>()
    const visit = (name: string, path: string[]): void => {
      if (state.get(name) === 'done') return
      if (state.get(name) === 'visiting')
        throw new GraphError(
          `Workflow ${workflow.name} has a cycle: ${[...path, name].join(' → ')}`,
        )
      state.set(name, 'visiting')
      const stage = byName.get(name)
      if (stage == null)
        throw new GraphError(
          `Workflow ${workflow.name} needs unknown stage ${name}`,
        )
      for (const need of stage.needs) visit(need, [...path, name])
      state.set(name, 'done')
    }
    for (const stage of workflow.stages) visit(stage.name, [])
  }
}

export interface ProjectFacts {
  /** Bundle IDs the project owns. */
  apps: string[]
  /** Bundle IDs each app ID signs (the app and its extensions). */
  signs?: Record<string, string[]>
  /** Names a stage may declare in `secrets`: environment values and injected files. */
  secrets: string[]
  /** Known node type names; omitted means any name is accepted. */
  nodeTypes?: string[]
  /**
   * Check the structure only, not what the project owns: the add-project
   * wizard reads a Masonfile to learn which app IDs and secrets it names.
   */
  structureOnly?: boolean
}

/**
 * The master's check of a graph a setup run returned: structure, then what
 * a branch must not grant itself — app IDs and secrets the project does not
 * have, and node types that do not exist.
 */
export function validateGraph(value: unknown, project: ProjectFacts): Graph {
  if (!isRecord(value) || !Array.isArray(value.workflows))
    throw new GraphError('Setup returned no graph')
  const graph = value as unknown as Graph
  if (!apiVersions.includes(graph.apiVersion))
    throw new GraphError(
      `Masonfile API version ${String(graph.apiVersion)} is not supported`,
    )
  checkStructure(graph)
  const names = new Set<string>()
  for (const workflow of graph.workflows) {
    if (names.has(workflow.name))
      throw new GraphError(`Workflow ${workflow.name} is declared twice`)
    names.add(workflow.name)
    const stageNames = new Set<string>()
    for (const stage of [...workflow.stages, ...workflow.post]) {
      if (stageNames.has(stage.name))
        throw new GraphError(`Stage ${stage.name} is declared twice`)
      stageNames.add(stage.name)
      const what = `Stage ${stage.name}`
      if (stage.kind === 'approval') continue
      selector(stage.on, what)
      tools(stage.tools, what)
      if (project.structureOnly === true) continue
      if (
        typeof stage.on === 'string' &&
        stage.on !== 'master' &&
        project.nodeTypes != null &&
        !project.nodeTypes.includes(stage.on)
      )
        throw new GraphError(`${what} runs on unknown node type ${stage.on}`)
      for (const secret of stage.secrets)
        if (!project.secrets.includes(secret))
          throw new GraphError(
            `${what} declares secret ${secret}, which the project does not have`,
          )
      const apps = [
        ...stage.publishes,
        ...(stage.apple?.app == null ? [] : [stage.apple.app]),
      ]
      for (const app of apps)
        if (!project.apps.includes(app))
          throw new GraphError(
            `${what} names app ID ${app}, which this project does not own`,
          )
      // A stage signs only bundle IDs its app ID is configured to sign.
      const signs =
        stage.apple?.app == null
          ? Object.values(project.signs ?? {}).flat()
          : (project.signs?.[stage.apple.app] ?? [stage.apple.app])
      for (const bundleId of stage.apple?.bundleIds ?? [])
        if (!signs.includes(bundleId) && !project.apps.includes(bundleId))
          throw new GraphError(
            `${what} signs bundle ID ${bundleId}, which no app ID of this project signs`,
          )
    }
    for (const trigger of workflow.triggers)
      if (
        'after' in trigger &&
        !graph.workflows.some((other) => other.name === trigger.after.workflow)
      )
        throw new GraphError(
          `Workflow ${workflow.name} runs after unknown workflow ${trigger.after.workflow}`,
        )
  }
  return graph
}

/** The graph of a `script` project: one `build` stage running the Masonfile as today. */
export function scriptGraph(project: {
  timeoutSeconds: number
  script: { on?: NodeSelector }
}): Graph {
  return {
    apiVersion: 1,
    format: 'script',
    workflows: [
      {
        name: 'build',
        triggers: [{ push: true }, { request: true }],
        params: {},
        env: {},
        timeout: project.timeoutSeconds,
        concurrency: { group: 'branch', cancelPrevious: false },
        keep: { stashes: 3 },
        failFast: true,
        stages: [
          {
            ...defaults('build', true),
            kind: 'script',
            on: project.script.on ?? { os: 'macos' },
            timeout: project.timeoutSeconds,
          },
        ],
        post: [],
      },
    ],
    buildNumbers: {},
    warnings: [],
  }
}

export interface WhenFacts {
  branch: string
  trigger: TriggerKind
  params: Record<string, ParamValue>
  /** Files changed since the workflow's last successful run on the branch; unknown runs every `changed` stage. */
  changed?: string[]
}

/** Whether a stage's `when` holds; every field present must match. */
export function evaluateWhen(
  condition: When | undefined,
  facts: WhenFacts,
): boolean {
  if (condition == null) return true
  if (
    condition.branch != null &&
    !condition.branch.some((pattern) => matches(pattern, facts.branch))
  )
    return false
  if (
    condition.notBranch?.some((pattern) => matches(pattern, facts.branch)) ===
    true
  )
    return false
  if (condition.trigger != null && !condition.trigger.includes(facts.trigger))
    return false
  if (
    condition.params != null &&
    Object.entries(condition.params).some(
      ([name, value]) => facts.params[name] !== value,
    )
  )
    return false
  if (
    condition.changed != null &&
    facts.changed != null &&
    !facts.changed.some((file) =>
      condition.changed!.some((pattern) => matches(pattern, file)),
    )
  )
    return false
  return true
}

export type StageState =
  | StageStatus
  | 'queued'
  | 'running'
  | 'awaiting_approval'
  | 'preparing'
const terminal = new Set<StageState>([
  'succeeded',
  'unstable',
  'failed',
  'cancelled',
  'timed_out',
  'interrupted',
  'skipped',
])
export const isTerminal = (state: StageState | undefined): boolean =>
  state != null && terminal.has(state)

/**
 * What happens to a main-graph stage now: `wait` while anything it needs is
 * unfinished; `skip` when a dependency did not succeed (or was `unstable`
 * under `requireSuccess`) or its `when` is false; otherwise `run`.
 */
export function decide(
  stage: GraphStage,
  states: Record<string, StageState | undefined>,
  facts: WhenFacts,
): 'wait' | 'run' | 'skip' {
  const needs = stage.needs.map((need) => states[need])
  if (needs.some((state) => !isTerminal(state))) return 'wait'
  if (
    needs.some(
      (state) =>
        state !== 'succeeded' && (state !== 'unstable' || stage.requireSuccess),
    )
  )
    return 'skip'
  return evaluateWhen(stage.when, facts) ? 'run' : 'skip'
}

/** A run's status from its finished stages: any failure fails it, then cancellation, then unstable. */
export function runStatus(
  states: StageState[],
  stages?: GraphStage[],
):
  | 'succeeded'
  | 'unstable'
  | 'failed'
  | 'cancelled'
  | 'timed_out'
  | 'interrupted' {
  let out: ReturnType<typeof runStatus> = 'succeeded'
  const rank = [
    'succeeded',
    'unstable',
    'cancelled',
    'interrupted',
    'timed_out',
    'failed',
  ]
  states.forEach((state, i) => {
    let mapped: ReturnType<typeof runStatus> | undefined =
      state === 'skipped' || state === 'succeeded'
        ? undefined
        : (state as ReturnType<typeof runStatus>)
    if (
      stages?.[i]?.continueOnError === true &&
      ['failed', 'timed_out', 'interrupted'].includes(state)
    )
      mapped = 'unstable'
    if (mapped != null && rank.indexOf(mapped) > rank.indexOf(out)) out = mapped
  })
  return out
}

/**
 * Whether a post stage runs, given the main graph's result and the status of
 * the previous run of the same workflow and branch, if there was one.
 */
export function postRuns(
  condition: PostCondition,
  status: ReturnType<typeof runStatus>,
  previous: string | undefined,
): boolean {
  switch (condition) {
    case 'always':
      return true
    case 'success':
      return status === 'succeeded'
    case 'unstable':
      return status === 'unstable'
    case 'failure':
      return (
        status === 'failed' ||
        status === 'timed_out' ||
        status === 'interrupted'
      )
    case 'aborted':
      return status === 'cancelled'
    case 'fixed':
      return (
        status === 'succeeded' && previous != null && previous !== 'succeeded'
      )
    case 'regression':
      return (
        status !== 'succeeded' &&
        status !== 'cancelled' &&
        previous === 'succeeded'
      )
  }
}
