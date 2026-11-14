import assert from 'node:assert/strict'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState, type JSX } from 'react'
import { afterEach, describe, it } from 'mocha'
import { until } from '../test/render.js'
import {
  Picker,
  pickerChoices,
  usePicker,
  type PickerItem,
  type PickerState,
} from './Picker.js'

afterEach(() => cleanup())

const items: Array<PickerItem<number>> = [
  {
    id: 1,
    label: 'TeamStation',
    detail: 'app.teamstation.app',
    mono: true,
    search: ['app.teamstation.app'],
  },
  {
    id: 2,
    label: 'Old Kiosk',
    detail: 'app.kiosk',
    mono: true,
    search: ['app.kiosk'],
    offered: false,
  },
  { id: 3, label: 'Director', search: ['app.director'] },
  {
    id: 4,
    label: 'Sam Rivera',
    detail: 'sam@example.test',
    search: ['sam@example.test'],
  },
  { id: 5, label: 'Scoreboard' },
]

/** A save the test answers by hand, one call at a time. */
function manualSave(): {
  calls: number[][]
  save: (ids: number[]) => Promise<number[]>
  answer: (n: number, ids?: number[], error?: string) => Promise<void>
} {
  const waiting: Array<{
    resolve: (ids: number[]) => void
    reject: (error: Error) => void
  }> = []
  const calls: number[][] = []
  return {
    calls,
    save: async (ids) =>
      await new Promise<number[]>((resolve, reject) => {
        calls.push(ids)
        waiting.push({ resolve, reject })
      }),
    answer: async (n, ids, error): Promise<void> => {
      await until(() => waiting.length > n, `save ${n + 1}`)
      await act(async () => {
        if (error != null) waiting[n]!.reject(new Error(error))
        else waiting[n]!.resolve(ids ?? calls[n]!)
      })
    },
  }
}

let state: PickerState<number> | undefined
const saved: Array<[number, boolean]> = []

function Harness({
  save,
  initial = [1],
}: {
  save: (ids: number[]) => Promise<number[]>
  initial?: number[]
}): JSX.Element {
  const [done, setDone] = useState(0)
  const picker = usePicker({
    saved: initial,
    save,
    onSaved: (id, checked) => saved.push([id, checked]),
  })
  state = picker
  return (
    <div>
      <button type="button" onClick={picker.show}>
        Add
      </button>
      <span data-testid="saved">{picker.saved.join(',')}</span>
      <span data-testid="done">{done}</span>
      {picker.error != null && <p role="alert">{picker.error}</p>}
      <Picker
        picker={picker}
        items={items}
        label="Find an app"
        placeholder="App name or ID"
        choiceLabel={(item) => `${item.label} in Testers`}
        onDone={() => setDone((n) => n + 1)}
      />
    </div>
  )
}

const box = (name: string): HTMLInputElement =>
  screen.getByRole('checkbox', { name: `${name} in Testers` })
const choices = (): string[] =>
  screen
    .queryAllByRole('checkbox')
    .map((input) =>
      input.getAttribute('aria-label')!.replace(' in Testers', ''),
    )
const search = (): HTMLInputElement =>
  screen.getByRole('searchbox', { name: 'Find an app' })

