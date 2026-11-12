import assert from 'node:assert/strict'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, it } from 'mocha'
import type { JSX } from 'react'
import { MemoryRouter } from 'react-router'
import { Avatar, initial } from './Avatar.js'
import { Badge, Count } from './Badge.js'
import { Banner, Banners, bySeverity, type BannerItem } from './Banner.js'
import { Button, ButtonLink, buttonClass } from './Button.js'
import { Card } from './Card.js'
import { Chip } from './Chip.js'
import { cx } from './cx.js'
import { EmptyState } from './EmptyState.js'
import { Icon } from './Icon.js'
import { glyph, icons } from './icons.js'
import { isApple, Kbd, paletteShortcut } from './Kbd.js'
import { PAGE_TITLE_ID, PageHeader } from './PageHeader.js'
import { Skeleton, SkeletonText } from './Skeleton.js'
import { Spinner } from './Spinner.js'
import { STATUS, statusOf, statusWord, type Tone } from './status.js'
import { StatusPill } from './StatusPill.js'
import {
  TOAST_ACTION_MS,
  TOAST_MS,
  ToastProvider,
  toneOf,
  useToast,
} from './Toast.js'
import { Toggletip, Tooltip } from './Tooltip.js'

afterEach(cleanup)

describe('The status table', () => {
  it('gives every state a tone, a glyph from the subset and a word', () => {
    const tones: Tone[] = [
      'success',
      'running',
      'warning',
      'danger',
      'neutral',
      'info',
    ]
    for (const [key, treatment] of Object.entries(STATUS)) {
      assert(tones.includes(treatment.tone), key)
      assert(treatment.icon in icons, key)
      assert(treatment.word.length > 0, key)
    }
    assert.deepEqual(statusOf('awaiting_approval'), {
      tone: 'warning',
      icon: 'pan_tool',
      word: 'Waiting for approval',
    })
    assert.deepEqual(statusOf('timed_out'), {
      tone: 'danger',
      icon: 'hourglass_top',
      word: 'Timed out',
    })
  })

  it('reads a state it does not know as neutral, with its own name as the word', () => {
    assert.deepEqual(statusOf('rolled_back'), {
      tone: 'neutral',
      icon: 'circle',
      word: 'Rolled back',
    })
    assert.deepEqual(statusOf('toString'), {
      tone: 'neutral',
      icon: 'circle',
      word: 'ToString',
    })
    assert.equal(statusWord('  '), '')
  })
})

