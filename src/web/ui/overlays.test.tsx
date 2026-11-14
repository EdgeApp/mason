import assert from 'node:assert/strict'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, it } from 'mocha'
import { useRef, useState, type JSX } from 'react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { matchMedia, narrow } from '../test/render.js'
import { Alert } from './Alert.js'
import { Dialog } from './Dialog.js'
import { Menu, TYPEAHEAD_MS, type MenuEntry } from './Menu.js'
import { Popover } from './Popover.js'
import { DRAG_TO_CLOSE, Sheet } from './Sheet.js'

afterEach(cleanup)

/** A trigger that opens an overlay and shows when it closed. */
function Opener({
  children,
}: {
  children: (open: boolean, close: () => void) => JSX.Element
}): JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button onClick={() => setOpen(true)}>Open</button>
      <span data-testid="state">{open ? 'open' : 'closed'}</span>
      {children(open, () => setOpen(false))}
    </>
  )
}

const state = (): string => screen.getByTestId('state').textContent!
const open = async (): Promise<HTMLElement> => {
  const trigger = screen.getByRole('button', { name: 'Open' })
  trigger.focus()
  await act(async () => trigger.click())
  return trigger
}

describe('The overlay dialog', () => {
  it('opens modal, focuses its first field, wraps Tab, closes on Esc and the scrim, and gives focus back', async () => {
    render(
      <Opener>
        {(isOpen, close) => (
          <Dialog open={isOpen} onClose={close} label="Rename">
            <div className="panel">
              <input aria-label="Name" />
              <button>Save</button>
            </div>
          </Dialog>
        )}
      </Opener>,
    )
    const trigger = await open()
    const dialog = document.querySelector('dialog')!
    assert.equal(dialog.open, true)
    assert.equal(dialog.getAttribute('aria-modal'), 'true')
    assert.equal(dialog.getAttribute('aria-label'), 'Rename')
    const name = screen.getByRole('textbox', { name: 'Name' })
    assert.equal(document.activeElement, name)
    const save = screen.getByRole('button', { name: 'Save' })
    save.focus()
    fireEvent.keyDown(save, { key: 'Tab' })
    assert.equal(document.activeElement, name)
    fireEvent.keyDown(name, { key: 'Tab', shiftKey: true })
    assert.equal(document.activeElement, save)
    fireEvent.keyDown(name, { key: 'Tab' })
    fireEvent.keyDown(save, { key: 'Enter' })
    await act(async () => fireEvent.keyDown(save, { key: 'Escape' }))
    assert.equal(state(), 'closed')
    assert.equal(document.querySelector('dialog'), null)
    assert.equal(document.activeElement, trigger)
    await open()
    fireEvent.mouseDown(document.querySelector('.panel')!)
    assert.equal(state(), 'open')
    await act(async () =>
      fireEvent.mouseDown(document.querySelector('.m-scrim')!),
    )
    assert.equal(state(), 'closed')
    await open()
    await act(async () =>
      fireEvent(
        document.querySelector('dialog')!,
        new window.Event('cancel', { cancelable: true }),
      ),
    )
    assert.equal(state(), 'closed')
  })

  it('focuses its title without a field, or what it is told, and never closes an alert from the scrim', async () => {
    function Titled({ focus }: { focus: boolean }): JSX.Element {
      const target = useRef<HTMLButtonElement>(null)
      return (
        <Opener>
          {(isOpen, close) => (
            <Dialog
              open={isOpen}
              onClose={close}
              role="alertdialog"
              labelledBy="t"
              dismissOnScrim={false}
              {...(focus ? { initialFocus: target } : {})}
            >
              <h2 id="t" tabIndex={-1} data-dialog-title="">
                Remove Jo?
              </h2>
              <button ref={target}>Remove</button>
            </Dialog>
          )}
        </Opener>
      )
    }
    const { rerender } = render(<Titled focus={false} />)
    await open()
    const dialog = screen.getByRole('alertdialog', { name: 'Remove Jo?' })
    assert.equal(
      document.activeElement,
      screen.getByRole('heading', { name: 'Remove Jo?' }),
    )
    await act(async () =>
      fireEvent.mouseDown(dialog.querySelector('.m-scrim')!),
    )
    assert.equal(state(), 'open')
    rerender(<></>)
    rerender(<Titled focus />)
    await open()
    assert.equal(
      document.activeElement,
      screen.getByRole('button', { name: 'Remove' }),
    )
  })

  it('wraps nothing when it holds nothing to focus', async () => {
    render(
      <Opener>
        {(isOpen, close) => (
          <Dialog open={isOpen} onClose={close} label="Empty">
            <p>Nothing here</p>
          </Dialog>
        )}
      </Opener>,
    )
    await open()
    const dialog = document.querySelector('dialog')!
    fireEvent.keyDown(dialog, { key: 'Tab' })
    assert.equal(state(), 'open')
  })
})

