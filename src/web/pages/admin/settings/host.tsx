// Settings → Host and Cloud budget (screen-10b-settings-more,
// screen-10-settings): inline forms in their cards. The host's address
// decides where invitation links open, so only an administrator changes it
// (signIn.change); managers read it as a sentence. The budget caps what
// cloud pools spend in a month.
import { useState, type FormEvent, type JSX } from 'react'
import { Link } from 'react-router'
import {
  asCloudSetting,
  asHostSetting,
  CLOUD_BUDGET_SETTING_PATH,
  settingsPath,
  type HostSetting,
} from '../../../../shared/api/settings.js'
import type { Resource } from '../../../hooks/useResource.js'
import { useApi } from '../../../api/context.js'
import { useResource } from '../../../hooks/useResource.js'
import { Button } from '../../../ui/Button.js'
import { TextInput } from '../../../ui/Field.js'
import { useToast } from '../../../ui/Toast.js'
import { Failure, isHttps, Read, SettingsCard, useActions } from './parts.js'

/** The offline grace window's default, in hours. */
export const GRACE_HOURS = 72

/** What a manager reads of the host. */
export function hostSentence(host: HostSetting): string {
  return `Host address: ${host.origin ?? 'not set'}${
    host.workerOrigin == null
      ? ''
      : `; workers reach it at ${host.workerOrigin}`
  }; it serves from its cache for ${host.offlineGraceHours ?? GRACE_HOURS} hours without the master. Invitation links open there, so only an administrator changes it.`
}

/** An administrator's form: the addresses and the grace window. */
function HostForm({
  host,
  done,
}: {
  host: HostSetting
  done: () => void
}): JSX.Element {
  const client = useApi()
  const toast = useToast()
  const actions = useActions()
  const [origin, setOrigin] = useState(host.origin ?? '')
  const [workerOrigin, setWorkerOrigin] = useState(host.workerOrigin ?? '')
  const [grace, setGrace] = useState(
    String(host.offlineGraceHours ?? GRACE_HOURS),
  )
  const [errors, setErrors] = useState<{
    origin?: string
    workerOrigin?: string
    grace?: string
  }>({})
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    const hours = Number(grace)
    const wrong = {
      ...(isHttps(origin) ? {} : { origin: 'Enter an https address.' }),
      ...(workerOrigin.trim() === '' || isHttps(workerOrigin)
        ? {}
        : { workerOrigin: 'Enter an https address, or leave it empty.' }),
      ...(/^[0-9]+$/.test(grace.trim()) && hours >= 1 && hours <= 720
        ? {}
        : { grace: 'Enter whole hours from 1 to 720.' }),
    }
    setErrors(wrong)
    if (Object.keys(wrong).length > 0) return
    const ok = await actions.run('host', async () => {
      await client.put(settingsPath('host'), asHostSetting, {
        body: {
          origin: origin.trim(),
          ...(workerOrigin.trim() === ''
            ? {}
            : { workerOrigin: workerOrigin.trim() }),
          offlineGraceHours: hours,
        },
      })
    })
    if (!ok) return
    toast({ text: 'Host saved', icon: 'check_circle' })
    done()
  }
  return (
    <form
      className="m-card__body m-stack"
      aria-label="Host"
      noValidate
      onSubmit={(event) => void submit(event)}
    >
      <div className="m-formsection__grid">
        <TextInput
          label="Host address"
          value={origin}
          onChange={setOrigin}
          error={errors.origin}
          placeholder="https://builds.example.com"
          help="The https address people, devices and webhooks use. Invitation links open here."
          inputMode="url"
          autoComplete="url"
          mono
          verbatim
          required
        />
        <TextInput
          label="Worker address"
          optional
          value={workerOrigin}
          onChange={setWorkerOrigin}
          error={errors.workerOrigin}
          placeholder="https://10.0.0.5:9310"
          help="Only when cloud machines reach the host at another address; empty uses the host address."
          inputMode="url"
          autoComplete="off"
          mono
          verbatim
        />
        <TextInput
          label="Offline grace hours"
          value={grace}
          onChange={setGrace}
          error={errors.grace}
          help="How long the host keeps serving installs while it cannot reach the master. 1–720."
          inputMode="numeric"
          autoComplete="off"
          mono
          required
        />
      </div>
      <Failure actions={actions} name="host" />
      <div className="m-form__actions">
        <Button
          variant="primary"
          type="submit"
          icon="check"
          busy={actions.busy === 'host'}
        >
          Save
        </Button>
      </div>
    </form>
  )
}