describe('The design language’s small components', () => {
  it('draws an icon from the subset, decorative unless named', () => {
    assert.equal(glyph('search'), '')
    render(
      <>
        <Icon name="search" />
        <Icon name="warning" size="lg" label="Warning" className="x" />
      </>,
    )
    const hidden = document.querySelector('.m-icon[aria-hidden="true"]')!
    assert.equal(hidden.textContent, '')
    const named = screen.getByRole('img', { name: 'Warning' })
    assert.equal(named.className, 'm-icon m-icon--lg x')
    assert.equal(cx('a', false, null, undefined, '', 'b'), 'a b')
  })

  it('draws a status as its glyph and word, quiet, live, linked or relabelled', () => {
    render(
      <MemoryRouter>
        <StatusPill status="failed" />
        <StatusPill
          status="idle"
          label="2 / 3 workers idle"
          quiet
          to="/nodes"
          name="Workers"
        />
        <StatusPill status="idle" label="Live" live />
      </MemoryRouter>,
    )
    const failed = screen.getByText('Failed')
    assert.equal(failed.className, 'm-status m-status--danger')
    assert.equal(failed.querySelector('.m-icon')!.textContent, glyph('error'))
    const link = screen.getByRole('link', { name: 'Workers' })
    assert.equal(link.getAttribute('href'), '/nodes')
    assert.match(link.className, /m-status--success m-status--quiet/)
    const live = screen.getByText('Live')
    assert(live.querySelector('.m-dot--live') != null)
    assert.equal(live.querySelector('.m-icon'), null)
  })

  it('draws chips, badges, counts, keys, avatars, spinners and skeletons', () => {
    render(
      <>
        <Chip>Admin</Chip>
        <Chip kind="platform" series={4} icon="android" title="Android">
          Android
        </Chip>
        <Badge count={1284} />
        <Badge count={2} tone="danger" label="2 need you" />
        <Count count={1284} />
        <Kbd>⌘K</Kbd>
        <Avatar name=" paul" size="sm" />
        <Spinner />
        <Spinner size="sm" label="Searching" />
        <Skeleton pill width="4rem" />
        <SkeletonText lines={2} />
        <SkeletonText lines={1} label="One" />
      </>,
    )
    assert.equal(screen.getByText('Admin').className, 'm-chip')
    const platform = screen.getByTitle('Android')
    assert.equal(platform.className, 'm-chip m-chip--platform')
    assert.equal(platform.style.getPropertyValue('--c'), 'var(--m-cat-4)')
    const badge = document.querySelector('.m-badge')!
    assert.equal(badge.textContent, '1,284')
    assert.equal(badge.getAttribute('aria-hidden'), 'true')
    assert.equal(
      screen.getByRole('img', { name: '2 need you' }).className,
      'm-badge m-badge--danger',
    )
    assert.equal(document.querySelector('.m-count')!.textContent, '1,284')
    assert.equal(document.querySelector('kbd.m-kbd')!.textContent, '⌘K')
    assert.equal(document.querySelector('.m-avatar--sm')!.textContent, 'P')
    assert.equal(initial(''), '?')
    assert.equal(screen.getAllByRole('status', { name: 'Loading' }).length, 2)
    assert.equal(
      screen.getByRole('status', { name: 'Searching' }).className,
      'm-spinner m-spinner--sm',
    )
    const pill = document.querySelector<HTMLElement>('.m-skel')!
    assert.equal(pill.style.borderRadius, 'var(--m-radius-pill)')
    assert.equal(pill.style.width, '4rem')
    assert.equal(
      screen.getByRole('status', { name: 'One' }).querySelectorAll('.m-skel')
        .length,
      1,
    )
  })

  it('says ⌘K on Apple platforms and Ctrl K elsewhere', () => {
    assert.equal(
      isApple({ platform: 'MacIntel', userAgent: '' } as Navigator),
      true,
    )
    assert.equal(
      isApple({ platform: '', userAgent: 'Mozilla (iPhone)' } as Navigator),
      true,
    )
    assert.equal(
      paletteShortcut({ platform: 'Win32', userAgent: 'Windows' } as Navigator),
      'Ctrl K',
    )
    assert.equal(
      paletteShortcut({ platform: 'MacIntel', userAgent: '' } as Navigator),
      '⌘K',
    )
  })

  it('draws an empty state with a toned glyph, a heading, words and actions', () => {
    render(
      <>
        <EmptyState
          icon="error"
          tone="danger"
          title="Run unavailable"
          titleAs="h1"
          titleId="t"
          actions={<button>Retry</button>}
        >
          There is no such run.
        </EmptyState>
        <EmptyState>Nothing yet.</EmptyState>
      </>,
    )
    const heading = screen.getByRole('heading', {
      level: 1,
      name: 'Run unavailable',
    })
    assert.equal(heading.id, 't')
    assert.equal(heading.tabIndex, -1)
    const glyphBox = document.querySelector<HTMLElement>('.m-empty__glyph')!
    assert.equal(glyphBox.style.color, 'var(--m-danger-solid)')
    screen.getByText('There is no such run.')
    screen.getByRole('button', { name: 'Retry' })
    assert.equal(document.querySelectorAll('.m-empty__glyph').length, 1)
  })

  it('draws a card with a header, a flush body and a footer', () => {
    render(
      <>
        <Card
          title="Queue"
          actions={<span>2</span>}
          footer={<span>More</span>}
          flat
        >
          <p>body</p>
        </Card>
        <Card flush label="Plain" titleAs="h3">
          <ul />
        </Card>
      </>,
    )
    const card = screen
      .getByRole('heading', { name: 'Queue' })
      .closest('section')!
    assert.equal(card.className, 'm-card m-card--flat')
    assert(card.querySelector('.m-card__body p') != null)
    assert(card.querySelector('.m-card__footer') != null)
    const plain = screen.getByRole('region', { name: 'Plain' })
    assert.equal(plain.querySelector('.m-card__body'), null)
    assert.equal(plain.querySelector('.m-card__header'), null)
  })

  it('draws the page header with the one h1 the route change focuses', () => {
    render(
      <PageHeader
        title="Nodes"
        pill={<span>3</span>}
        description="Workers."
        actions={<button>Pair a node</button>}
      />,
    )
    const h1 = screen.getByRole('heading', { level: 1 })
    assert.equal(h1.id, PAGE_TITLE_ID)
    assert.equal(h1.tabIndex, -1)
    screen.getByText('Workers.')
    screen.getByRole('button', { name: 'Pair a node' })
    cleanup()
    render(<PageHeader title="Plain" />)
    assert.equal(document.querySelector('.m-page__desc'), null)
    assert.equal(document.querySelector('.m-page__actions'), null)
  })
})

