// Devices (screen-17-devices, 17b-devices-complete): how to register an
// iPhone or iPad here (not configured yet, through the host's own pages, or
// directly with the registration profile and its steps), the QR code that
// opens this page on a phone, the viewer's devices with their state, and
// every registered device for an administrator. While a device is with
// Apple the page reads itself again every 15 seconds and says politely
// what changed.
import {
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type JSX,
} from 'react'
import {
  asDevicesData,
  asRegistrationAnswer,
  deviceActionPath,
  DEVICES_PATH,
  REGISTRATIONS_PATH,
  type DeviceActionName,
  type DeviceInfo,
  type DevicesData,
} from '../../../shared/api/index.js'
import {
  deviceStateLabel,
  devicesPending,
  DEVICE_STATE_LABELS,
} from '../../../shared/catalog.js'
import { useApi } from '../../api/context.js'
import { useResource } from '../../hooks/useResource.js'
import { Page } from '../../layout/Page.js'
import { Alert } from '../../ui/Alert.js'
import { Count } from '../../ui/Badge.js'
import { Button, ButtonLink, buttonClass } from '../../ui/Button.js'
import { Chip } from '../../ui/Chip.js'
import { FormError, TextInput } from '../../ui/Field.js'
import { Icon } from '../../ui/Icon.js'
import { StatusPill } from '../../ui/StatusPill.js'
import { useToast } from '../../ui/Toast.js'
import { Loading } from '../projects/project.js'
import { asApiError, CatalogRefusal, CatalogState } from '../catalog/catalog.js'

/** How often Devices reads itself again while a device is with Apple. */
export const DEVICES_REFRESH_MS = 15_000
/** A device's longest name. */
export const DEVICE_NAME_MAX = 120

type Device = DeviceInfo & { name: string }

/** A device state's key in the status table: an error needs attention. */
export const deviceStatus = (status: string): string =>
  status === 'error' ? 'attention' : status

/** The QR code that opens Devices on a phone, beside its words. */
function Qr(): JSX.Element {
  return (
    <figure className="m-catalog-qr">
      <div className="m-qr">
        <img
          src="/devices/qr"
          width={160}
          height={160}
          alt="QR code to open Mason device registration"
        />
      </div>
      <figcaption className="m-t-subhead m-secondary">
        Using a computer? Scan this code with your iPhone or iPad, then sign in.
      </figcaption>
    </figure>
  )
}

const ANDROID =
  'Android and desktop apps can be downloaded without iOS device registration.'

