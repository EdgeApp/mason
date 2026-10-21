import { spawn } from 'node:child_process'
import type { Exec } from './archive.js'

/** Runs a tool for the Apple steps, streaming each output line and keeping the output. */
export const spawnExec: Exec = async (file, args, options) =>
  await new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    // Each stream keeps its own unfinished line, so the two never mix within a line.
    const pending = { stdout: '', stderr: '' }
    const take =
      (stream: keyof typeof pending) =>
      (chunk: Buffer): void => {
        const text = chunk.toString()
        output += text
        const lines = (pending[stream] + text).split('\n')
        pending[stream] = lines.pop() ?? ''
        for (const line of lines) options.onLine?.(line)
      }
    child.stdout.on('data', take('stdout'))
    child.stderr.on('data', take('stderr'))
    child.once('error', reject)
    child.once('close', (code) => {
      for (const rest of Object.values(pending))
        if (rest !== '') options.onLine?.(rest)
      resolve({ code: code ?? 1, output })
    })
  })