/** Settings → Host; the page reads the area, which Sign-in uses too. */
export function HostCard({
  read,
  admin,
}: {
  read: Resource<HostSetting>
  /** An administrator (signIn.change): the form, else the sentence. */
  admin: boolean
}): JSX.Element {
  return (
    <SettingsCard
      id="host"
      icon="cloud"
      title="Host"
      actions={
        !admin && (
          <span className="m-t-subhead m-tertiary">
            Administrators change this
          </span>
        )
      }
    >
      <Read read={read} what="The host">
        {(host) => (
          <>
            <div className="m-card__body">
              <p className="m-t-callout m-secondary">
                Where the host is served. A host the master makes on
                DigitalOcean fills this in.
              </p>
            </div>
            {admin ? (
              <HostForm host={host} done={read.reload} />
            ) : (
              <div className="m-card__body">
                <p className="m-t-callout m-settings__readonly">
                  {hostSentence(host)}
                </p>
              </div>
            )}
          </>
        )}
      </Read>
    </SettingsCard>
  )
}

/** The monthly budget's form. */
function BudgetForm({
  budget,
  done,
}: {
  budget: number | undefined
  done: () => void
}): JSX.Element {
  const client = useApi()
  const toast = useToast()
  const actions = useActions()
  const [text, setText] = useState(String(budget ?? 200))
  const [error, setError] = useState<string | undefined>()
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    const dollars = Number(text.trim())
    if (text.trim() === '' || !Number.isFinite(dollars) || dollars < 0) {
      setError('Enter dollars, 0 or more.')
      return
    }
    setError(undefined)
    const ok = await actions.run('budget', async () => {
      await client.put(CLOUD_BUDGET_SETTING_PATH, asCloudSetting, {
        body: { monthlyBudget: dollars },
      })
    })
    if (!ok) return
    toast({ text: `Monthly budget is $${dollars}`, icon: 'check_circle' })
    done()
  }
  return (
    <form
      className="m-stack"
      aria-label="Cloud budget"
      noValidate
      onSubmit={(event) => void submit(event)}
    >
      <div className="m-row m-settings__budgetform">
        <TextInput
          label="Monthly budget (dollars)"
          value={text}
          onChange={setText}
          error={error}
          help="Cloud pools stop making machines when this month’s spend would pass it."
          inputMode="decimal"
          autoComplete="off"
          mono
          required
        />
        <Button
          variant="primary"
          type="submit"
          icon="check"
          busy={actions.busy === 'budget'}
        >
          Save
        </Button>
      </div>
      <Failure actions={actions} name="budget" />
    </form>
  )
}

/** Settings → Cloud budget. */
export function BudgetCard(): JSX.Element {
  const read = useResource(settingsPath('cloud'), asCloudSetting)
  return (
    <SettingsCard id="cloud" icon="cloud" title="Cloud budget">
      <Read read={read} what="The cloud budget">
        {(cloud) => (
          <div className="m-card__body m-stack">
            <p className="m-t-callout m-secondary">
              Pools are edited on the <Link to="/nodes">Nodes</Link> page and
              cloud accounts on the <Link to="/cloud">Cloud</Link> page.
            </p>
            <BudgetForm budget={cloud.monthlyBudget} done={read.reload} />
          </div>
        )}
      </Read>
    </SettingsCard>
  )
}