describe('Buttons', () => {
  it('uses the library button with Mason’s variant classes', () => {
    let pressed = 0
    render(
      <>
        <Button variant="primary" onClick={() => pressed++}>
          Save
        </Button>
        <Button iconOnly icon="close" label="Close" size="sm" />
        <Button busy variant="danger-filled" onClick={() => pressed++}>
          Remove
        </Button>
      </>,
    )
    const save = screen.getByRole('button', { name: 'Save' })
    assert.match(save.className, /\bios27-btn\b/)
    assert.match(save.className, /\bm-btn m-btn--primary\b/)
    assert.equal(save.getAttribute('type'), 'button')
    save.click()
    assert.equal(pressed, 1)
    const close = screen.getByRole('button', { name: 'Close' })
    assert.match(close.className, /m-btn--secondary m-btn--sm m-btn--icon/)
    assert.equal(close.title, 'Close')
    assert.equal(close.textContent, glyph('close'))
    const busy = screen.getByRole('button', { name: 'Remove' })
    assert.equal(busy.getAttribute('aria-busy'), 'true')
    assert.equal(busy.getAttribute('aria-disabled'), 'true')
    assert.match(busy.className, /m-btn--busy/)
    busy.click()
    assert.equal(pressed, 1)
  })

  it('styles a navigation as a button, in the app or with a full load', () => {
    render(
      <MemoryRouter>
        <ButtonLink to="/backups" variant="secondary" size="sm" icon="backup">
          Open Backups
        </ButtonLink>
        <ButtonLink
          to="/sign-in"
          reloadDocument
          iconOnly
          icon="login"
          label="Sign in"
        />
      </MemoryRouter>,
    )
    const link = screen.getByRole('link', { name: 'Open Backups' })
    assert.equal(link.getAttribute('href'), '/backups')
    assert.equal(link.className, 'm-btn m-btn--secondary m-btn--sm')
    const icon = screen.getByRole('link', { name: 'Sign in' })
    assert.equal(icon.title, 'Sign in')
    assert.equal(
      buttonClass({ busy: true, className: 'x' }),
      'm-btn m-btn--secondary m-btn--busy x',
    )
  })
})

