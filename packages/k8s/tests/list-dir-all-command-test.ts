import { execFileSync, spawnSync } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { localCalculateOutputHashSorted } from '../src/k8s'
import { listDirAllCommand } from '../src/k8s/utils'

function perFileCommand(dir: string): string {
  const command = listDirAllCommand(dir)
  expect(command.endsWith(` -exec stat -c '%s %n' {} +`)).toBe(true)
  return `${command.slice(0, -1)}\\;`
}

function write(root: string, name: string, size = 0): void {
  const file = path.join(root, name)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, 'x'.repeat(size))
}

const specialNames = [
  'with space',
  'trailing space ',
  ' leading space',
  'tab\tname',
  'new\nline',
  'new\n\nlines\n',
  "single'quote",
  'double"quote',
  'back\\slash',
  'dollar$HOME',
  'glob*?[ab]',
  '-leading-dash',
  '--',
  '{}',
  '+',
  ';',
  '.hidden',
  'unicode-žšč-ü-日本-🙂',
  'semi;colon&amp|pipe',
  'percent%s%n'
]

const trees: Record<string, (root: string) => void> = {
  'many files': root => {
    for (let i = 0; i < 3000; i++) {
      write(root, `many/f${i}`, i % 97)
    }
  },
  'special characters in names': root => {
    for (const name of specialNames) {
      write(root, name, name.length)
      write(root, path.join(`dir ${name}`, name), 1)
    }
  },
  symlinks: root => {
    write(root, 'target/file', 7)
    fs.symlinkSync('target/file', path.join(root, 'link-to-file'))
    fs.symlinkSync('target', path.join(root, 'link-to-dir'))
    fs.symlinkSync('missing', path.join(root, 'dangling'))
    fs.symlinkSync('loop', path.join(root, 'loop'))
    fs.symlinkSync('new\nline target', path.join(root, 'link with\nnewline'))
  },
  'empty directories': root => {
    fs.mkdirSync(path.join(root, 'empty'))
    fs.mkdirSync(path.join(root, 'a/b/c/d/e'), { recursive: true })
    fs.mkdirSync(path.join(root, 'empty with space'))
    write(root, 'a/b/zero', 0)
  },
  'runner hook responses': root => {
    write(root, '_runner_hook_responses/response.json', 10)
    write(root, 'nested/_runner_hook_responses_x/response.json', 10)
    write(root, 'kept/file', 3)
  },
  'large tree': root => {
    for (let d = 0; d < 40; d++) {
      for (let f = 0; f < 250; f++) {
        write(root, `d${d}/s${d % 7}/f${f}`, (d * f) % 31)
      }
    }
  },
  'names longer than one batch': root => {
    for (let i = 0; i < 1500; i++) {
      write(root, `long/${String(i).padStart(4, '0')}-${'n'.repeat(200)}`, i)
    }
  }
}

describe('listDirAllCommand', () => {
  let root: string
  let bin: string
  let calls: string

  function run(command: string): string[] {
    fs.writeFileSync(calls, '')
    const result = spawnSync('sh', ['-c', command], {
      encoding: 'utf8',
      maxBuffer: 1 << 28,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        STAT_CALLS: calls
      }
    })
    expect(result.status).toBe(0)
    return result.stdout
      .split('\n')
      .filter(line => line.length > 0)
      .sort()
  }

  function statCalls(): number {
    return fs.readFileSync(calls, 'utf8').length
  }

  beforeEach(() => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'list-dir-all-'))
    root = path.join(base, 'work dir')
    bin = path.join(base, 'bin')
    calls = path.join(base, 'calls')
    fs.mkdirSync(root)
    fs.mkdirSync(bin)
    const stat = execFileSync('sh', ['-c', 'command -v stat'], {
      encoding: 'utf8'
    }).trim()
    fs.writeFileSync(
      path.join(bin, 'stat'),
      `#!/bin/sh\nprintf x >> "$STAT_CALLS"\nexec ${stat} "$@"\n`,
      { mode: 0o755 }
    )
  })

  afterEach(() => {
    fs.rmSync(path.dirname(root), { recursive: true, force: true })
  })

  it.each(Object.keys(trees))(
    'gives the same parsed listing with batched stat calls: %s',
    async name => {
      trees[name](root)

      const perFile = run(perFileCommand(root))
      const perFileCalls = statCalls()
      const batched = run(listDirAllCommand(root))
      const batchedCalls = statCalls()

      expect(batched).toEqual(perFile)
      expect(batched.length).toBeGreaterThan(0)
      expect(batched.join('\n')).not.toContain('_runner_hook_responses')
      expect(perFileCalls).toBeGreaterThan(0)
      expect(batchedCalls).toBeGreaterThan(0)
      expect(batchedCalls).toBeLessThanOrEqual(Math.ceil(perFileCalls / 50))

      const want = await localCalculateOutputHashSorted([
        'sh',
        '-c',
        perFileCommand(root)
      ])
      const got = await localCalculateOutputHashSorted([
        'sh',
        '-c',
        listDirAllCommand(root)
      ])
      expect(got).toEqual(want)
    }
  )
})
