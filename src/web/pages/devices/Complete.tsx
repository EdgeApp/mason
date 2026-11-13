// Where a device's registration lands (screen-17b-devices-complete): the
// Profile Service sends Safari back to /devices/complete/:token, whose
// server handler has already selected the device once it is registered.
// While Mason is still registering it with Apple the page reads itself
// again every five seconds; once registered it names the device and says
// how long its builds take.
import { useEffect, type JSX } from 'react'
import { useParams } from 'react-router'
import {
  asCompleteData,
  deviceCompletePath,
} from '../../../shared/api/index.js'
import { humanModel } from '../../../shared/catalog.js'
import { useResource } from '../../hooks/useResource.js'
import { Page } from '../../layout/Page.js'
import { ButtonLink } from '../../ui/Button.js'
import { EmptyState } from '../../ui/EmptyState.js'
import { Loading } from '../projects/project.js'
import { CatalogRefusal, CatalogState } from '../catalog/catalog.js'

/** How often a registration still with Apple is read again. */
export const REGISTERING_REFRESH_MS = 5_000

const DEVICES = { label: 'Devices', to: '/devices' }

/** `/devices/complete/:token`. */
export function CompletePage(): JSX.Element {
  const { token = '' } = useParams()
  const read = useResource(deviceCompletePath(token), asCompleteData)
  const state = read.data?.state
  const reload = read.reload
  useEffect(() => {
    if (state !== 'registering') return undefined
    const timer = setInterval(reload, REGISTERING_REFRESH_MS)
    return (): void => clearInterval(timer)
  }, [state, reload])
  const data = read.data
  const title =
    data?.state === 'registered'
      ? 'Device registered'
      : data?.state === 'unavailable'
        ? 'Registration link unavailable'
        : 'Registering device'
  return (
    <Page crumbs={[DEVICES, { label: title }]} title={title}>
      {data?.state === 'registering' ? (
        <section className="m-card" aria-live="polite">
          <div className="m-empty">
            <span
              className="m-spinner m-spinner--lg"
              role="img"
              aria-label="Registering"
            />
            <h2 className="m-t-title2">Registering your device</h2>
            <p>
              Mason has your device and is registering it with Apple. This page
              updates by itself.
            </p>
          </div>
        </section>
      ) : data?.state === 'registered' ? (
        <section className="m-card" aria-live="polite">
          <EmptyState
            icon="check_circle"
            tone="success"
            title={`Your ${humanModel(data.device.model)} is registered`}
            actions={
              <>
                <ButtonLink variant="primary" icon="apps" to="/apps">
                  Browse apps
                </ButtonLink>
                <ButtonLink variant="plain" to="/devices">
                  View your devices
                </ButtonLink>
              </>
            }
          >
            You’ve registered the following device:{' '}
            <strong>{humanModel(data.device.model)}</strong>. A new build of the
            applications is required before you can install them on your device;
            Mason will prepare these builds automatically. Builds take
            approximately <strong>30 to 60 minutes</strong> to become available.
            Please check back in that time.
          </EmptyState>
        </section>
      ) : data?.state === 'unavailable' ? (
        <CatalogState
          icon="link"
          tone="danger"
          title="The registration link is unavailable"
          actions={
            <ButtonLink variant="primary" icon="mobile" to="/devices">
              Register device
            </ButtonLink>
          }
        >
          It expired or was already used. Return to Register device and start
          again.
        </CatalogState>
      ) : read.error != null ? (
        <CatalogRefusal error={read.error} retry={read.reload} />
      ) : (
        <Loading label="Reading your registration" />
      )}
    </Page>
  )
}