describe('Banners', () => {
  const item = (key: string, tone: BannerItem['tone']): BannerItem => ({
    key,
    tone,
    node: <Banner tone={tone} title={key} />,
  })

  it('draws a banner with its glyph, words, meta and actions, compact or announced', () => {
    render(
      <>
        <Banner
          tone="warning"
          title="The master is unreachable"
          meta="Last reached Today 1426 PT"
          actions={<button>Retry</button>}
          announce
        >
          You are seeing the last synced builds.
        </Banner>
        <Banner tone="info" icon="bolt" title="Test endpoints are on" compact />
      </>,
    )
    const banner = screen.getByRole('status')
    assert.equal(banner.className, 'm-banner m-banner--warning')
    assert.equal(banner.querySelector('.m-icon')!.textContent, glyph('warning'))
    screen.getByText('Last reached Today 1426 PT')
    screen.getByText('You are seeing the last synced builds.')
    const compact = screen
      .getByText('Test endpoints are on')
      .closest('.m-banner')!
    assert.equal(compact.className, 'm-banner m-banner--info m-banner--compact')
    assert.equal(compact.getAttribute('role'), null)
    assert.equal(compact.querySelector('.m-icon')!.textContent, glyph('bolt'))
  })

  it('puts the most severe first and keeps equals in order', () => {
    const sorted = bySeverity([
      item('i', 'info'),
      item('w1', 'warning'),
      item('s', 'success'),
      item('d', 'danger'),
      item('w2', 'warning'),
    ])
    assert.deepEqual(
      sorted.map((entry) => entry.key),
      ['d', 'w1', 'w2', 'i', 's'],
    )
  })

  it('stacks two and collapses the rest into “+N more notices”', async () => {
    const { rerender } = render(<Banners items={[]} />)
    assert.equal(document.querySelector('.m-banners'), null)
    rerender(
      <Banners
        items={[
          item('info', 'info'),
          item('warn', 'warning'),
          item('danger', 'danger'),
          item('ok', 'success'),
        ]}
      />,
    )
    const titles = (): string[] =>
      [...document.querySelectorAll('.m-banner__title')].map(
        (node) => node.textContent!,
      )
    assert.deepEqual(titles(), ['danger', 'warn'])
    const more = screen.getByRole('button', { name: '+2 more notices' })
    assert.equal(more.getAttribute('aria-expanded'), 'false')
    await act(async () => more.click())
    assert.deepEqual(titles(), ['danger', 'warn', 'info', 'ok'])
    await act(async () =>
      screen.getByRole('button', { name: 'Show fewer notices' }).click(),
    )
    assert.deepEqual(titles(), ['danger', 'warn'])
    rerender(
      <Banners
        items={[item('a', 'info'), item('b', 'info'), item('c', 'info')]}
      />,
    )
    screen.getByRole('button', { name: '+1 more notice' })
    rerender(<Banners items={[item('a', 'info'), item('b', 'info')]} />)
    assert.equal(screen.queryByRole('button'), null)
  })
})