describe('Sheets', () => {
  it('names itself by its title, has a visible Close, and a footer', async () => {
    render(
      <Opener>
        {(isOpen, close) => (
          <Sheet
            open={isOpen}
            onClose={close}
            title="Add a value"
            footer={<button>Add</button>}
          >
            <label>
              Name <input />
            </label>
          </Sheet>
        )}
      </Opener>,
    )
    await open()
    const dialog = screen.getByRole('dialog', { name: 'Add a value' })
    assert(dialog.querySelector('.m-formsheet .m-formsheet__foot') != null)
    assert.equal(
      document.activeElement,
      screen.getByRole('textbox', { name: 'Name' }),
    )
    await act(async () => screen.getByRole('button', { name: 'Close' }).click())
    assert.equal(state(), 'closed')
  })

  it('asks before closing with unsaved changes, and keeps editing or discards', async () => {
    render(
      <Opener>
        {(isOpen, close) => (
          <Sheet open={isOpen} onClose={close} title="Edit" dirty size="large">
            <p>fields</p>
          </Sheet>
        )}
      </Opener>,
    )
    await open()
    assert(document.querySelector('.m-largesheet') != null)
    assert.equal(
      document.activeElement,
      screen.getByRole('heading', { name: 'Edit' }),
    )
    await act(async () => screen.getByRole('button', { name: 'Close' }).click())
    screen.getByRole('alertdialog', { name: 'Discard your changes?' })
    await act(async () =>
      screen.getByRole('button', { name: 'Keep editing' }).click(),
    )
    assert.equal(screen.queryByRole('alertdialog'), null)
    assert.equal(state(), 'open')
    await act(async () =>
      fireEvent.keyDown(document.querySelector('dialog')!, { key: 'Escape' }),
    )
    await act(async () =>
      screen.getByRole('button', { name: 'Discard' }).click(),
    )
    assert.equal(state(), 'closed')
  })

  it('closes on narrow when dragged down far enough by its head, and springs back otherwise', async () => {
    const restore = matchMedia(narrow)
    try {
      render(
        <Opener>
          {(isOpen, close) => (
            <Sheet open={isOpen} onClose={close} title="Stage">
              <p>list</p>
            </Sheet>
          )}
        </Opener>,
      )
      await open()
      const head = document.querySelector<HTMLElement>('.m-formsheet__head')!
      const sheet = document.querySelector<HTMLElement>('.m-formsheet')!
      fireEvent.pointerMove(head, { clientY: 300 })
      fireEvent.pointerUp(head)
      fireEvent.pointerDown(head, { clientY: 100 })
      fireEvent.pointerMove(head, { clientY: 140 })
      assert.equal(sheet.style.transform, 'translateY(40px)')
      fireEvent.pointerUp(head)
      assert.equal(sheet.style.transform, '')
      assert.equal(state(), 'open')
      fireEvent.pointerDown(head, { clientY: 100 })
      fireEvent.pointerMove(head, { clientY: 100 + DRAG_TO_CLOSE + 20 })
      await act(async () => fireEvent.pointerUp(head))
      assert.equal(state(), 'closed')
    } finally {
      restore()
    }
  })

  it('does not drag on wide screens', async () => {
    render(
      <Opener>
        {(isOpen, close) => (
          <Sheet open={isOpen} onClose={close} title="Stage">
            <p>list</p>
          </Sheet>
        )}
      </Opener>,
    )
    await open()
    const head = document.querySelector<HTMLElement>('.m-formsheet__head')!
    fireEvent.pointerDown(head, { clientY: 100 })
    fireEvent.pointerMove(head, { clientY: 400 })
    fireEvent.pointerUp(head)
    assert.equal(state(), 'open')
  })
})

