// Invite and Invite again (screen-12-people): a link, valid for a week, where
// the person chooses a password. Make the link answers it once; it is shown
// in a copy field, since Mason sends no email. Revoke invitation ends it.
import { asUnknown } from 'cleaners'
import { useEffect, useRef, useState, type JSX } from 'react'
import {
  asInvitation,
  invitationPath,
  type Invitation,
  type Person,
} from '../../../../shared/api/people.js'
import { useApi } from '../../../api/context.js'
import { Button } from '../../../ui/Button.js'
import { CopyField } from '../../../ui/CopyField.js'
import { FormError } from '../../../ui/Field.js'
import { Icon } from '../../../ui/Icon.js'
import { Sheet } from '../../../ui/Sheet.js'
import { useToast } from '../../../ui/Toast.js'

/** What the link box says above the link. */
export const COPY_NOW =
  'Copy this link to them now: Mason sends no email, keeps only a hash of it and cannot show it again. It works once.'

/** How long a new link lasts. */
const DAYS = 7

/** The words before the link is made. */
export function inviteText(person: Person): string {
  const chooses =
    person.username == null
      ? 'a password (and a username if they have no confirmed email)'
      : 'a password'
  return `A link, valid for a week, where ${person.name} chooses ${chooses}.${person.invitation == null ? '' : ' The earlier link stops working.'} Mason sends no email: copy the link to them.`
}

/** The link box: what to do with it, then the link to copy. */
export function LinkBox({ url }: { url: string }): JSX.Element {
  return (
    <div className="m-stack">
      <div className="m-callout">
        <Icon name="info" />
        <span>{COPY_NOW}</span>
      </div>
      <CopyField value={url} name="the invitation link" block />
    </div>
  )
}

/** The sheet, for one person, mounted while it is open. */
export function InviteSheet({
  person,
  onClose,
  changed,
}: {
  person: Person
  onClose: () => void
  /** The person's invitation changed: read the list again. */
  changed: () => void
}): JSX.Element {
  const client = useApi()
  const toast = useToast()
  const [link, setLink] = useState<Invitation | undefined>()
  const [busy, setBusy] = useState<'make' | 'revoke' | undefined>()
  const [failure, setFailure] = useState<string | undefined>()
  const failed = useRef<HTMLParagraphElement>(null)
  useEffect(() => {
    if (failure != null) failed.current?.focus()
  }, [failure])
  const pending = link != null || person.invitation != null
  const make = async (): Promise<void> => {
    setBusy('make')
    setFailure(undefined)
    try {
      setLink(
        await client.post(invitationPath(person.id), asInvitation, {
          body: { days: DAYS },
        }),
      )
      toast({ text: `Invitation link for ${person.name} made`, icon: 'link' })
      changed()
    } catch (reason) {
      setFailure((reason as Error).message)
    } finally {
      setBusy(undefined)
    }
  }
  const revoke = async (): Promise<void> => {
    setBusy('revoke')
    setFailure(undefined)
    try {
      await client.delete(invitationPath(person.id), asUnknown)
      toast({ text: `${person.name}’s invitation revoked`, icon: 'block' })
      changed()
      onClose()
    } catch (reason) {
      setFailure((reason as Error).message)
      setBusy(undefined)
    }
  }
  return (
    <Sheet
      open
      onClose={onClose}
      title={`Invite ${person.name}`}
      footer={
        <>
          {pending && (
            <Button
              variant="danger"
              className="m-people__revoke"
              busy={busy === 'revoke'}
              onClick={() => void revoke()}
            >
              Revoke invitation
            </Button>
          )}
          {link == null ? (
            <>
              <Button variant="secondary" onClick={onClose}>
                Cancel
              </Button>
              <Button
                variant="primary"
                icon="link"
                busy={busy === 'make'}
                onClick={() => void make()}
              >
                Make the link
              </Button>
            </>
          ) : (
            <Button variant="primary" onClick={onClose}>
              Done
            </Button>
          )}
        </>
      }
    >
      <div className="m-stack">
        {link == null ? (
          <p className="m-t-callout m-secondary">{inviteText(person)}</p>
        ) : (
          <LinkBox url={link.url} />
        )}
        {failure != null && <FormError ref={failed}>{failure}</FormError>}
      </div>
    </Sheet>
  )
}