describe('Toasts', () => {
  function Trigger({ action }: { action?: () => void }): JSX.Element {
    const show = useToast()
    return (
      <button
        onClick={() =>
          show({
            text: 'Removed Jo Park from Testers',
            ...(action == null
              ? {}
              : { action: { label: 'Undo', run: action } }),
          })
        }
      >
        Show
      </button>
    )
  }
  const wait = async (ms: number): Promise<void> =>
    await act(
      async () => await new Promise((resolve) => setTimeout(resolve, ms)),
    )

  it('announces a toast in the polite region without taking focus, and lets it go after 4 s', async () => {
    const clock = withClock()
    try {
      render(
        <ToastProvider>
          <Trigger />
        </ToastProvider>,
      )
      const region = screen.getByRole('status')
      assert.equal(region.getAttribute('aria-live'), 'polite')
      const show = screen.getByRole('button', { name: 'Show' })
      show.focus()
      await act(async () => show.click())
      assert.match(region.textContent!, /Removed Jo Park from Testers/)
      assert.equal(document.activeElement, show)
      await clock.advance(TOAST_MS - 10)
      assert.match(region.textContent!, /Removed Jo Park/)
      await clock.advance(20)
      assert.equal(region.textContent, '')
    } finally {
      clock.restore()
    }
    await wait(0)
  })

  it('tones a failure danger and a warning warning, and the rest success', async () => {
    assert.equal(toneOf('error'), 'danger')
    assert.equal(toneOf('warning'), 'warning')
    assert.equal(toneOf('block'), 'success')
    assert.equal(toneOf(undefined), 'success')
    function Fail(): JSX.Element {
      const show = useToast()
      return (
        <button onClick={() => show({ text: 'Unreachable', icon: 'error' })}>
          Fail
        </button>
      )
    }
    render(
      <ToastProvider>
        <Fail />
      </ToastProvider>,
    )
    await act(async () => screen.getByRole('button', { name: 'Fail' }).click())
    assert.equal(
      document.querySelector('.m-toast')!.getAttribute('data-tone'),
      'danger',
    )
  })

  it('keeps one with Undo 10 s, pauses it while hovered or focused, and runs the action', async () => {
    const clock = withClock()
    let undone = 0
    try {
      render(
        <ToastProvider>
          <Trigger action={() => undone++} />
        </ToastProvider>,
      )
      await act(async () =>
        screen.getByRole('button', { name: 'Show' }).click(),
      )
      const toast = document.querySelector<HTMLElement>('.m-toast')!
      await clock.advance(TOAST_MS + 100)
      assert(document.querySelector('.m-toast') != null)
      fireEvent.mouseEnter(toast)
      await clock.advance(TOAST_ACTION_MS)
      assert(document.querySelector('.m-toast') != null, 'paused while hovered')
      fireEvent.mouseLeave(toast)
      const undo = screen.getByRole('button', { name: 'Undo' })
      await act(async () => undo.focus())
      await clock.advance(TOAST_ACTION_MS)
      assert(document.querySelector('.m-toast') != null, 'paused while focused')
      fireEvent.focusIn(undo)
      fireEvent.blur(undo, {
        relatedTarget: screen.getByRole('button', { name: 'Dismiss' }),
      })
      await clock.advance(TOAST_ACTION_MS)
      assert(document.querySelector('.m-toast') != null, 'focus stayed inside')
      fireEvent.blur(undo, { relatedTarget: document.body })
      await act(async () => undo.click())
      assert.equal(undone, 1)
      assert.equal(document.querySelector('.m-toast'), null)
      await act(async () =>
        screen.getByRole('button', { name: 'Show' }).click(),
      )
      await act(async () =>
        screen.getByRole('button', { name: 'Dismiss' }).click(),
      )
      assert.equal(document.querySelector('.m-toast'), null)
    } finally {
      clock.restore()
    }
  })

  it('does nothing outside a provider', () => {
    render(<Trigger />)
    screen.getByRole('button', { name: 'Show' }).click()
    assert.equal(document.querySelector('.m-toast'), null)
  })
})

