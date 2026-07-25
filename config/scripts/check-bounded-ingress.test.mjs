import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { findViolations, violationKey, PATTERNS } from './check-bounded-ingress.mjs'

describe('check-bounded-ingress', () => {
  it('flags an unbounded file read and JSON parse', () => {
    const found = findViolations(
      'src/main/thing.ts',
      ['const buf = await readFile(p)', 'return JSON.parse(buf.toString())'].join('\n')
    )
    expect(found.map((v) => v.id)).toEqual(['read-file', 'json-parse'])
    expect(found[0].line).toBe(1)
  })

  it('honors a bounded-by justification on the line and the line above', () => {
    const sameLine = findViolations(
      'src/main/thing.ts',
      'const buf = await readFile(p) // bounded-by: fixture path under 1KB'
    )
    const lineAbove = findViolations(
      'src/main/thing.ts',
      ['// bounded-by: size checked by the caller', 'const buf = await readFile(p)'].join('\n')
    )
    expect(sameLine).toEqual([])
    expect(lineAbove).toEqual([])
  })

  it('flags unbounded response bodies and fan-out', () => {
    const found = findViolations(
      'src/main/thing.ts',
      ['const body = await response.text()', 'await Promise.all(items.map((i) => load(i)))'].join(
        '\n'
      )
    )
    expect(found.map((v) => v.id)).toEqual(['response-text', 'unbounded-fanout'])
  })

  it('keys violations by file and rule so a baseline survives line moves', () => {
    expect(violationKey({ file: 'src/a.ts', id: 'read-file', line: 12 })).toBe('src/a.ts:read-file')
    expect(violationKey({ file: 'src/a.ts', id: 'read-file', line: 99 })).toBe('src/a.ts:read-file')
  })

  it('ignores lines with no ingress pattern', () => {
    expect(findViolations('src/main/thing.ts', 'const total = a + b')).toEqual([])
  })

  it('catches fan-out that the formatter wrapped onto the next line', () => {
    const wrapped = findViolations(
      'src/main/thing.ts',
      ['await Promise.all(', '  items.map((i) => load(i))', ')'].join('\n')
    )
    expect(wrapped.map((v) => v.id)).toContain('unbounded-fanout')
    for (const variant of ['Promise.allSettled', 'Promise.any']) {
      expect(
        findViolations(
          'src/main/thing.ts',
          `await ${variant}(\n  items.map((i) => load(i))\n)`
        ).map((v) => v.id)
      ).toContain('unbounded-fanout')
    }
  })

  it('rejects an empty or non-comment bounded-by escape', () => {
    // An escape that costs nothing gets pattern-matched into place without thought.
    expect(
      findViolations('src/main/thing.ts', 'const buf = await readFile(p) // bounded-by:')
    ).toHaveLength(1)
    expect(
      findViolations('src/main/thing.ts', 'const label = "bounded-by: lol"; readFile(p)')
    ).toHaveLength(1)
    expect(
      findViolations(
        'src/main/thing.ts',
        'const buf = await readFile(p) // bounded-by: stat-checked'
      )
    ).toEqual([])
  })

  it('keeps the CLI boot-check wired into the desktop and release builds', () => {
    // Electron output once clobbered a CLI dependency emitted under out/main; the boot-check is the
    // guard, and CI calls `pnpm verify:cli-runtime` directly, so a dropped script fails the job.
    const root = path.resolve(import.meta.dirname, '../..')
    const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
    expect(pkg.scripts['verify:cli-runtime']).toBeDefined()
    expect(pkg.scripts['build:desktop']).toContain('verify:cli-runtime')
    expect(pkg.scripts['build:release']).toContain('verify:cli-runtime')
  })

  it('stays wired into pnpm lint', () => {
    // A gate that can be unwired without any test failing WILL be unwired by a rebase — this one
    // already was once, and the ratchet cannot detect its own removal.
    const root = path.resolve(import.meta.dirname, '../..')
    const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
    expect(pkg.scripts['check:bounded-ingress']).toBe(
      'node config/scripts/check-bounded-ingress.mjs'
    )
    expect(pkg.scripts.lint).toContain('check:bounded-ingress')
  })

  it('every hint names a real export of the module it points at', () => {
    // The hint is the text an agent copies when blocked; a stale name is an immediate import error.
    const root = path.resolve(import.meta.dirname, '../..')
    for (const pattern of PATTERNS) {
      const match = /\b([a-zA-Z][\w]*)\s*\(memory-safety\/([\w-]+)\)/.exec(pattern.hint)
      if (!match) {
        continue
      }
      const [, fn, moduleName] = match
      const source = readFileSync(
        path.join(root, 'src/shared/memory-safety', `${moduleName}.ts`),
        'utf8'
      )
      expect(source, `${pattern.id} hint names ${fn}`).toMatch(
        new RegExp(`export (?:async )?function ${fn}\\b`)
      )
    }
  })
})