/** Install registration profile: a one-time link, downloaded at once. */
function RegisterDirect(): JSX.Element {
  const client = useApi()
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState<string>()
  const [started, setStarted] = useState(false)
  const download = async (): Promise<void> => {
    setBusy(true)
    setFailed(undefined)
    try {
      const made = await client.post(REGISTRATIONS_PATH, asRegistrationAnswer)
      setStarted(true)
      client.leave(made.url)
    } catch (error) {
      setFailed(asApiError(error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="m-card" aria-labelledby="register-title">
      <header className="m-card__header">
        <div className="m-card__title">
          <Icon name="qr_code_2" />
          <h2 className="m-t-title3" id="register-title">
            Register an iPhone or iPad
          </h2>
        </div>
      </header>
      <div className="m-card__body m-catalog-register">
        <ol className="m-howto">
          <li>
            <div>
              <span className="m-t-headline">
                Open this page in Safari on the device
              </span>
              <span className="m-t-subhead m-secondary">
                Allow the profile download when Safari asks.
              </span>
            </div>
          </li>
          <li>
            <div>
              <span className="m-t-headline">
                Install the registration profile
              </span>
              <span className="m-t-subhead m-secondary">
                The temporary profile shares your device identifier, model and
                OS version. It does not install a root certificate or enroll
                your device in management.
              </span>
              <Button
                variant="primary"
                icon="download"
                busy={busy}
                className="m-catalog-start"
                onClick={() => void download()}
              >
                Install registration profile
              </Button>
              {started && (
                <p className="m-t-subhead m-secondary" role="status">
                  The profile is downloading. Its link works once, for five
                  minutes: press again for a new one.
                </p>
              )}
              {failed != null && <FormError>{failed}</FormError>}
            </div>
          </li>
          <li>
            <div>
              <span className="m-t-headline">
                Settings → Profile Downloaded → Install
              </span>
              <span className="m-t-subhead m-secondary">
                The registration profile may be shown as unsigned. Follow
                Apple’s prompts, then return to Mason. Compatible builds will be
                prepared automatically.
              </span>
              <span className="m-t-subhead m-secondary">
                If Profile Downloaded is missing, look in Settings → General →
                VPN & Device Management, or download the profile again. Apple
                removes uninstalled downloads after eight minutes.
              </span>
            </div>
          </li>
        </ol>
        <Qr />
      </div>
      <footer className="m-card__footer m-t-subhead m-secondary">
        {ANDROID}
      </footer>
    </section>
  )
}

/** A master without its own public address: registration is the host's. */
function RegisterOnHost({ host }: { host: string }): JSX.Element {
  return (
    <section className="m-card" aria-labelledby="register-title">
      <header className="m-card__header">
        <div className="m-card__title">
          <Icon name="qr_code_2" />
          <h2 className="m-t-title3" id="register-title">
            Register an iPhone or iPad
          </h2>
        </div>
      </header>
      <div className="m-card__body m-catalog-register">
        <div className="m-stack">
          <p className="m-t-callout m-secondary">
            Register your iPhone or iPad once to install Mason test builds.
            Installs on iPhone and iPad go through the host until the master has
            a public address.
          </p>
          <a
            className={buttonClass({
              variant: 'primary',
              className: 'm-catalog-start',
            })}
            href={`${host}/devices`}
          >
            <Icon name="open_in_new" />
            Register on the host
          </a>
        </div>
        <Qr />
      </div>
      <footer className="m-card__footer m-t-subhead m-secondary">
        {ANDROID}
      </footer>
    </section>
  )
}

/** One of the viewer's devices: its state and its actions. */
function DeviceCard({
  device,
  selected,
  busy,
  onAction,
  onRemove,
}: {
  device: Device
  selected: boolean
  busy: DeviceActionName | undefined
  onAction: (action: DeviceActionName, name?: string) => Promise<boolean>
  onRemove: () => void
}): JSX.Element {
  const formId = useId()
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(device.name)
  const [wrong, setWrong] = useState<string>()
  const renameRef = useRef<HTMLButtonElement>(null)
  const titleId = `device-${device.id}-title`
  const save = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    const trimmed = name.trim()
    if (trimmed === '') {
      setWrong('Enter a name.')
      return
    }
    setWrong(undefined)
    if (await onAction('rename', trimmed)) {
      setEditing(false)
      setTimeout(() => renameRef.current?.focus(), 0)
    }
  }
  return (
    <article
      className={`m-card m-catalog-device${selected ? ' m-card--selected' : ''}`}
      aria-labelledby={titleId}
    >
      <header className="m-card__header m-catalog-device__head">
        <span className="m-glyphbox">
          <Icon name="mobile" />
        </span>
        <div className="m-list__main">
          <h3 className="m-t-title3" id={titleId}>
            {device.name}
          </h3>
          <span className="m-t-subhead m-secondary">
            {device.model} · iOS {device.os_version}
          </span>
        </div>
        {selected && (
          <Chip kind="accent" icon="check">
            Selected
          </Chip>
        )}
      </header>
      <div className="m-card__body m-stack">
        <StatusPill status={deviceStatus(device.status)} />
        {device.message !== '' && <p>{device.message}</p>}
        <span className="m-t-mono-sm m-secondary m-wrap-any">
          Device identifier: {device.udid}
        </span>
        {editing && (
          <form
            id={formId}
            className="m-row m-catalog-rename"
            noValidate
            onSubmit={(event) => void save(event)}
          >
            <TextInput
              label="Device name"
              name="name"
              value={name}
              onChange={setName}
              error={wrong}
              maxLength={DEVICE_NAME_MAX}
              autoComplete="off"
              autoFocus
              required
            />
            <Button variant="primary" type="submit" busy={busy === 'rename'}>
              Save name
            </Button>
            <Button
              variant="plain"
              onClick={() => {
                setEditing(false)
                setName(device.name)
                setWrong(undefined)
              }}
            >
              Cancel
            </Button>
          </form>
        )}
      </div>
      <footer className="m-card__footer m-catalog-device__actions">
        {selected ? null : (
          <Button
            variant="secondary"
            size="sm"
            busy={busy === 'select'}
            onClick={() => void onAction('select')}
          >
            Use this device
          </Button>
        )}
        {!editing && (
          <Button
            ref={renameRef}
            variant="plain"
            size="sm"
            icon="edit"
            aria-label={`Rename ${device.name}`}
            onClick={() => setEditing(true)}
          >
            Rename
          </Button>
        )}
        {device.status === 'error' && (
          <Button
            variant="secondary"
            size="sm"
            icon="refresh"
            busy={busy === 'retry'}
            onClick={() => void onAction('retry')}
          >
            Retry preparation
          </Button>
        )}
        <Button
          variant="danger"
          size="sm"
          className="m-catalog-device__remove"
          aria-label={`Remove ${device.name}`}
          aria-haspopup="dialog"
          onClick={onRemove}
        >
          Remove
        </Button>
      </footer>
    </article>
  )
}

/** What changed between two reads, as a sentence per device: "iPad Air: Registered with Apple". */
export function changes(before: DevicesData, after: DevicesData): string[] {
  const was = new Map(before.devices.map((d) => [d.id, d.status]))
  return after.devices
    .filter((d) => was.has(d.id) && was.get(d.id) !== d.status)
    .map((d) => `${d.name}: ${DEVICE_STATE_LABELS[d.status]}`)
}

/** `/devices`. */
export function DevicesPage(): JSX.Element {
  const client = useApi()
  const toast = useToast()
  const read = useResource(DEVICES_PATH, asDevicesData)
  const [data, setData] = useState<DevicesData>()
  const [said, setSaid] = useState('')
  const [busy, setBusy] = useState<{ id: number; action: DeviceActionName }>()
  const [failed, setFailed] = useState<string>()
  const [removing, setRemoving] = useState<Device>()
  const [removeBusy, setRemoveBusy] = useState(false)
  const previous = useRef<DevicesData | undefined>(undefined)
  // Each read (and each action's answer) replaces the page's devices, and
  // says politely which of them changed state.
  const show = (next: DevicesData): void => {
    if (previous.current != null) {
      const changed = changes(previous.current, next)
      if (changed.length > 0) setSaid(changed.join('. '))
    }
    previous.current = next
    setData(next)
  }
  useEffect(() => {
    // `show` only reads refs and setters.
    if (read.data != null) show(read.data)
  }, [read.data])
  const pending = data != null && devicesPending(data.devices)
  const reload = read.reload
  useEffect(() => {
    if (!pending) return undefined
    const timer = setInterval(reload, DEVICES_REFRESH_MS)
    return (): void => clearInterval(timer)
  }, [pending, reload])

  const act = async (
    device: Device,
    action: DeviceActionName,
    name?: string,
  ): Promise<boolean> => {
    setBusy({ id: device.id, action })
    setFailed(undefined)
    try {
      const next = await client.post(
        deviceActionPath(device.id, action),
        asDevicesData,
        name == null ? {} : { body: { name } },
      )
      show(next)
      toast(
        action === 'select'
          ? { text: `${device.name} selected`, icon: 'check' }
          : action === 'rename'
            ? { text: `Renamed to ${name}`, icon: 'edit' }
            : action === 'retry'
              ? { text: `Preparing ${device.name} again`, icon: 'refresh' }
              : { text: `${device.name} removed`, icon: 'delete' },
      )
      return true
    } catch (error) {
      setFailed(`${device.name}: ${asApiError(error).message}`)
      return false
    } finally {
      setBusy(undefined)
    }
  }
  const remove = async (): Promise<void> => {
    if (removing == null) return
    setRemoveBusy(true)
    await act(removing, 'remove')
    setRemoveBusy(false)
    setRemoving(undefined)
  }

  return (
    <Page
      crumbs={[{ label: 'Devices' }]}
      title="Devices"
      description="Register your iPhone or iPad once to install test builds. Android and desktop builds need no registration."
    >
      <p className="m-sr" role="status" aria-live="polite">
        {said}
      </p>
      {data != null ? (
        <>
          {!data.registration ? (
            <CatalogState
              icon="hourglass_top"
              title="Device registration is being configured"
            >
              Please try again shortly.
            </CatalogState>
          ) : data.via != null ? (
            <RegisterOnHost host={data.via} />
          ) : (
            <RegisterDirect />
          )}
          {failed != null && <FormError>{failed}</FormError>}
          {data.devices.length > 0 && (
            <section aria-labelledby="your-devices" className="m-stack">
              <h2 className="m-t-title3" id="your-devices">
                Your devices
              </h2>
              {pending && (
                <p className="m-callout m-t-subhead">
                  <Icon name="sync" />
                  <span>
                    While a device registers with Apple, this page checks again
                    every 15 seconds.
                  </span>
                </p>
              )}
              <div className="m-grid-2">
                {data.devices.map((device) => (
                  <DeviceCard
                    key={device.id}
                    device={device}
                    selected={data.selected === device.id}
                    busy={busy?.id === device.id ? busy.action : undefined}
                    onAction={(action, name) => act(device, action, name)}
                    onRemove={() => setRemoving(device)}
                  />
                ))}
              </div>
            </section>
          )}
          {data.all.length > 0 && (
            <section className="m-card" aria-labelledby="all-devices">
              <header className="m-card__header">
                <div className="m-card__title">
                  <Icon name="group" />
                  <h2 className="m-t-title3" id="all-devices">
                    All registered devices
                  </h2>
                  <Count count={data.all.length} />
                </div>
                <span className="m-t-subhead m-tertiary">Administrators</span>
              </header>
              <ul className="m-list">
                {data.all.map((entry, n) => (
                  <li className="m-list__row" key={n}>
                    <span className="m-list__main">
                      <span className="m-t-headline">{entry.name}</span>
                      <span className="m-list__sub">{entry.model}</span>
                    </span>
                    <StatusPill
                      status={deviceStatus(entry.status)}
                      label={deviceStateLabel(entry.status)}
                      quiet
                    />
                  </li>
                ))}
              </ul>
            </section>
          )}
          <p>
            <ButtonLink variant="plain" icon="apps" to="/apps">
              Browse apps
            </ButtonLink>
          </p>
        </>
      ) : read.error != null ? (
        <CatalogRefusal error={read.error} retry={read.reload} />
      ) : (
        <Loading label="Loading your devices" />
      )}
      <Alert
        open={removing != null}
        title={`Remove ${removing?.name ?? ''}?`}
        message="It leaves your account: builds stop being prepared for it, and installing on it needs registering it again."
        confirm="Remove"
        tone="danger"
        busy={removeBusy}
        onConfirm={() => void remove()}
        onCancel={() => setRemoving(undefined)}
      />
    </Page>
  )
}
