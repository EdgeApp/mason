/**
 * The parts of a query that choose a new view rather than a choice on the
 * same page, per path: the project wizard's steps and Artifacts' run detail
 * live in their query. A page that draws another page from its query adds
 * its path and parameters here. The
 * shell starts a new view at its top with focus on its title, as for a new
 * page, whichever way it is reached (a link, Back, Forward); any other
 * change of the query (a filter, the platform switch) is the same page.
 */
const VIEW_PARAMS: Readonly<Record<string, readonly string[]>> = {
  '/projects/new': ['slug', 'step'],
  '/artifacts': ['run'],
}

/** What identifies the view at an address: its path, and any view-choosing query. */
export function viewKey(pathname: string, search: string): string {
  const names = VIEW_PARAMS[pathname]
  if (names == null) return pathname
  const query = new URLSearchParams(search)
  return [
    pathname,
    ...names.map((name) => `${name}=${query.get(name) ?? ''}`),
  ].join('&')
}
