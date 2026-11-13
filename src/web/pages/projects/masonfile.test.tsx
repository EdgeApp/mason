import assert from 'node:assert/strict'
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react'
import { afterEach, describe, it } from 'mocha'
import { until, where } from '../../test/render.js'
import {
  crumbs,
  heading,
  openProject,
  overviewFixture,
  tabs,
  text,
} from '../../test/projects.js'
import { COPIED_MS, tokenize } from './Masonfile.js'

afterEach(() => cleanup())

const OVERVIEW = '/api/v2/projects/fixture/overview'
const COMMITS = '/api/v2/projects/fixture/masonfile/commits'
const FILE = '/api/v2/projects/fixture/masonfile'
const NEWEST = 'ec24b917aa0011223344556677889900aabbccdd'
const OLDER = '9f31c2ab0011223344556677889900aabbccddee'

const commits = [
  { sha: NEWEST, branch: 'paul/offline' },
  { sha: OLDER, branch: 'develop' },
]
const masonfile = [
  "import { pipeline, stage } from 'mason'",
  '',
  '// Build both apps, then publish.',
  'export default pipeline({',
  "  stages: [stage('build', { timeout: 3600 })],",
  '})',
  '',
].join('\n')

/** The clipboard the page writes to: what it was given, or a refusal. */
const clipboard = (
  refuse = false,
): { written: string[]; restore: () => void } => {
  const written: string[] = []
  const had = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: {
      writeText: async (value: string) => {
        if (refuse) throw new Error('Not allowed')
        written.push(value)
      },
    },
  })
  return {
    written,
    restore: (): void => {
      if (had == null) delete (navigator as { clipboard?: unknown }).clipboard
      else Object.defineProperty(navigator, 'clipboard', had)
    },
  }
}

