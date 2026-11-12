// The run page's actions, each through the run API (on the host, forwarded
// to the master): an approval decided with its parameters, Request run with
// a workflow's typed parameters, Cancel (confirmed once the run has started)
// and Restart from a stage. Each shows its busy state, says what happened
// in a toast, and keeps the node's refusal next to the control.
import { useRef, useState, type FormEvent, type JSX } from 'react'
import { useNavigate } from 'react-router'
import {
  asCancelled,
  asRunCreated,
  runActionPath,
  type RunPage,
} from '../../../shared/api/index.js'
import { useApi } from '../../api/context.js'
import { Alert } from '../../ui/Alert.js'
import { Button } from '../../ui/Button.js'
import { FormError, TextInput } from '../../ui/Field.js'
import { Icon } from '../../ui/Icon.js'
import { Sheet } from '../../ui/Sheet.js'
import { useToast } from '../../ui/Toast.js'
import { runName } from '../artifacts/Artifacts.js'
import { roleList, workflowParams } from './model.js'
import {
  ParamFields,
  paramDefaults,
  typedParams,
  type ParamTexts,
} from './params.js'

/** Where the run page for a run is. */
export const runHref = (id: string): string => `/runs/${encodeURIComponent(id)}`

/** A reason an action cannot be used now, beside or on its control. */
export interface Unavailable {
  reason: string
}

/**
 * A stage waiting for approval: its message and parameters with Approve and
 * Reject for whoever may decide, else who it waits for.
 */
export function ApprovalBox({
  run,
  stage,
  canDecide,
  unavailable,
  onDecided,
}: {
  run: RunPage
  stage: string
  canDecide: boolean
  unavailable?: Unavailable | undefined
  onDecided: () => void
}): JSX.Element {
  const client = useApi()
  const toast = useToast()
  const approval = run.graph?.approvals[stage]
  const specs = approval?.params ?? {}
  const [values, setValues] = useState<ParamTexts>(() => paramDefaults(specs))
  const [errors, setErrors] = useState<ParamTexts>({})
  const [busy, setBusy] = useState<'approve' | 'reject' | undefined>()
  const [failed, setFailed] = useState<string | undefined>()
  const error = useRef<HTMLParagraphElement>(null)
  const roles = approval?.roles ?? ['admin', 'manager']
  if (!canDecide)
    return (
      <section
        className="m-approval m-approval--waiting"
        aria-label={`Approval of ${stage}`}
      >
        <div className="m-approval__head">
          <Icon name="pan_tool" />
          <span>{stage} waits for approval</span>
        </div>
        {approval?.message != null && (
          <p className="m-t-callout m-approval__message">{approval.message}</p>
        )}
        <p className="m-t-callout m-secondary">
          Waiting for {roleList(roles)} to approve.
        </p>
      </section>
    )
  const decide = async (approve: boolean): Promise<void> => {
    let params: Record<string, string | number | boolean> = {}
    if (approve) {
      const typed = typedParams(specs, values)
      setErrors(typed.errors)
      if (Object.keys(typed.errors).length > 0) return
      params = typed.params
    }
    setBusy(approve ? 'approve' : 'reject')
    setFailed(undefined)
    try {
      await client.post(runActionPath(run.id, 'approve'), asRunCreated, {
        body: {
          stage,
          approve,
          ...(approve && Object.keys(params).length > 0 ? { params } : {}),
        },
      })
      toast({
        text: `${stage} ${approve ? 'approved' : 'rejected'}`,
        icon: approve ? 'check_circle' : 'block',
      })
      onDecided()
    } catch (reason) {
      setFailed((reason as Error).message)
      setTimeout(() => error.current?.focus(), 0)
    } finally {
      setBusy(undefined)
    }
  }
  return (
    <section
      className="m-approval"
      aria-labelledby={`approval-${stage}`}
      data-approval={stage}
    >
      <div className="m-approval__head">
        <Icon name="pan_tool" />
        <span id={`approval-${stage}`}>{stage} waits for your approval</span>
      </div>
      {approval?.message != null && (
        <p className="m-t-callout m-approval__message">{approval.message}</p>
      )}
      {Object.keys(specs).length > 0 && (
        <div className="m-approval__fields">
          <ParamFields
            specs={specs}
            values={values}
            errors={errors}
            onChange={(name, value) =>
              setValues((was) => ({ ...was, [name]: value }))
            }
          />
        </div>
      )}
      {failed != null && <FormError ref={error}>{failed}</FormError>}
      <div className="m-btngroup">
        <Button
          variant="primary"
          icon="check"
          busy={busy === 'approve'}
          disabled={unavailable != null || busy === 'reject'}
          title={unavailable?.reason}
          onClick={() => void decide(true)}
        >
          Approve
        </Button>
        <Button
          variant="danger"
          icon="block"
          busy={busy === 'reject'}
          disabled={unavailable != null || busy === 'approve'}
          title={unavailable?.reason}
          onClick={() => void decide(false)}
        >
          Reject
        </Button>
      </div>
      {unavailable != null && (
        <p className="m-t-subhead m-secondary">{unavailable.reason}</p>
      )}
    </section>
  )
}