describe('The picker', () => {
  it('offers the first three offered entries with an empty query, and matches label or any text ignoring case', () => {
    assert.deepEqual(
      pickerChoices(items, '').map((item) => item.id),
      [1, 3, 4],
    )
    assert.deepEqual(
      pickerChoices(items, '   ', 2).map((item) => item.id),
      [1, 3],
    )
    assert.deepEqual(
      pickerChoices(items, ' KIOSK ').map((item) => item.id),
      [2],
    )
    assert.deepEqual(
      pickerChoices(items, 'sam@').map((item) => item.id),
      [4],
    )
    assert.deepEqual(pickerChoices(items, 'zzz'), [])
  })

  it('opens with its search field focused, filters as typed, says when nothing matches, and closes on Done', async () => {
    const manual = manualSave()
    render(<Harness save={manual.save} />)
    assert.equal(screen.queryByRole('searchbox'), null)
    fireEvent.click(screen.getByText('Add'))
    assert.equal(document.activeElement, search())
    assert.equal(search().placeholder, 'App name or ID')
    assert.deepEqual(choices(), ['TeamStation', 'Director', 'Sam Rivera'])
    assert.equal(box('TeamStation').checked, true)
    assert.equal(box('Director').checked, false)
    screen.getByText('app.teamstation.app')
    assert.ok(
      screen.getByText('app.teamstation.app').className.includes('m-t-mono-sm'),
    )
    assert.ok(
      screen.getByText('sam@example.test').className.includes('m-t-subhead'),
    )
    fireEvent.change(search(), { target: { value: 'kio' } })
    assert.deepEqual(choices(), ['Old Kiosk'])
    fireEvent.change(search(), { target: { value: 'nothing like it' } })
    screen.getByText('Nothing matches.')
    // Enter in the field is held back; Done closes and clears the query.
    const enter = fireEvent.keyDown(search(), { key: 'Enter' })
    assert.equal(enter, false)
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    assert.equal(screen.queryByRole('searchbox'), null)
    assert.equal(screen.getByTestId('done').textContent, '1')
    fireEvent.click(screen.getByText('Add'))
    assert.equal(search().value, '')
  })

  it('closes on Escape from anywhere in it', () => {
    const manual = manualSave()
    render(<Harness save={manual.save} />)
    fireEvent.click(screen.getByText('Add'))
    fireEvent.keyDown(box('Director'), { key: 'Escape' })
    assert.equal(screen.queryByRole('searchbox'), null)
    assert.equal(screen.getByTestId('done').textContent, '1')
    // Other keys leave it open.
    fireEvent.click(screen.getByText('Add'))
    fireEvent.keyDown(search(), { key: 'a' })
    search()
  })

  it('saves each toggle at once and in order, each from the list the one before saved', async () => {
    saved.length = 0
    const manual = manualSave()
    render(<Harness save={manual.save} />)
    fireEvent.click(screen.getByText('Add'))
    fireEvent.click(box('Director'))
    fireEvent.click(box('Sam Rivera'))
    fireEvent.click(box('TeamStation'))
    // The boxes show what was asked for while the saves wait.
    assert.equal(box('Director').checked, true)
    assert.equal(box('Sam Rivera').checked, true)
    assert.equal(box('TeamStation').checked, false)
    await until(() => manual.calls.length === 1)
    assert.deepEqual(manual.calls, [[1, 3]])
    await manual.answer(0)
    await until(() => manual.calls.length === 2)
    assert.deepEqual(manual.calls[1], [1, 3, 4])
    await manual.answer(1)
    await until(() => manual.calls.length === 3)
    assert.deepEqual(manual.calls[2], [3, 4])
    await manual.answer(2)
    await until(() => screen.getByTestId('saved').textContent === '3,4')
    assert.deepEqual(saved, [
      [3, true],
      [4, true],
      [1, false],
    ])
    assert.equal(box('TeamStation').checked, false)
  })

  it('keeps a refusal after Done until the picker opens again, or until that item’s own change succeeds', async () => {
    const manual = manualSave()
    render(<Harness save={manual.save} />)
    fireEvent.click(screen.getByText('Add'))
    fireEvent.click(box('Director'))
    await manual.answer(0, undefined, 'Unknown app')
    await until(() => screen.queryByRole('alert') != null)
    assert.equal(screen.getByRole('alert').textContent, 'Unknown app')
    // The box goes back to what is saved.
    assert.equal(box('Director').checked, false)
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    screen.getByRole('alert')
    // Opening again forgets it.
    fireEvent.click(screen.getByText('Add'))
    assert.equal(screen.queryByRole('alert'), null)
    // Another item's success leaves a refusal standing; its own clears it.
    fireEvent.click(box('Director'))
    await manual.answer(1, undefined, 'Unknown app')
    await until(() => screen.queryByRole('alert') != null)
    fireEvent.click(box('Sam Rivera'))
    await manual.answer(2)
    await until(() => screen.getByTestId('saved').textContent === '1,4')
    screen.getByRole('alert')
    fireEvent.click(box('Director'))
    await manual.answer(3)
    await until(() => screen.queryByRole('alert') == null)
    assert.equal(screen.getByTestId('saved').textContent, '1,4,3')
  })

  it('shows the latest of two quick changes to one item until both are answered', async () => {
    const manual = manualSave()
    render(<Harness save={manual.save} />)
    fireEvent.click(screen.getByText('Add'))
    fireEvent.click(box('Director'))
    fireEvent.click(box('Director'))
    assert.equal(box('Director').checked, false)
    await manual.answer(0)
    assert.equal(box('Director').checked, false)
    await manual.answer(1)
    assert.deepEqual(manual.calls, [[1, 3], [1]])
    await until(() => screen.getByTestId('saved').textContent === '1')
  })

  it('takes a new saved list from the page while nothing is on its way', async () => {
    const manual = manualSave()
    const view = render(<Harness save={manual.save} initial={[1]} />)
    view.rerender(<Harness save={manual.save} initial={[1, 5]} />)
    await until(() => screen.getByTestId('saved').textContent === '1,5')
    assert.deepEqual(state?.saved, [1, 5])
    assert.equal(state?.checked(5), true)
    act(() => state?.close())
  })
})