describe('Alerts', () => {
  it('confirms a destructive action with the danger fill, and backs out with Cancel or Esc', async () => {
    const events: string[] = []
    function Remove(): JSX.Element {
      const [isOpen, setOpen] = useState(true)
      return (
        <Alert
          open={isOpen}
          title="Remove Jo Park?"
          message="Jo can no longer sign in."
          confirm="Remove"
          tone="danger"
          onConfirm={() => {
            events.push('confirm')
            setOpen(false)
          }}
          onCancel={() => {
            events.push('cancel')
            setOpen(false)
          }}
        />
      )
    }
    const { rerender } = render(<Remove />)
    const confirm = screen.getByRole('button', { name: 'Remove' })
    assert.match(confirm.className, /m-btn--danger-filled/)
    screen.getByText('Jo can no longer sign in.')
    await act(async () => confirm.click())
    rerender(<></>)
    rerender(<Remove />)
    await act(async () =>
      screen.getByRole('button', { name: 'Cancel' }).click(),
    )
    rerender(<></>)
    rerender(<Remove />)
    await act(async () =>
      fireEvent.keyDown(screen.getByRole('alertdialog'), { key: 'Escape' }),
    )
    assert.deepEqual(events, ['confirm', 'cancel', 'cancel'])
  })

  it('waits for the name typed exactly at the third tier, starting in the field', async () => {
    let confirmed = 0
    render(
      <Alert
        open
        title="Remove the host?"
        confirm="Remove host"
        tone="danger"
        typeToConfirm="mason-host-1"
        onConfirm={() => confirmed++}
        onCancel={() => undefined}
      />,
    )
    const field = screen.getByRole('textbox', {
      name: /Type mason-host-1 to confirm/,
    })
    assert.equal(document.activeElement, field)
    const confirm = screen.getByRole('button', { name: 'Remove host' })
    assert.equal((confirm as HTMLButtonElement).disabled, true)
    fireEvent.change(field, { target: { value: 'mason-host' } })
    assert.equal((confirm as HTMLButtonElement).disabled, true)
    fireEvent.change(field, { target: { value: 'mason-host-1 ' } })
    assert.equal((confirm as HTMLButtonElement).disabled, false)
    await act(async () => confirm.click())
    assert.equal(confirmed, 1)
    assert.equal((field as HTMLInputElement).value, '')
  })

  it('confirms a plain action with the primary button', () => {
    render(
      <Alert
        open
        title="Save?"
        confirm="Save"
        busy
        onConfirm={() => undefined}
        onCancel={() => undefined}
      />,
    )
    const save = screen.getByRole('button', { name: 'Save' })
    assert.match(save.className, /m-btn--primary/)
    assert.equal(save.getAttribute('aria-busy'), 'true')
  })
})

