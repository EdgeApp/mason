// Groups, on the master (screen-14-groups, the list): one row per group,
// each opening its page, with how many apps and members it has. Managers
// add a group in a form sheet, which opens the new group's page.
import { useId, useRef, useState, type FormEvent, type JSX } from 'react'
import { Link, useNavigate } from 'react-router'
import { asGroupDetail } from '../../../../shared/api/admin.js'
import { useApi } from '../../../api/context.js'
import { useResource } from '../../../hooks/useResource.js'
import { Page } from '../../../layout/Page.js'
import { useShell } from '../../../layout/ShellContext.js'
import { Count } from '../../../ui/Badge.js'
import { Button } from '../../../ui/Button.js'
import { EmptyState } from '../../../ui/EmptyState.js'
import { FormError, TextInput } from '../../../ui/Field.js'
import { Icon } from '../../../ui/Icon.js'
import { Sheet } from '../../../ui/Sheet.js'
import { useToast } from '../../../ui/Toast.js'
import { Failed, Loading } from '../../projects/project.js'
import {
  asGroupDetails,
  groupHref,
  groupSummary,
  GROUPS_PATH,
} from './groupsApi.js'

/** A group's longest name. */
export const GROUP_NAME_MAX = 120

/** Add group: its name; the new group's page opens. */
function AddGroupSheet({
  open,
  onClose,
}: {
  open: boolean
  onClose: () => void
}): JSX.Element {
  const client = useApi()
  const toast = useToast()
  const navigate = useNavigate()
  const formId = useId()
  const [name, setName] = useState('')
  const [wrong, setWrong] = useState<string | undefined>()
  const [failed, setFailed] = useState<string | undefined>()
  const [busy, setBusy] = useState(false)
  const error = useRef<HTMLParagraphElement>(null)
  const close = (): void => {
    setName('')
    setWrong(undefined)
    setFailed(undefined)
    onClose()
  }
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    const trimmed = name.trim()
    if (trimmed === '') {
      setWrong('Enter a name.')
      return
    }
    setWrong(undefined)
    setFailed(undefined)
    setBusy(true)
    try {
      const group = await client.post(GROUPS_PATH, asGroupDetail, {
        body: { name: trimmed },
      })
      toast({ text: `${group.name} added`, icon: 'group' })
      close()
      void navigate(groupHref(group.id))
    } catch (reason) {
      setFailed((reason as Error).message)
      setTimeout(() => error.current?.focus(), 0)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Sheet
      open={open}
      onClose={close}
      dirty={name !== ''}
      title="Add a group"
      footer={(requestClose) => (
        <>
          <Button variant="secondary" onClick={requestClose}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form={formId} busy={busy}>
            Add group
          </Button>
        </>
      )}
    >
      <form
        id={formId}
        name="group"
        className="m-stack"
        noValidate
        onSubmit={(event) => void submit(event)}
      >
        <TextInput
          label="Name"
          name="name"
          value={name}
          onChange={setName}
          error={wrong}
          maxLength={GROUP_NAME_MAX}
          help="Up to 120 characters. Its members see its apps in their catalog."
          autoComplete="off"
          required
        />
        {failed != null && <FormError ref={error}>{failed}</FormError>}
      </form>
    </Sheet>
  )
}

/** `/groups`, the master only. */
export function GroupsPage(): JSX.Element {
  const { session } = useShell()
  const change = session.permissions.includes('groups.change')
  const read = useResource(GROUPS_PATH, asGroupDetails)
  const [adding, setAdding] = useState(false)
  return (
    <Page
      crumbs={[{ label: 'Groups' }]}
      title="Groups"
      description="The apps each group’s members see in their catalog."
      actions={
        change ? (
          <Button
            variant="primary"
            icon="add"
            aria-haspopup="dialog"
            onClick={() => setAdding(true)}
          >
            Add group
          </Button>
        ) : undefined
      }
    >
      {read.data != null ? (
        <section className="m-card" aria-labelledby="groups-title">
          <header className="m-card__header">
            <div className="m-card__title">
              <Icon name="group" />
              <h2 className="m-t-title3" id="groups-title">
                All groups
              </h2>
              <Count count={read.data.length} />
            </div>
          </header>
          {read.data.length === 0 ? (
            <EmptyState icon="group" title="No groups." />
          ) : (
            <ul className="m-list">
              {read.data.map((group) => (
                <li key={group.id}>
                  <Link className="m-list__row" to={groupHref(group.id)}>
                    <span className="m-list__main">
                      <span className="m-t-headline">{group.name}</span>
                      <span className="m-list__sub">
                        {groupSummary(group.apps.length, group.members.length)}
                      </span>
                    </span>
                    <Icon name="chevron_right" className="m-chev" />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : read.error != null ? (
        <Failed
          what="The groups"
          message={read.error.message}
          retry={read.reload}
        />
      ) : (
        <Loading label="Loading the groups" />
      )}
      {change && (
        <AddGroupSheet open={adding} onClose={() => setAdding(false)} />
      )}
    </Page>
  )
}
