// The office journal's git and file side against real git (plain Node 23.6+, which loads .ts by stripping types):
// node --test plugin/tests/journal-git.mjs
// `claude plugin test` runs the hooks without processes or files, so the commit detection, the worktree mapping
// and the append are checked here on a temp repository.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

const journal = await import('../hooks/journal.ts').catch(() => undefined)
const skip = journal ? false : 'this Node cannot load TypeScript (needs 23.6+)'

const temps = []
after(() => temps.forEach(dir => rmSync(dir, { recursive: true, force: true })))
const tempDir = () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'agent-office-journal-')))
  temps.push(dir)
  return dir
}
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } })

// the Host register.tsx builds from `$`, here from Node
const host = {
  run: async (argv, init = {}) => {
    try {
      const stdout = execFileSync(argv[0], argv.slice(1), { encoding: 'utf8', input: init.stdin ?? '', stdio: ['pipe', 'pipe', 'pipe'] })
      return { exitCode: 0, stdout, stderr: '' }
    } catch (error) {
      return { exitCode: error.status ?? 1, stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? '') }
    }
  },
  stat: async (path, options) => {
    const s = statSync(path)
    return { size: s.size, mtimeMs: s.mtimeMs, ...(options?.resolve ? { realPath: realpathSync(path) } : {}) }
  },
  read: path => readFile(path, 'utf8'),
  write: (path, text) => writeFile(path, text),
}

function repo() {
  const root = tempDir()
  const main = join(root, 'shop')
  execFileSync('git', ['init', '-q', '-b', 'main', main])
  writeFileSync(join(main, 'a.txt'), 'a')
  git(main, 'add', '.')
  git(main, 'commit', '-qm', 'Old commit')
  // git dates have whole seconds: the turn begins in a later one than the old commit
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1100)
  return { root, main }
}

const turn = (over) => ({
  session: 's1',
  turnId: 't1',
  project: { name: 'my-app', dir: '/nowhere/my-app' },
  prompt: 'commit it',
  answer: 'Committed.',
  touched: [],
  sinceMs: Date.now(),
  acts: { edits: 0, commands: 1, agents: 0 },
  projects: [],
  ...over,
})

test('new commits since the turn began are found with their branch; older ones are not', { skip }, async () => {
  const { main } = repo()
  const since = Date.now()
  writeFileSync(join(main, 'b.txt'), 'b')
  git(main, 'add', '.')
  git(main, 'commit', '-qm', 'Add on-prem MCP (token=abcd1234efgh)')
  const entry = await journal.entryOf(host, turn({ touched: [join(main, 'src-not-there'), main], sinceMs: since, projects: [{ name: 'shop', dir: main }] }), Date.now())
  assert.equal(entry.repos.length, 1)
  assert.equal(entry.repos[0].name, 'shop')
  assert.equal(entry.repos[0].branch, 'main')
  assert.equal(entry.repos[0].dir, main)
  assert.deepEqual(entry.repos[0].commits.map(c => c.subject), ['Add on-prem MCP (token=[redacted])'])
  assert.match(entry.repos[0].commits[0].hash, /^[0-9a-f]{7,}$/)
  assert.ok(entry.dirs.includes(main))
})

test('a worktree maps to its main working copy, for the entry and for the reader', { skip }, async () => {
  const { root, main } = repo()
  const wt = join(root, 'shop-wt-1')
  git(main, 'worktree', 'add', '-q', '-b', 'agent-office/1', wt)
  const since = Date.now()
  writeFileSync(join(wt, 'c.txt'), 'c')
  git(wt, 'add', '.')
  git(wt, 'commit', '-qm', 'Worktree change')
  const entry = await journal.entryOf(host, turn({ touched: [wt], sinceMs: since }), Date.now())
  assert.deepEqual(entry.repos.map(r => [r.dir, r.worktree, r.branch, r.commits[0].subject]), [[main, wt, 'agent-office/1', 'Worktree change']])
  assert.ok(entry.dirs.includes(main))
  // a session whose project is the worktree reads it as the main working copy too
  const base = (await journal.placeOfDir(host, wt)).path
  assert.equal(base, main)
  assert.equal(journal.concerns(entry, { name: 'zz', base }), true)
  // a folder below the repository keeps its path below the main working copy
  assert.equal((await journal.placeOfDir(host, join(main, '.'))).path, main)
})

test('a folder outside git is kept by its real path; a turn that ran nothing asks git nothing', { skip }, async () => {
  const plain = tempDir()
  const entry = await journal.entryOf(host, turn({ touched: [plain], acts: { edits: 1, commands: 0, agents: 0 } }), Date.now())
  assert.ok(entry.dirs.includes(plain))
  assert.equal(entry.repos, undefined)
  assert.equal(await journal.entryOf(host, turn({ acts: { edits: 0, commands: 0, agents: 0 }, answer: 'ok' }), Date.now()), undefined)
})

test('entries are appended one line each and the file is rotated past its cap', { skip }, async () => {
  const data = tempDir()
  const one = { v: 1, id: 'a', at: 1, session: 's', project: { name: 'p', dir: '/p' }, dirs: [] }
  await Promise.all(Array.from({ length: 20 }, (_, i) => journal.appendEntry(host, data, { ...one, id: `a${i}` })))
  const lines = readFileSync(join(data, journal.JOURNAL_FILE), 'utf8').trim().split('\n')
  assert.equal(lines.length, 20)
  assert.equal(journal.parseJournal(lines.join('\n')).length, 20)
  // past the cap: the full file becomes journal.1.jsonl and a new one starts
  writeFileSync(join(data, journal.JOURNAL_FILE), 'x'.repeat(journal.JOURNAL_MAX_BYTES))
  await journal.appendEntry(host, data, { ...one, id: 'fresh' })
  assert.equal(statSync(join(data, journal.JOURNAL_OLD_FILE)).size, journal.JOURNAL_MAX_BYTES)
  assert.deepEqual(journal.parseJournal(readFileSync(join(data, journal.JOURNAL_FILE), 'utf8')).map(e => e.id), ['fresh'])
})
