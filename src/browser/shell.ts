// The shell's search (⌘K or Ctrl-K, or the top bar's button): a dialog that
// asks `/search` as the viewer types and opens the chosen result.

/** One result `/search` returns. */
export interface SearchResult {
  kind: 'project' | 'app' | 'run' | 'commit' | 'branch'
  label: string
  detail: string
  href: string
}

/** What the search needs from the page, so it runs the same in a test. */
export interface SearchPage {
  open(): void
  close(): void
  isOpen(): boolean
  query(): string
  /** Shows results; `selected` is the highlighted index. */
  show(results: SearchResult[], selected: number): void
  fetchResults(query: string): Promise<SearchResult[]>
  go(href: string): void
  onKey(handler: (event: KeyEvent) => void): void
  onInput(handler: () => void): void
  onButton(handler: () => void): void
  setTimer(run: () => void, ms: number): unknown
  clearTimer(timer: unknown): void
}
export interface KeyEvent {
  key: string
  metaKey: boolean
  ctrlKey: boolean
  preventDefault(): void
}

/** Wires the search to a page: shortcuts, typing with a short pause, arrows and Enter. */
export function attachSearch(page: SearchPage): void {
  let results: SearchResult[] = []
  let selected = 0
  let timer: unknown
  let asked = 0
  const render = (): void => {
    page.show(results, selected)
  }
  const ask = async (): Promise<void> => {
    const query = page.query().trim()
    const ticket = ++asked
    if (query === '') {
      results = []
      selected = 0
      render()
      return
    }
    const found = await page.fetchResults(query).catch(() => [])
    // A slower answer to an earlier query never replaces a newer one.
    if (ticket !== asked) return
    results = found
    selected = 0
    render()
  }
  page.onButton(() => {
    page.open()
    render()
  })
  page.onInput(() => {
    if (timer != null) page.clearTimer(timer)
    timer = page.setTimer(() => {
      void ask()
    }, 150)
  })
  page.onKey((event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault()
      if (page.isOpen()) page.close()
      else {
        page.open()
        render()
      }
      return
    }
    if (!page.isOpen()) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (results.length === 0) return
      selected =
        (selected + (event.key === 'ArrowDown' ? 1 : -1) + results.length) %
        results.length
      render()
    } else if (event.key === 'Enter') {
      event.preventDefault()
      const chosen = results[selected]
      if (chosen != null) page.go(chosen.href)
    }
  })
}

const kindLabel: Record<SearchResult['kind'], string> = {
  project: 'Project',
  app: 'App ID',
  run: 'Run',
  commit: 'Commit',
  branch: 'Branch',
}

/** The results list's items, as elements the page can append. */
export function resultItems(
  doc: Document,
  results: SearchResult[],
  selected: number,
): HTMLElement[] {
  if (results.length === 0) {
    const empty = doc.createElement('li')
    empty.className = 'empty'
    empty.textContent =
      'Type to search projects, app IDs, runs, commits and branches.'
    return [empty]
  }
  return results.map((result, index) => {
    const item = doc.createElement('li')
    const link = doc.createElement('a')
    link.href = result.href
    link.setAttribute('role', 'option')
    link.setAttribute('aria-selected', String(index === selected))
    const text = doc.createElement('div')
    const label = doc.createElement('strong')
    label.textContent = result.label
    const detail = doc.createElement('small')
    detail.textContent = `${kindLabel[result.kind]} · ${result.detail}`
    text.append(label, detail)
    link.append(text)
    item.append(link)
    return item
  })
}

/** The page's own dialog, input and list. */
export function domPage(doc: Document, win: Window): SearchPage | undefined {
  const dialog = doc.querySelector<HTMLDialogElement>('dialog.search-dialog')
  const input = dialog?.querySelector<HTMLInputElement>('input')
  const list = dialog?.querySelector<HTMLUListElement>('ul')
  if (dialog == null || input == null || list == null) return undefined
  return {
    open: (): void => {
      dialog.showModal()
      input.focus()
    },
    close: (): void => {
      dialog.close()
    },
    isOpen: () => dialog.open,
    query: () => input.value,
    show: (results, selected): void => {
      list.replaceChildren(...resultItems(doc, results, selected))
    },
    fetchResults: async (query): Promise<SearchResult[]> => {
      const response = await win.fetch(
        `/search?q=${encodeURIComponent(query)}`,
        { headers: { accept: 'application/json' } },
      )
      if (!response.ok) return []
      return (await response.json()) as SearchResult[]
    },
    go: (href): void => {
      win.location.assign(href)
    },
    onKey: (handler): void => {
      doc.addEventListener('keydown', handler)
    },
    onInput: (handler): void => {
      input.addEventListener('input', handler)
    },
    onButton: (handler): void => {
      for (const button of doc.querySelectorAll('[data-search]'))
        button.addEventListener('click', handler)
    },
    setTimer: (run, ms) => win.setTimeout(run, ms),
    clearTimer: (timer): void => {
      win.clearTimeout(timer as number)
    },
  }
}

if (typeof document !== 'undefined' && typeof window !== 'undefined') {
  const page = domPage(document, window)
  if (page != null) attachSearch(page)
}