describe('Tooltips and toggletips', () => {
  it('describes its control, hides on Esc and comes back when the pointer leaves', async () => {
    render(
      <Tooltip content="Available when the run has finished">
        <button>Restart</button>
      </Tooltip>,
    )
    const button = screen.getByRole('button', { name: 'Restart' })
    const tip = screen.getByRole('tooltip')
    assert.equal(button.getAttribute('aria-describedby'), tip.id)
    const wrap = tip.parentElement!
    fireEvent.keyDown(button, { key: 'Escape' })
    assert.equal(wrap.getAttribute('data-dismissed'), '')
    fireEvent.keyDown(button, { key: 'a' })
    fireEvent.mouseLeave(wrap)
    assert.equal(wrap.getAttribute('data-dismissed'), null)
    fireEvent.keyDown(button, { key: 'Escape' })
    fireEvent.blur(button)
    assert.equal(wrap.getAttribute('data-dismissed'), null)
  })

  it('shows a toggletip’s detail in a polite region on press, and hides it on a second press, Esc or a press elsewhere', async () => {
    render(
      <>
        <Toggletip label="About build numbers">
          Each app ID’s numbers rise by one per build.
        </Toggletip>
        <p>Elsewhere</p>
      </>,
    )
    const button = screen.getByRole('button', { name: 'About build numbers' })
    const region = screen.getByRole('status')
    assert.equal(region.textContent, '')
    await act(async () => button.click())
    assert.equal(button.getAttribute('aria-expanded'), 'true')
    assert.match(region.textContent!, /rise by one/)
    await act(async () => button.click())
    assert.equal(region.textContent, '')
    await act(async () => button.click())
    fireEvent.keyDown(button, { key: 'Escape' })
    assert.equal(region.textContent, '')
    await act(async () => button.click())
    fireEvent.mouseDown(region)
    assert.match(region.textContent!, /rise by one/)
    fireEvent.mouseDown(screen.getByText('Elsewhere'))
    assert.equal(region.textContent, '')
  })
})

/** A hand-run clock for timers and Date.now. */
function withClock(): {
  advance: (ms: number) => Promise<void>
  restore: () => void
} {
  const realSet = globalThis.setTimeout
  const realClear = globalThis.clearTimeout
  const realNow = Date.now
  let now = realNow()
  let next = 0
  const timers = new Map<number, { at: number; run: () => void }>()
  globalThis.setTimeout = ((run: () => void, ms = 0) => {
    next += 1
    timers.set(next, { at: now + ms, run })
    return next
  }) as unknown as typeof setTimeout
  globalThis.clearTimeout = ((id: number) => {
    timers.delete(id)
  }) as typeof clearTimeout
  Date.now = (): number => now
  return {
    advance: async (ms): Promise<void> => {
      now += ms
      await act(async () => {
        for (const [id, timer] of [...timers])
          if (timer.at <= now) {
            timers.delete(id)
            timer.run()
          }
      })
    },
    restore: (): void => {
      globalThis.setTimeout = realSet
      globalThis.clearTimeout = realClear
      Date.now = realNow
    },
  }
}

describe('Platforms, stat tiles and filter pills', () => {
  it('gives every platform one name, colour and glyph, and an unknown one its own name', async () => {
    const { platformLook } = await import('./platform.js')
    assert.deepEqual(platformLook('tvos'), {
      name: 'tvOS',
      series: 2,
      icon: 'ios',
    })
    assert.deepEqual(platformLook('linux'), {
      name: 'linux',
      series: 6,
      icon: 'apps',
    })
  })

  it('draws a stat tile’s unit and foot, a meter of non-zero shares, and pills with one pressed', async () => {
    const { StatTile, Meter } = await import('./StatTile.js')
    const { FilterPills } = await import('./FilterPills.js')
    const chosen: string[] = []
    render(
      <>
        <StatTile label="Storage" value="1.2" unit="GB" foot="Builds" />
        <Meter
          parts={[
            { label: 'iOS', value: 2, series: 1 },
            { label: 'tvOS', value: 0, series: 2 },
          ]}
        />
        <FilterPills
          label="Platform"
          value="all"
          onChange={(key) => chosen.push(key)}
          options={[
            { key: 'all', label: 'All', count: 3 },
            { key: 'ios', label: 'iOS', count: 2 },
          ]}
        />
      </>,
    )
    screen.getByText('GB')
    screen.getByText('Builds')
    screen.getByRole('img', { name: 'iOS 2' })
    fireEvent.click(screen.getByRole('button', { name: 'iOS 2' }))
    assert.deepEqual(chosen, ['ios'])
    assert.equal(
      screen
        .getByRole('button', { name: 'All 3' })
        .getAttribute('aria-pressed'),
      'true',
    )
  })
})
