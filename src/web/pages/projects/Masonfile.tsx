// A project's Masonfile at a commit (screen-07-masonfile): a commit to
// choose and Show, then the file in the code viewer with line numbers and
// light syntax colour, and Copy. The master reads the copy a run kept, then
// its mirror; the host only its own copies, so it may still be copying the
// commit's file, or have none. Each reason there is no file is its state.
import { useEffect, useState, type JSX, type ReactNode } from 'react'
import { useParams, useSearchParams } from 'react-router'
import {
  asMasonfileCommits,
  asMasonfileText,
  masonfileCommitsPath,
  masonfilePath,
  type MasonfileText,
} from '../../../shared/api/index.js'
import { useResource } from '../../hooks/useResource.js'
import { Button } from '../../ui/Button.js'
import { EmptyState } from '../../ui/EmptyState.js'
import { Failed, Loading, ProjectPage } from './project.js'

/** How long Copy says Copied. */
export const COPIED_MS = 2_000

const KEYWORDS = new Set([
  'as',
  'async',
  'await',
  'break',
  'case',
  'catch',
  'class',
  'const',
  'continue',
  'default',
  'else',
  'export',
  'extends',
  'false',
  'finally',
  'for',
  'from',
  'function',
  'if',
  'import',
  'in',
  'interface',
  'let',
  'new',
  'null',
  'of',
  'return',
  'switch',
  'this',
  'throw',
  'true',
  'try',
  'type',
  'typeof',
  'undefined',
  'var',
  'while',
])

/** One token of a line: its text and its colour class (`k`, `s`, `c`, `n`), if any. */
export interface Token {
  text: string
  kind?: 'k' | 's' | 'c' | 'n'
}

const TOKEN =
  /(\/\/.*$)|(\/\*.*?(?:\*\/|$))|('(?:[^'\\]|\\.)*'?|"(?:[^"\\]|\\.)*"?|`(?:[^`\\]|\\.)*`?)|(\b\d[\d_.]*\b)|([A-Za-z_$][\w$]*)/g

/**
 * A line's tokens for the code viewer's light colour: comments, strings,
 * numbers and keywords. A block comment open at a line's end carries to
 * the next (`inComment`); everything else is read line by line.
 */
export function tokenize(
  line: string,
  inComment = false,
): { tokens: Token[]; inComment: boolean } {
  const tokens: Token[] = []
  // Plain text runs together, so a line holds few spans.
  const push = (token: Token): void => {
    const last = tokens[tokens.length - 1]
    if (token.kind == null && last != null && last.kind == null)
      last.text += token.text
    else tokens.push(token)
  }
  let rest = line
  if (inComment) {
    const end = rest.indexOf('*/')
    if (end < 0) return { tokens: [{ text: rest, kind: 'c' }], inComment: true }
    tokens.push({ text: rest.slice(0, end + 2), kind: 'c' })
    rest = rest.slice(end + 2)
  }
  let at = 0
  let open = false
  for (const match of rest.matchAll(TOKEN)) {
    const index = match.index
    if (index > at) push({ text: rest.slice(at, index) })
    const [text, comment, block, string, number, word] = match
    if (comment != null) push({ text, kind: 'c' })
    else if (block != null) {
      push({ text, kind: 'c' })
      open = !text.endsWith('*/') || text.length < 4
    } else if (string != null) push({ text, kind: 's' })
    else if (number != null) push({ text, kind: 'n' })
    else if (word != null && KEYWORDS.has(word)) push({ text, kind: 'k' })
    else push({ text })
    at = index + text.length
  }
  if (at < rest.length) push({ text: rest.slice(at) })
  return { tokens, inComment: open }
}

/** Configuration text with line numbers and light colour; it scrolls sideways. */
export function CodeViewer({
  text,
  label,
}: {
  text: string
  label: string
}): JSX.Element {
  let inComment = false
  const lines = text.replace(/\n$/, '').split('\n')
  return (
    <pre className="m-code m-masonfile__code" aria-label={label} tabIndex={0}>
      {lines.map((line, index) => {
        const read = tokenize(line, inComment)
        inComment = read.inComment
        return (
          <span key={index} data-line={index + 1}>
            {read.tokens.map((token, n) =>
              token.kind == null ? (
                token.text
              ) : (
                <span key={n} className={token.kind}>
                  {token.text}
                </span>
              ),
            )}
          </span>
        )
      })}
    </pre>
  )
}

