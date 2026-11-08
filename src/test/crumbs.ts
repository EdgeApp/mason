/**
 * A page's breadcrumbs as tests compare them: each pill's label (as the
 * HTML has it, escaped) and its href, the current one marked `*`. None
 * when the page has no trail.
 */
export function crumbTrail(html: string): string[] {
  const nav =
    /<nav class="breadcrumbs" aria-label="Breadcrumb"><ol>([^]*?)<\/ol><\/nav>/.exec(
      html,
    )
  return [
    ...(nav?.[1] ?? '').matchAll(
      /<li>(?:<span class="crumb-sep" aria-hidden="true">›<\/span>)?<a class="crumb" href="([^"]*)"( aria-current="page")?[^>]*>([^<]*)<\/a><\/li>/g,
    ),
  ].map((match) => `${match[3]} ${match[1]}${match[2] == null ? '' : ' *'}`)
}