describe('A project’s Masonfile', () => {
  it('shows the newest commit’s Masonfile with line numbers and light colour', async () => {
    openProject('/projects/fixture/masonfile', {
      [OVERVIEW]: overviewFixture(),
      [COMMITS]: commits,
      [FILE]: { commit: NEWEST, file: 'Masonfile.ts', text: masonfile },
    })
    await heading('Fixture')
    assert.equal(tabs('Fixture').current, 'Masonfile')
    screen.getByText(
      'The Masonfile is the project’s configuration; it changes with the code.',
    )
    await screen.findByRole('heading', { level: 2, name: 'Masonfile.ts' })
    const code = screen.getByLabelText('Masonfile.ts at ec24b917aa00')
    const lines = [...code.children]
    assert.equal(lines.length, 6)
    assert.deepEqual(
      lines.map((line) => line.getAttribute('data-line')),
      ['1', '2', '3', '4', '5', '6'],
    )
    assert.equal(text(lines[0]!), "import { pipeline, stage } from 'mason'")
    assert.deepEqual(
      [...lines[0]!.querySelectorAll('span')].map((span) => [
        span.className,
        span.textContent,
      ]),
      [
        ['k', 'import'],
        ['k', 'from'],
        ['s', "'mason'"],
      ],
    )
    assert.equal(
      lines[2]!.querySelector('.c')?.textContent,
      '// Build both apps, then publish.',
    )
    assert.equal(lines[4]!.querySelector('.n')?.textContent, '3600')
    const select = screen.getByLabelText('Commit') as HTMLSelectElement
    assert.equal(select.value, NEWEST)
    assert.deepEqual(
      [...select.options].map((option) => option.text),
      ['ec24b917aa00 · paul/offline', '9f31c2ab0011 · develop'],
    )
    assert.deepEqual(crumbs(), [
      'Mason Master',
      'Projects & apps',
      'Fixture',
      'Masonfile',
    ])
  })

  it('shows another commit only once Show is pressed', async () => {
    const app = openProject('/projects/fixture/masonfile', {
      [OVERVIEW]: overviewFixture(),
      [COMMITS]: commits,
      [FILE]: { commit: NEWEST, file: 'Masonfile.ts', text: masonfile },
      [`${FILE}?commit=${OLDER}`]: {
        commit: OLDER,
        file: 'Masonfile.ts',
        text: 'export default {}\n',
      },
    })
    const select = (await screen.findByLabelText('Commit')) as HTMLSelectElement
    await screen.findByRole('heading', { level: 2, name: 'Masonfile.ts' })
    fireEvent.change(select, { target: { value: OLDER } })
    assert.equal(where.path, '/projects/fixture/masonfile')
    fireEvent.click(screen.getByRole('button', { name: 'Show' }))
    assert.equal(where.path, `/projects/fixture/masonfile?commit=${OLDER}`)
    await screen.findByLabelText('Masonfile.ts at 9f31c2ab0011')
    assert.ok(app.node.requests.includes(`GET ${FILE}?commit=${OLDER}`))
    assert.equal(select.value, OLDER)
  })

  it('keeps a commit the address names that the list no longer holds', async () => {
    openProject(`/projects/fixture/masonfile?commit=abc123`, {
      [OVERVIEW]: overviewFixture(),
      [COMMITS]: commits,
      [`${FILE}?commit=abc123`]: {
        status: 404,
        body: { error: 'Masonfile.ts is not in that commit.' },
      },
    })
    await screen.findByRole('heading', {
      name: 'Masonfile.ts is not in that commit.',
    })
    const select = screen.getByLabelText('Commit') as HTMLSelectElement
    assert.equal(select.value, 'abc123')
    assert.equal(select.options[0]!.text, 'abc123 · chosen')
  })

  it('copies the file, says Copied for a moment, and selects it to copy by hand where the clipboard is refused', async () => {
    const allowed = clipboard()
    try {
      openProject('/projects/fixture/masonfile', {
        [OVERVIEW]: overviewFixture(),
        [COMMITS]: commits,
        [FILE]: { commit: NEWEST, file: 'Masonfile.ts', text: masonfile },
      })
      const copy = await screen.findByRole('button', { name: 'Copy' })
      await act(async () => copy.click())
      assert.deepEqual(allowed.written, [masonfile])
      screen.getByRole('button', { name: 'Copied' })
      await act(
        async () =>
          await new Promise((resolve) => setTimeout(resolve, COPIED_MS + 50)),
      )
      screen.getByRole('button', { name: 'Copy' })
    } finally {
      allowed.restore()
    }
    cleanup()
    const refused = clipboard(true)
    try {
      openProject('/projects/fixture/masonfile', {
        [OVERVIEW]: overviewFixture(),
        [COMMITS]: commits,
        [FILE]: { commit: NEWEST, file: 'Masonfile.ts', text: masonfile },
      })
      const copy = await screen.findByRole('button', { name: 'Copy' })
      await act(async () => copy.click())
      await screen.findByRole('button', { name: 'Select and copy' })
      assert.match(String(window.getSelection()), /export default pipeline/)
    } finally {
      refused.restore()
    }
  })

  it('says why there is no file: a script project, no run yet, and on the host a copy not yet there', async () => {
    openProject('/projects/fixture/masonfile', {
      [OVERVIEW]: overviewFixture({ format: 'script' }),
      [COMMITS]: [],
      [FILE]: {
        status: 404,
        body: {
          error: 'This project builds from a script; it has no Masonfile.',
        },
      },
    })
    await screen.findByRole('heading', {
      name: 'This project builds from a script; it has no Masonfile.',
    })
    assert.equal(
      (screen.getByLabelText('Commit') as HTMLSelectElement).disabled,
      true,
    )
    assert.equal(
      (screen.getByRole('button', { name: 'Show' }) as HTMLButtonElement)
        .disabled,
      true,
    )
    cleanup()
    openProject(
      '/projects/fixture/masonfile',
      {
        [OVERVIEW]: overviewFixture({ secrets: false, canSeed: false }),
        [COMMITS]: commits,
        [FILE]: {
          status: 404,
          body: {
            error:
              'The host is still copying that commit’s Masonfile from the master.',
          },
        },
      },
      'developer',
      'host',
    )
    await screen.findByRole('heading', {
      name: 'The host is still copying that commit’s Masonfile from the master.',
    })
    assert.deepEqual(tabs('Fixture').labels, [
      'Overview',
      'Runs and builds',
      'Masonfile',
    ])
  })

  it('offers Retry when the commits or the file cannot be read', async () => {
    const app = openProject('/projects/fixture/masonfile', {
      [OVERVIEW]: overviewFixture(),
      [COMMITS]: { status: 500, body: { error: 'Mirror busy' } },
      [FILE]: { status: 502, body: { error: 'The mirror did not answer' } },
    })
    await screen.findByRole('heading', {
      name: 'The commits could not be read',
    })
    await screen.findByRole('heading', {
      name: 'The Masonfile could not be read',
    })
    app.node.set(COMMITS, commits)
    app.node.set(FILE, {
      commit: NEWEST,
      file: 'Masonfile.ts',
      text: masonfile,
    })
    for (const retry of screen.getAllByRole('button', { name: 'Retry' }))
      fireEvent.click(retry)
    await screen.findByLabelText('Commit')
    await screen.findByRole('heading', { level: 2, name: 'Masonfile.ts' })
    await until(
      () =>
        within(document.body).queryByRole('button', { name: 'Retry' }) == null,
      'the retries to clear',
    )
  })

  it('colours comments, strings, numbers and keywords, a block comment across lines', () => {
    const kinds = (line: string, open = false): Array<[string, string]> =>
      tokenize(line, open).tokens.map((token) => [token.kind ?? '', token.text])
    assert.deepEqual(kinds('const n = 42 // the answer'), [
      ['k', 'const'],
      ['', ' n = '],
      ['n', '42'],
      ['', ' '],
      ['c', '// the answer'],
    ])
    assert.deepEqual(kinds('x("a \\" b", `t`)'), [
      ['', 'x('],
      ['s', '"a \\" b"'],
      ['', ', '],
      ['s', '`t`'],
      ['', ')'],
    ])
    const opened = tokenize('a /* starts')
    assert.equal(opened.inComment, true)
    assert.deepEqual(kinds('still inside', true), [['c', 'still inside']])
    const closed = tokenize('ends */ return', true)
    assert.equal(closed.inComment, false)
    assert.deepEqual(
      closed.tokens.map((token) => [token.kind ?? '', token.text]),
      [
        ['c', 'ends */'],
        ['', ' '],
        ['k', 'return'],
      ],
    )
    assert.equal(tokenize('/* one */ x').inComment, false)
  })
})