describe('Menus', () => {
  const ran: string[] = []
  const entries = (checked: string): MenuEntry[] => [
    { kind: 'label', content: <strong>Paul</strong> },
    { kind: 'separator' },
    { kind: 'item', label: 'Your account', icon: 'person', to: '/account' },
    {
      kind: 'item',
      label: 'Dark',
      checked: checked === 'Dark',
      run: () => ran.push('Dark'),
    },
    {
      kind: 'item',
      label: 'Light',
      checked: checked === 'Light',
      run: () => ran.push('Light'),
    },
    {
      kind: 'item',
      label: 'Delete',
      danger: true,
      run: () => ran.push('Delete'),
    },
  ]
  const renderMenu = (): void => {
    render(
      <MemoryRouter>
        <Routes>
          <Route
            path="*"
            element={
              <>
                <Menu
                  label="Account"
                  entries={entries('Dark')}
                  trigger={<span>P</span>}
                  triggerLabel="Your account"
                />
                <p>Outside</p>
              </>
            }
          />
          <Route path="/account" element={<h1>Account page</h1>} />
        </Routes>
      </MemoryRouter>,
    )
  }
  const items = (): HTMLElement[] => [
    ...document.querySelectorAll<HTMLElement>('[role^="menuitem"]'),
  ]
  afterEach(() => {
    ran.length = 0
  })

  it('opens from its button onto the first item; arrows, Home and End move; Esc closes back to the button', async () => {
    renderMenu()
    const button = screen.getByRole('button', { name: 'Your account' })
    assert.equal(button.getAttribute('aria-haspopup'), 'menu')
    await act(async () => button.click())
    const menu = screen.getByRole('menu', { name: 'Account' })
    assert.equal(button.getAttribute('aria-expanded'), 'true')
    assert.equal(button.getAttribute('aria-controls'), menu.id)
    assert.equal(document.activeElement, items()[0])
    fireEvent.keyDown(menu, { key: 'ArrowDown' })
    assert.equal(document.activeElement, items()[1])
    fireEvent.keyDown(menu, { key: 'End' })
    assert.equal(document.activeElement, items()[3])
    fireEvent.keyDown(menu, { key: 'ArrowDown' })
    assert.equal(document.activeElement, items()[0])
    fireEvent.keyDown(menu, { key: 'ArrowUp' })
    assert.equal(document.activeElement, items()[3])
    fireEvent.keyDown(menu, { key: 'Home' })
    assert.equal(document.activeElement, items()[0])
    const dark = screen.getByRole('menuitemradio', { name: 'Dark' })
    assert.equal(dark.getAttribute('aria-checked'), 'true')
    assert.equal(
      screen
        .getByRole('menuitemradio', { name: 'Light' })
        .getAttribute('aria-checked'),
      'false',
    )
    assert.match(
      screen.getByRole('menuitem', { name: 'Delete' }).className,
      /m-menu__item--danger/,
    )
    await act(async () => fireEvent.keyDown(menu, { key: 'Escape' }))
    assert.equal(screen.queryByRole('menu'), null)
    assert.equal(document.activeElement, button)
    await act(async () => fireEvent.keyDown(button, { key: 'ArrowDown' }))
    assert.equal(document.activeElement, items()[0])
    await act(async () =>
      fireEvent.keyDown(screen.getByRole('menu'), { key: 'Tab' }),
    )
    assert.equal(screen.queryByRole('menu'), null)
    fireEvent.keyDown(button, { key: 'Enter' })
  })

  it('jumps to the item typed, a letter or more, and wraps', async () => {
    renderMenu()
    await act(async () =>
      screen.getByRole('button', { name: 'Your account' }).click(),
    )
    const menu = screen.getByRole('menu')
    const realNow = Date.now
    let now = 1_000_000
    Date.now = (): number => now
    try {
      fireEvent.keyDown(menu, { key: 'd' })
      assert.equal(
        document.activeElement,
        screen.getByRole('menuitemradio', { name: 'Dark' }),
      )
      now += 10
      fireEvent.keyDown(menu, { key: 'e' })
      assert.equal(
        document.activeElement,
        screen.getByRole('menuitem', { name: 'Delete' }),
      )
      now += TYPEAHEAD_MS + 1
      fireEvent.keyDown(menu, { key: 'l' })
      assert.equal(
        document.activeElement,
        screen.getByRole('menuitemradio', { name: 'Light' }),
      )
      now += TYPEAHEAD_MS + 1
      fireEvent.keyDown(menu, { key: 'z' })
      assert.equal(
        document.activeElement,
        screen.getByRole('menuitemradio', { name: 'Light' }),
      )
      fireEvent.keyDown(menu, { key: ' ' })
    } finally {
      Date.now = realNow
    }
  })

  it('runs an item, goes where it links, and closes on a press outside', async () => {
    renderMenu()
    const button = screen.getByRole('button', { name: 'Your account' })
    await act(async () => button.click())
    await act(async () =>
      screen.getByRole('menuitemradio', { name: 'Light' }).click(),
    )
    assert.deepEqual(ran, ['Light'])
    assert.equal(document.activeElement, button)
    await act(async () => button.click())
    await act(async () => fireEvent.mouseDown(screen.getByText('Outside')))
    assert.equal(screen.queryByRole('menu'), null)
    await act(async () => button.click())
    await act(async () => button.click())
    assert.equal(screen.queryByRole('menu'), null)
    await act(async () => button.click())
    await act(async () =>
      screen.getByRole('menuitem', { name: 'Your account' }).click(),
    )
    screen.getByRole('heading', { name: 'Account page' })
  })

  it('is an action sheet on narrow, with its title, every item and Close', async () => {
    const restore = matchMedia(narrow)
    try {
      renderMenu()
      const button = screen.getByRole('button', { name: 'Your account' })
      assert.equal(button.getAttribute('aria-haspopup'), 'dialog')
      await act(async () => button.click())
      const sheet = screen.getByRole('dialog', { name: 'Account' })
      assert(sheet.querySelector('.m-actionsheet__title strong') != null)
      const dark = screen.getByRole('button', { name: /^Dark/ })
      assert.equal(dark.getAttribute('aria-pressed'), 'true')
      assert.equal(
        screen.getByRole('button', { name: 'Delete' }).className,
        'm-actionsheet__danger',
      )
      await act(async () =>
        screen.getByRole('button', { name: 'Delete' }).click(),
      )
      assert.deepEqual(ran, ['Delete'])
      assert.equal(screen.queryByRole('dialog'), null)
      await act(async () => button.click())
      await act(async () =>
        screen.getByRole('button', { name: 'Close' }).click(),
      )
      assert.equal(screen.queryByRole('dialog'), null)
    } finally {
      restore()
    }
  })
})