/** Copy: the file's text to the clipboard, saying Copied; where that is refused, the text selected to copy by hand. */
function CopyButton({
  text,
  target,
}: {
  text: string
  target: () => HTMLElement | null
}): JSX.Element {
  const [said, setSaid] = useState<'Copy' | 'Copied' | 'Select and copy'>(
    'Copy',
  )
  useEffect(() => {
    if (said !== 'Copied') return undefined
    const timer = setTimeout(() => setSaid('Copy'), COPIED_MS)
    return (): void => clearTimeout(timer)
  }, [said])
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text)
      setSaid('Copied')
    } catch {
      const element = target()
      if (element != null) {
        const range = document.createRange()
        range.selectNodeContents(element)
        const selection = window.getSelection()
        selection?.removeAllRanges()
        selection?.addRange(range)
      }
      setSaid('Select and copy')
    }
  }
  return (
    <Button
      variant="plain"
      size="sm"
      icon={said === 'Copied' ? 'check' : 'content_copy'}
      onClick={() => void copy()}
      aria-live="polite"
    >
      {said}
    </Button>
  )
}

/** The commit select and Show: choosing a commit shows nothing until Show. */
function CommitPicker({
  commits,
  commit,
  show,
}: {
  commits: Array<{ sha: string; branch: string }>
  commit: string | undefined
  show: (sha: string) => void
}): JSX.Element {
  const [chosen, setChosen] = useState(commit ?? commits[0]?.sha ?? '')
  useEffect(() => {
    if (commit != null) setChosen(commit)
  }, [commit])
  const options =
    commit == null || commits.some((entry) => entry.sha === commit)
      ? commits
      : [{ sha: commit, branch: 'chosen' }, ...commits]
  return (
    <form
      className="m-row m-masonfile__picker"
      onSubmit={(event) => {
        event.preventDefault()
        if (chosen !== '') show(chosen)
      }}
    >
      <div className="m-field m-masonfile__commit">
        <label className="m-field__label" htmlFor="masonfile-commit">
          Commit
        </label>
        <select
          id="masonfile-commit"
          name="commit"
          className="m-select m-input--mono"
          value={chosen}
          disabled={options.length === 0}
          onChange={(event) => setChosen(event.target.value)}
        >
          {options.map((entry) => (
            <option key={entry.sha} value={entry.sha}>
              {entry.sha.slice(0, 12)} · {entry.branch}
            </option>
          ))}
        </select>
      </div>
      <Button
        variant="secondary"
        type="submit"
        disabled={options.length === 0}
        className="m-masonfile__show"
      >
        Show
      </Button>
    </form>
  )
}

/** The file at the commit, or why there is none. */
function FileView({
  read,
}: {
  read: {
    data: MasonfileText | undefined
    error: { status: number; message: string } | undefined
    reload: () => void
  }
}): JSX.Element {
  if (read.data != null) {
    const file = read.data
    return (
      <section
        className="m-stack m-stack--tight"
        aria-labelledby="masonfile-name"
      >
        <div className="m-row m-row--between">
          <h2 className="m-t-title3 m-t-mono m-wrap-any" id="masonfile-name">
            {file.file}
          </h2>
          <CopyButton
            text={file.text}
            target={() =>
              document.querySelector<HTMLElement>('.m-masonfile__code')
            }
          />
        </div>
        <CodeViewer
          text={file.text}
          label={`${file.file} at ${file.commit.slice(0, 12)}`}
        />
      </section>
    )
  }
  if (read.error?.status === 404)
    return (
      <section className="m-card">
        <EmptyState icon="description" title={read.error.message} />
      </section>
    )
  if (read.error != null)
    return (
      <Failed
        what="The Masonfile"
        message={read.error.message}
        retry={read.reload}
      />
    )
  return <Loading label="Loading the Masonfile" />
}

/** The Masonfile tab's body: the picker and the file. */
function MasonfileBody({ slug }: { slug: string }): JSX.Element {
  const [params, setParams] = useSearchParams()
  const commit = params.get('commit') ?? undefined
  const commits = useResource(masonfileCommitsPath(slug), asMasonfileCommits)
  const file = useResource(
    `${masonfilePath(slug)}${commit == null ? '' : `?commit=${encodeURIComponent(commit)}`}`,
    asMasonfileText,
  )
  let picker: ReactNode
  if (commits.data != null)
    picker = (
      <CommitPicker
        commits={commits.data}
        commit={commit ?? file.data?.commit}
        show={(sha) => setParams({ commit: sha })}
      />
    )
  else if (commits.error != null)
    picker = (
      <Failed
        what="The commits"
        message={commits.error.message}
        retry={commits.reload}
      />
    )
  return (
    <>
      {picker}
      <FileView read={file} />
    </>
  )
}

/** `/projects/:slug/masonfile`, both nodes. */
export function MasonfilePage(): JSX.Element {
  const { slug = '' } = useParams()
  return (
    <ProjectPage
      slug={slug}
      tab="masonfile"
      title="Masonfile"
      crumbs={[{ label: 'Masonfile' }]}
      description="The Masonfile is the project’s configuration; it changes with the code."
    >
      {() => <MasonfileBody slug={slug} />}
    </ProjectPage>
  )
}
