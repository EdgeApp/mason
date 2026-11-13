import assert from 'node:assert/strict'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, it } from 'mocha'
import { useState, type JSX } from 'react'
import { COPIED_MS, CopyField } from './CopyField.js'
import {
  CheckboxInput,
  SelectInput,
  StepperInput,
  TextAreaInput,
} from './Field.js'
import {
  draftKey,
  FormDisclosure,
  FormSection,
  LargeSheet,
  useDraft,
} from './LargeSheet.js'

afterEach(() => {
  cleanup()
  window.sessionStorage.clear()
})

/** The clipboard the field writes to: what it was given, or a refusal. */
function clipboard(refuse = false): { written: string[]; restore: () => void } {
  const written: string[] = []
  const had = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: {
      writeText: async (text: string) => {
        if (refuse) throw new Error('denied')
        written.push(text)
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

describe('The copy field', () => {
  it('copies its value and says Copied, then Copy again', async () => {
    const board = clipboard()
    try {
      render(<CopyField value="mason1:abc" label="Key" block />)
      assert.equal(
        document.querySelector('.m-copy--block code')!.textContent,
        'mason1:abc',
      )
      assert.equal(document.querySelector('.m-copy__label')!.textContent, 'Key')
      const button = screen.getByRole('button', { name: 'Copy' })
      await act(async () => button.click())
      assert.deepEqual(board.written, ['mason1:abc'])
      assert.equal(button.textContent?.includes('Copied'), true)
      await act(
        async () =>
          await new Promise((resolve) => setTimeout(resolve, COPIED_MS + 50)),
      )
      assert.equal(button.textContent?.includes('Copy'), true)
      assert.equal(button.textContent?.includes('Copied'), false)
    } finally {
      board.restore()
    }
  })

  it('selects the value to copy by hand where the clipboard is refused, and names its button', async () => {
    const board = clipboard(true)
    try {
      render(
        <CopyField
          value="https://h/auth/callback/g"
          name="the host's callback URL"
        />,
      )
      const button = screen.getByRole('button', {
        name: "Copy: the host's callback URL",
      })
      await act(async () => button.click())
      assert.equal(button.textContent?.includes('Select and copy'), true)
      assert.equal(
        window.getSelection()?.toString(),
        'https://h/auth/callback/g',
      )
    } finally {
      board.restore()
    }
  })
})

describe('The form fields', () => {
  it('draws a select with its options, help and error, and reports the choice', () => {
    const chosen: string[] = []
    render(
      <SelectInput
        label="Region"
        value="sfo3"
        options={['nyc3', { value: 'sfo3', label: 'San Francisco 3 (sfo3)' }]}
        onChange={(value) => chosen.push(value)}
        help="Where it runs."
        error="Choose a region"
        mono
        optional
      />,
    )
    const select = screen.getByRole('combobox', { name: /Region/ })
    assert.equal((select as HTMLSelectElement).value, 'sfo3')
    assert.equal(select.getAttribute('aria-invalid'), 'true')
    assert.match(select.className, /m-input--mono/)
    fireEvent.change(select, { target: { value: 'nyc3' } })
    assert.deepEqual(chosen, ['nyc3'])
    assert.equal(
      screen.getByRole('alert').textContent?.includes('Choose a region'),
      true,
    )
  })

  it('draws a text area and a checkbox with help', () => {
    const typed: string[] = []
    const checked: boolean[] = []
    render(
      <>
        <TextAreaInput
          label="Private key"
          value=""
          mono
          rows={4}
          onChange={(value) => typed.push(value)}
        />
        <CheckboxInput
          label="Enabled"
          checked={false}
          help="A disabled method is kept but not offered."
          onChange={(value) => checked.push(value)}
        />
      </>,
    )
    const area = screen.getByRole('textbox', { name: 'Private key' })
    assert.match(area.className, /m-textarea--mono/)
    fireEvent.change(area, { target: { value: '-----BEGIN' } })
    assert.deepEqual(typed, ['-----BEGIN'])
    const box = screen.getByRole('checkbox', { name: 'Enabled' })
    assert.equal(
      document.getElementById(box.getAttribute('aria-describedby')!)!
        .textContent,
      'A disabled method is kept but not offered.',
    )
    fireEvent.click(box)
    assert.deepEqual(checked, [true])
  })

  it('steps a number within its range and takes a typed one', () => {
    function Slots(): JSX.Element {
      const [slots, setSlots] = useState(1)
      return (
        <StepperInput
          label="Slots"
          unit="slots"
          min={1}
          max={3}
          value={slots}
          onChange={setSlots}
          help="1–3."
        />
      )
    }
    render(<Slots />)
    const fewer = screen.getByRole('button', { name: 'Fewer slots' })
    const more = screen.getByRole('button', { name: 'More slots' })
    const input = screen.getByRole('textbox', { name: 'Slots' })
    assert.equal((fewer as HTMLButtonElement).disabled, true)
    fireEvent.click(more)
    fireEvent.click(more)
    assert.equal((input as HTMLInputElement).value, '3')
    assert.equal((more as HTMLButtonElement).disabled, true)
    fireEvent.change(input, { target: { value: '' } })
    assert.equal((input as HTMLInputElement).value, '')
    fireEvent.change(input, { target: { value: '9' } })
    fireEvent.blur(input)
    assert.equal((input as HTMLInputElement).value, '3')
    fireEvent.click(fewer)
    assert.equal((input as HTMLInputElement).value, '2')
  })
})

/** A large sheet over a draft of two fields, one of them a secret. */
function Editor({ draft }: { draft: string | null }): JSX.Element {
  const form = useDraft(draft, { name: 'google', secret: '' }, ['secret'])
  return (
    <LargeSheet
      open={draft != null}
      onClose={() => form.clear()}
      title="Sign-in method"
      badge={<span className="m-chip">OpenID Connect</span>}
      dirty={form.dirty}
      footer={(close) => (
        <button type="button" onClick={close}>
          Cancel
        </button>
      )}
    >
      <FormSection legend="Provider">
        <input
          aria-label="Name"
          value={form.value.name}
          onChange={(event) =>
            form.set((was) => ({ ...was, name: event.target.value }))
          }
        />
        <input
          aria-label="Secret"
          value={form.value.secret}
          onChange={(event) =>
            form.set({ ...form.value, secret: event.target.value })
          }
        />
      </FormSection>
      <FormSection legend="Availability" grid={false}>
        <span>{form.restored ? 'restored' : 'fresh'}</span>
      </FormSection>
      <FormDisclosure summary="Claims" note="(OAuth 2 methods only)">
        <input aria-label="Subject claim" />
      </FormDisclosure>
    </LargeSheet>
  )
}

describe('The large sheet', () => {
  it('draws sections and a collapsed disclosure, keeps a draft without its secrets, and restores it', async () => {
    const first = render(<Editor draft="method:google" />)
    assert.ok(document.querySelector('.m-largesheet'))
    assert.equal(
      screen.getByRole('heading', { name: /Sign-in method/ }).textContent,
      'Sign-in method OpenID Connect',
    )
    assert.equal(document.querySelectorAll('legend.m-t-eyebrow').length, 2)
    assert.equal(document.querySelector('details')!.open, false)
    assert.ok(screen.getByText('fresh'))
    fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), {
      target: { value: 'okta' },
    })
    fireEvent.change(screen.getByRole('textbox', { name: 'Secret' }), {
      target: { value: 'hunter2' },
    })
    assert.deepEqual(
      JSON.parse(window.sessionStorage.getItem(draftKey('method:google'))!),
      { name: 'okta' },
    )
    first.unmount()
    // The page reloads: the draft comes back, the secret does not.
    render(<Editor draft="method:google" />)
    assert.equal(
      (screen.getByRole('textbox', { name: 'Name' }) as HTMLInputElement).value,
      'okta',
    )
    assert.equal(
      (screen.getByRole('textbox', { name: 'Secret' }) as HTMLInputElement)
        .value,
      '',
    )
    assert.ok(screen.getByText('restored'))
    // Closing with changes asks first; Discard forgets the draft.
    await act(async () =>
      screen.getByRole('button', { name: 'Cancel' }).click(),
    )
    await act(async () =>
      screen.getByRole('button', { name: 'Discard' }).click(),
    )
    assert.equal(window.sessionStorage.getItem(draftKey('method:google')), null)
    assert.equal(
      (screen.getByRole('textbox', { name: 'Name' }) as HTMLInputElement).value,
      'google',
    )
  })

  it('keeps nothing while closed, starts over for another key, and survives refusing storage', () => {
    const view = render(<Editor draft={null} />)
    assert.equal(document.querySelector('.m-largesheet'), null)
    assert.equal(window.sessionStorage.length, 0)
    window.sessionStorage.setItem(draftKey('method:okta'), '{not json')
    view.rerender(<Editor draft="method:okta" />)
    assert.ok(screen.getByText('fresh'))
    const storage = Object.getPrototypeOf(window.sessionStorage) as Storage
    const setItem = storage.setItem
    storage.setItem = (): never => {
      throw new Error('full')
    }
    try {
      fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), {
        target: { value: 'kept in memory' },
      })
      assert.equal(
        (screen.getByRole('textbox', { name: 'Name' }) as HTMLInputElement)
          .value,
        'kept in memory',
      )
    } finally {
      storage.setItem = setItem
    }
    const getItem = storage.getItem
    storage.getItem = (): never => {
      throw new Error('refused')
    }
    try {
      view.rerender(<Editor draft="method:other" />)
      assert.ok(screen.getByText('fresh'))
    } finally {
      storage.getItem = getItem
    }
    const removeItem = storage.removeItem
    storage.removeItem = (): never => {
      throw new Error('refused')
    }
    try {
      view.rerender(<Editor draft={null} />)
    } finally {
      storage.removeItem = removeItem
    }
  })
})
