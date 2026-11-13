// What the Groups pages read besides `src/shared/api/admin.ts`: the list of
// groups (each as `GET /api/v2/groups/:id` answers one) and, for a group's
// members, each person's name and first email from `GET /api/v2/people`.
import { asArray, asNumber, asObject, asString } from 'cleaners'
import { asGroupDetail } from '../../../../shared/api/admin.js'

/** `GET|POST /api/v2/groups`, master only. */
export const GROUPS_PATH = '/api/v2/groups'
/** `GET /api/v2/people`, master only: everyone not removed. */
export const PEOPLE_PATH = '/api/v2/people'

export const asGroupDetails = asArray(asGroupDetail)

/** A person as a group page shows them: name and email addresses, in order. */
export interface GroupPerson {
  id: number
  name: string
  emails: Array<{ email: string }>
}

export const asGroupPeople = asArray(
  asObject<GroupPerson>({
    id: asNumber,
    name: asString,
    emails: asArray(asObject({ email: asString })),
  }),
)

/** Where a group's page is. */
export const groupHref = (id: number): string => `/groups/${id}`

/** "1 app · 12 members". */
export const groupSummary = (apps: number, members: number): string =>
  `${apps} ${apps === 1 ? 'app' : 'apps'} · ${members} ${members === 1 ? 'member' : 'members'}`