describe('Popovers', () => {
  function Notifications(): JSX.Element {
    const [isOpen, setOpen] = useState(false)
    return (
      <>
        <Popover
          open={isOpen}
          onClose={() => setOpen(false)}
          title="Notifications"
          aside={<span>2</span>}
          trigger={
            <button aria-expanded={isOpen} onClick={() => setOpen(!isOpen)}>
              Bell
            </button>
          }
        >
          <a href="/runs/1">Run 1 waits</a>
        </Popover>
        <button>Elsewhere</button>
      </>
    )
  }

  it('hangs below its trigger, focuses its title, and closes on Esc back to the trigger', async () => {
    render(<Notifications />)
    const bell = screen.getByRole('button', { name: 'Bell' })
    await act(async () => bell.click())
    const panel = screen.getByRole('dialog', { name: 'Notifications' })
    assert.equal(panel.className, 'm-popover')
    assert.equal(panel.parentElement!.className, 'm-anchor')
    assert.equal(
      document.activeElement,
      screen.getByRole('heading', { name: 'Notifications' }),
    )
    fireEvent.keyDown(panel, { key: 'a' })
    await act(async () => fireEvent.keyDown(panel, { key: 'Escape' }))
    assert.equal(screen.queryByRole('dialog'), null)
    assert.equal(document.activeElement, bell)
  })

  it('closes when focus or a press goes elsewhere', async () => {
    render(<Notifications />)
    const bell = screen.getByRole('button', { name: 'Bell' })
    await act(async () => bell.click())
    await act(async () => fireEvent.mouseDown(screen.getByRole('link')))
    screen.getByRole('dialog')
    await act(async () =>
      screen.getByRole('button', { name: 'Elsewhere' }).focus(),
    )
    assert.equal(screen.queryByRole('dialog'), null)
    await act(async () => bell.click())
    await act(async () =>
      fireEvent.mouseDown(screen.getByRole('button', { name: 'Elsewhere' })),
    )
    assert.equal(screen.queryByRole('dialog'), null)
  })

  it('is a sheet on narrow', async () => {
    const restore = matchMedia(narrow)
    try {
      render(<Notifications />)
      await act(async () =>
        screen.getByRole('button', { name: 'Bell' }).click(),
      )
      const sheet = screen.getByRole('dialog', { name: 'Notifications' })
      assert.equal(sheet.tagName, 'DIALOG')
      await act(async () =>
        screen.getByRole('button', { name: 'Close' }).click(),
      )
      assert.equal(screen.queryByRole('dialog'), null)
    } finally {
      restore()
    }
  })
})