/** The Request run sheet: branch, workflow and that workflow's typed parameters. */
export function RequestSheet({
  run,
  open,
  onClose,
}: {
  run: RunPage
  open: boolean
  onClose: () => void
}): JSX.Element {
  const client = useApi()
  const toast = useToast()
  const navigate = useNavigate()
  const workflows = run.graph?.workflows?.map((entry) => entry.name)
  const [branch, setBranch] = useState(run.branch)
  const [workflow, setWorkflow] = useState(run.workflow)
  const specs = workflowParams(run, workflow)
  const [values, setValues] = useState<ParamTexts>(() =>
    paramDefaults(workflowParams(run, run.workflow)),
  )
  const [errors, setErrors] = useState<ParamTexts>({})
  const [branchError, setBranchError] = useState<string | undefined>()
  const [failed, setFailed] = useState<string | undefined>()
  const [busy, setBusy] = useState(false)
  const error = useRef<HTMLParagraphElement>(null)
  const initial = useRef(
    JSON.stringify([
      run.branch,
      run.workflow,
      paramDefaults(workflowParams(run, run.workflow)),
    ]),
  )
  const dirty = JSON.stringify([branch, workflow, values]) !== initial.current
  const reset = (): void => {
    setBranch(run.branch)
    setWorkflow(run.workflow)
    setValues(paramDefaults(workflowParams(run, run.workflow)))
    setErrors({})
    setBranchError(undefined)
    setFailed(undefined)
  }
  const close = (): void => {
    reset()
    onClose()
  }
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    const typed = typedParams(specs, values)
    setErrors(typed.errors)
    const noBranch = branch.trim() === '' ? 'Enter a branch.' : undefined
    setBranchError(noBranch)
    if (noBranch != null || Object.keys(typed.errors).length > 0) return
    setBusy(true)
    setFailed(undefined)
    try {
      const created = await client.post('/api/v2/runs', asRunCreated, {
        body: {
          project: run.project.slug,
          branch: branch.trim(),
          workflow,
          ...(Object.keys(typed.params).length > 0
            ? { params: typed.params }
            : {}),
        },
      })
      toast({
        text: `${runName(workflow, created.number)} requested`,
        icon: 'play_arrow',
      })
      reset()
      onClose()
      navigate(runHref(created.id))
    } catch (reason) {
      setFailed((reason as Error).message)
      setTimeout(() => error.current?.focus(), 0)
    } finally {
      setBusy(false)
    }
  }
  const formId = `request-run-${run.id}`
  return (
    <Sheet
      open={open}
      onClose={close}
      title="Request a run"
      dirty={dirty}
      footer={(requestClose) => (
        <>
          <Button variant="secondary" onClick={requestClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            icon="play_arrow"
            type="submit"
            form={formId}
            busy={busy}
          >
            Request
          </Button>
        </>
      )}
    >
      <form
        id={formId}
        name="request-run"
        className="m-stack"
        noValidate
        onSubmit={(event) => void submit(event)}
      >
        <p className="m-t-callout m-secondary">
          A new run of <strong>{run.project.name}</strong>.
        </p>
        <div className="m-grid-2">
          <TextInput
            label="Branch"
            value={branch}
            onChange={setBranch}
            error={branchError}
            name="branch"
            mono
            verbatim
            required
          />
          {workflows != null && workflows.length > 0 ? (
            <div className="m-field">
              <label className="m-field__label" htmlFor={`${formId}-workflow`}>
                Workflow
              </label>
              <select
                id={`${formId}-workflow`}
                name="workflow"
                className="m-select"
                value={workflow}
                onChange={(event) => {
                  setWorkflow(event.target.value)
                  setValues(
                    paramDefaults(workflowParams(run, event.target.value)),
                  )
                  setErrors({})
                }}
              >
                {workflows.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </div>
          ) : (
            <TextInput
              label="Workflow"
              value={workflow}
              onChange={(value) => {
                setWorkflow(value)
                setValues(paramDefaults(workflowParams(run, value)))
              }}
              name="workflow"
              mono
              verbatim
            />
          )}
        </div>
        {Object.keys(specs).length > 0 && (
          <fieldset className="m-formsection">
            <legend className="m-t-eyebrow">Parameters of {workflow}</legend>
            <ParamFields
              specs={specs}
              values={values}
              errors={errors}
              onChange={(name, value) =>
                setValues((was) => ({ ...was, [name]: value }))
              }
            />
          </fieldset>
        )}
        {failed != null && <FormError ref={error}>{failed}</FormError>}
      </form>
    </Sheet>
  )
}

/**
 * Cancel run: a queued run goes at once (tier 1); one that has started asks
 * first, naming it (tier 2).
 */
export function CancelAction({
  run,
  status,
  unavailable,
  onCancelled,
}: {
  run: RunPage
  status: string
  unavailable?: Unavailable | undefined
  onCancelled: () => void
}): JSX.Element {
  const client = useApi()
  const toast = useToast()
  const [asking, setAsking] = useState(false)
  const [busy, setBusy] = useState(false)
  const name = runName(run.workflow, run.number)
  const cancel = async (): Promise<void> => {
    setBusy(true)
    try {
      const answer = await client.post(
        runActionPath(run.id, 'cancel'),
        asCancelled,
        { body: {} },
      )
      setAsking(false)
      toast({
        text: answer.cancelled
          ? `${name} cancelled`
          : `${name} had already ended`,
        icon: 'block',
      })
      onCancelled()
    } catch (reason) {
      setAsking(false)
      toast({ text: (reason as Error).message, icon: 'error' })
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <Button
        variant="danger"
        icon="stop_circle"
        busy={busy && !asking}
        disabled={unavailable != null}
        title={unavailable?.reason}
        onClick={() => {
          if (status === 'queued') void cancel()
          else setAsking(true)
        }}
      >
        Cancel run
      </Button>
      <Alert
        open={asking}
        title={`Cancel ${name}?`}
        message={`${name} of ${run.project.name} on ${run.branch} stops: its running stages are stopped and the rest never start.`}
        cancel="Keep running"
        confirm="Cancel run"
        tone="danger"
        busy={busy}
        onCancel={() => setAsking(false)}
        onConfirm={() => void cancel()}
      />
    </>
  )
}

/** Restart from a stage: a new run that keeps what came before it. */
export function RestartAction({
  run,
  stage,
  finished,
  unavailable,
}: {
  run: RunPage
  stage: string
  finished: boolean
  unavailable?: Unavailable | undefined
}): JSX.Element {
  const client = useApi()
  const toast = useToast()
  const navigate = useNavigate()
  const [busy, setBusy] = useState(false)
  const reason =
    unavailable?.reason ??
    (finished ? undefined : 'Available when the run has finished')
  return (
    <span className="m-row m-restart">
      <Button
        variant="secondary"
        size="sm"
        icon="replay"
        busy={busy}
        disabled={reason != null}
        title={reason}
        onClick={() => {
          setBusy(true)
          client
            .post(runActionPath(run.id, 'restart'), asRunCreated, {
              body: { stage },
            })
            .then(
              (created) => {
                toast({
                  text: `${runName(run.workflow, created.number)} restarts from ${stage}`,
                  icon: 'replay',
                })
                navigate(runHref(created.id))
              },
              (failure: unknown) =>
                toast({ text: (failure as Error).message, icon: 'error' }),
            )
            .finally(() => setBusy(false))
        }}
      >
        Restart from {stage.split('/').pop()}
      </Button>
      {reason != null && (
        <span className="m-t-subhead m-tertiary">{reason}</span>
      )}
    </span>
  )
}
