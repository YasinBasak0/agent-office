import { expect, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'
import { FINISH_REASON_MANAGER } from '../hooks/finish'
import {
  BRIEF_TEXT,
  REPEAT_DENY_TEXT,
  REPEAT_TEXT,
  VERIFY_REASON,
  briefLacksCheck,
  factsSeed,
  hashOf,
  isVerifyCommand,
  isWritingCommand,
  normalizeError,
  saysNoCheck,
} from '../hooks/harness'

// the harness gates (app contract v3.26): the verification gate before a stop, the same-error reminder and refusal,
// the brief check and the project's facts file

type Harness = Parameters<TestBody>[1]
type Engine = Parameters<TestBody>[0]

const VERIFY = { HOME: '/home/tester', AGENT_OFFICE_VERIFY: '1' }
const IN_APP = { HOME: '/home/tester', AGENT_OFFICE_APP: '1', AGENT_OFFICE_MANAGER: '1' }

// a session in /work/my-app; tool calls answer from `answer`; fs.read from `files`; fs.write is recorded
function setUp(on: Harness, env: Record<string, string>, answer: (e: Record<string, unknown>) => unknown = () => ({ result: 'ok' }), files: Record<string, string> = {}) {
  const writes: { path: string; text: string }[] = []
  on('env.get', (_$, e) => ({ value: env[e.name] }))
  on('session.id', () => ({ value: 'session-1' }))
  on('session.root', () => ({ value: '/work/my-app' }))
  on('session.cwd', () => ({ value: '/work/my-app' }))
  on('command.register', () => ({ value: undefined as never }))
  on('clock.every', () => ({ value: undefined as never }))
  on('fs.write', (_$, e) => {
    writes.push(e)
    return { value: undefined }
  })
  on('fs.read', (_$, e) => {
    const text = files[e.path]
    if (text === undefined) throw new Error(`ENOENT: ${e.path}`)
    return { value: text }
  })
  on('fs.list', () => ({ value: [] }))
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('session.start', (_$, e) => e)
  on('model.classify', () => ({ value: undefined }))
  on('classic.Stop', () => ({}))
  on('classic.SubagentStop', () => ({}) as never)
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('agent.spawn', () => ({ model: 'test-model', agentId: 'agent-1' }))
  on('tool.call', (_$, e) => answer(e as never) as never)
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'You are Claude Code.', scope: 'shared' as const }] }))
  return { writes }
}

const start = { cwd: '/work/my-app', surface: 'terminal', isInteractive: true } as const
const stop = ($: Engine, message: string) =>
  $.classic.Stop({ stop_hook_active: false, last_assistant_message: message, background_tasks: [], session_crons: [] } as never)
const subagentStop = ($: Engine, agentId: string, message: string) =>
  $.classic.SubagentStop({ stop_hook_active: false, agent_id: agentId, agent_type: 'general-purpose', last_assistant_message: message } as never)
const prompt = ($: Engine, text: string) => $.prompt.submit({ text, origin: { kind: 'composer' } } as never)
const edit = ($: Engine, agentId?: string) => $.tool.call({ tool: 'Edit', file_path: '/work/my-app/a.ts', old_string: 'a', new_string: 'b', ...(agentId ? { agentId } : {}) } as never)
const bash = ($: Engine, command: string, agentId?: string) => $.tool.call({ tool: 'Bash', command, ...(agentId ? { agentId } : {}) } as never)
const contextOf = (answer: unknown) => (answer as { context?: string[] }).context ?? []
const DONE = 'Renamed the helper in a.ts.'

test('checks and writes are told apart in shell commands', () => {
  for (const command of ['npm test', 'pnpm run build', 'yarn lint', 'cd app && npx tsc -p .', 'node --test tests/a.mjs', 'pytest -q', 'python -m pytest', 'cargo check', 'go vet ./...', 'make test', './gradlew test', 'dotnet build', 'npx -y eslint@9 .', 'CI=1 npm run test:unit'])
    expect([command, isVerifyCommand(command)]).toEqual([command, true])
  for (const command of ['ls', 'git status', 'npm install', 'cat package.json', 'grep -r test .', 'echo test'])
    expect([command, isVerifyCommand(command)]).toEqual([command, false])
  for (const command of ['echo x > a.txt', 'sed -i "" s/a/b/ f', 'mv a b', 'cat <<EOF >> notes.md', 'git apply p.diff', 'rm -rf dist'])
    expect([command, isWritingCommand(command)]).toEqual([command, true])
  for (const command of ['ls -la', 'npm test 2>&1 | tail', 'grep "a > b" f', 'cmd > /dev/null', 'git diff', 'test $a -gt 3'])
    expect([command, isWritingCommand(command)]).toEqual([command, false])
  expect(saysNoCheck('Docs-only change, so no test applies.')).toBe(true)
  expect(saysNoCheck('This repo has no test suite.')).toBe(true)
  expect(saysNoCheck('Renamed it everywhere.')).toBe(false)
})

test('a loop that changed files and ran no check is blocked once, then its stop stands', async ($, on) => {
  setUp(on, VERIFY)
  await $.session.start(start)
  await prompt($, 'rename the helper')
  await edit($)
  expect((await stop($, DONE)).block).toBe(VERIFY_REASON)
  expect((await stop($, DONE)).block).toBeUndefined()
})

test('a check after the last change, or a final message that says why none applies, lets the stop stand', async ($, on) => {
  setUp(on, VERIFY)
  await $.session.start(start)
  await prompt($, 'rename the helper')
  await edit($)
  await bash($, 'npm test')
  expect((await stop($, DONE)).block).toBeUndefined()
  // a new change after the check opens a new set; a reason for no check lets it go
  await bash($, "echo '# notes' >> README.md")
  expect((await stop($, 'Docs-only change: README, nothing to test.')).block).toBeUndefined()
})

test('no change, Savings off or a nested session: no block', async ($, on) => {
  setUp(on, { HOME: '/home/tester', CLAUDECODE: '1', AGENT_OFFICE_VERIFY: '1' })
  await $.session.start(start)
  await prompt($, 'rename the helper')
  await edit($)
  expect((await stop($, DONE)).block).toBeUndefined()
})

test('Savings off: no step budget, no gate', async ($, on) => {
  setUp(on, { HOME: '/home/tester' })
  await $.session.start(start)
  await prompt($, 'rename the helper')
  await edit($)
  expect((await stop($, DONE)).block).toBeUndefined()
})

test('Savings Normal (a step budget) turns the gate on; AGENT_OFFICE_VERIFY=0 turns it off', async ($, on) => {
  setUp(on, { HOME: '/home/tester', AGENT_OFFICE_STEP_BUDGET: '20' })
  await $.session.start(start)
  await prompt($, 'rename the helper')
  await $.tool.call({ tool: 'Write', file_path: '/work/my-app/b.ts', content: 'x' } as never)
  expect((await stop($, DONE)).block).toBe(VERIFY_REASON)
})

test('a subagent that changed files is blocked once at SubagentStop, never twice', async ($, on) => {
  setUp(on, VERIFY)
  await $.session.start(start)
  await prompt($, 'fix it')
  await edit($, 'agent-9')
  expect(((await subagentStop($, 'agent-9', 'Fixed.')) as { block?: string }).block).toBe(VERIFY_REASON)
  expect(((await subagentStop($, 'agent-9', 'Fixed.')) as { block?: string }).block).toBeUndefined()
  // its own check clears another agent's gate? no: each loop has its own
  await edit($, 'agent-10')
  await bash($, 'cargo test', 'agent-10')
  expect(((await subagentStop($, 'agent-10', 'Fixed.')) as { block?: string }).block).toBeUndefined()
})

test('with the finish guard on, one stop gets one block: the gate first, the list guard at the next stop', async ($, on) => {
  setUp(on, { ...VERIFY, AGENT_OFFICE_MANAGER: '1', AGENT_OFFICE_FINISH_JUDGE: '0' })
  await $.session.start(start)
  await prompt($, 'add a sum function')
  await edit($)
  const list = 'Added `sum()`.\n\n## Next steps\n- add docs\n- wire it into the CLI'
  expect((await stop($, list)).block).toBe(VERIFY_REASON)
  expect((await stop($, list)).block).toBe(FINISH_REASON_MANAGER)
})

test('errors are normalized: paths, numbers, times and hex do not tell two runs apart', () => {
  const a = normalizeError('Error: ENOENT: no such file /tmp/run-1234/out.json\n    at 12:01:02 (0xdeadbeef)\nExit code 1')
  const b = normalizeError('Error: ENOENT: no such file /var/run-9/out.json\n    at 09:11:42 (0xabc123)\nExit code 2')
  expect(a).toBe(b)
  expect(hashOf(a)).toBe(hashOf(b))
  expect(normalizeError('TypeError: x is not a function')).not.toBe(a)
})

test('the same error twice gets one reminder; in Strict, the identical call is refused after the third', async ($, on) => {
  let run = 0
  setUp(on, { HOME: '/home/tester', AGENT_OFFICE_STEP_BUDGET: '50', AGENT_OFFICE_STEP_CAP: '1' }, e =>
    e.tool === 'Bash' ? { isError: true, result: 'x', text: `Exit code 1\nError: cannot find module /work/my-app/dist/run-${++run}.js` } : { result: 'ok' },
  )
  await $.session.start(start)
  await prompt($, 'run it')
  expect(contextOf(await bash($, 'node dist/main.js'))).toEqual([])
  expect(contextOf(await bash($, 'node dist/main.js'))).toEqual([REPEAT_TEXT])
  expect(contextOf(await bash($, 'node dist/main.js'))).toEqual([])
  expect((await bash($, 'node dist/main.js')) as unknown).toEqual({ deny: REPEAT_DENY_TEXT })
  // a different call still runs
  expect(contextOf(await bash($, 'node dist/other.js'))).toEqual([])
})

test('outside Strict the identical call keeps running after the reminder', async ($, on) => {
  setUp(on, { HOME: '/home/tester' }, () => ({ isError: true, result: 'x', text: 'Error: port 3000 in use' }))
  await $.session.start(start)
  await prompt($, 'serve it')
  const answers = [await bash($, 'npm start'), await bash($, 'npm start'), await bash($, 'npm start'), await bash($, 'npm start')]
  expect(answers.map(a => contextOf(a).length)).toEqual([0, 1, 0, 0])
  expect(answers.every(a => (a as { deny?: string }).deny === undefined)).toBe(true)
})

test('a manager brief with no acceptance check gets a note once per prompt; one with a check none', async ($, on) => {
  setUp(on, IN_APP)
  await $.session.start(start)
  await prompt($, 'fix the bug')
  expect(contextOf(await $.tool.call({ tool: 'Agent', description: 'fix', prompt: 'Look into the login bug and fix it.' } as never))).toContain(BRIEF_TEXT)
  expect(contextOf(await $.tool.call({ tool: 'Agent', description: 'fix', prompt: 'Fix the other bug.' } as never))).not.toContain(BRIEF_TEXT)
  expect(briefLacksCheck('Fix X. Non-goals: the UI. Acceptance check: `npm test` passes.')).toBe(false)
  expect(briefLacksCheck('Fix X in src/a.ts.')).toBe(true)
})

test('the facts file is seeded once in the office data dir, never in the repo, and only its path reaches the boss', async ($, on) => {
  const pkg = JSON.stringify({ scripts: { test: 'node --test', build: 'tsc -p .', deploy: 'TOKEN=$NPM_TOKEN npm publish' } })
  const { writes } = setUp(on, IN_APP, undefined, { '/work/my-app/package.json': pkg, '/work/my-app/Makefile': 'lint:\n\teslint .\n' })
  await $.session.start(start)
  const facts = writes.filter(w => w.path.includes('/facts/'))
  expect(facts.map(w => w.path)).toEqual(['/home/tester/.claude/agent-office/facts/my-app.md'])
  expect(writes.some(w => w.path.startsWith('/work/my-app'))).toBe(false)
  const text = facts[0]!.text
  expect(text).toContain('`npm run test`: node --test')
  expect(text).toContain('make targets: lint')
  expect(text).not.toContain('TOKEN')
  expect(text.split('\n').length).toBeLessThanOrEqual(40)
  const { sections } = await $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: ['terminal'], outputStyle: null, tools: ['Agent', 'Bash'], traits: [] } as never)
  const section = sections.find(s => s.id === 'agent-office:facts')
  expect(section?.text).toContain('/home/tester/.claude/agent-office/facts/my-app.md')
  expect(section?.text.split('\n').length).toBe(1)
})

test('a seeded facts file stays as the boss left it', async ($, on) => {
  const { writes } = setUp(on, IN_APP, undefined, { '/home/tester/.claude/agent-office/facts/my-app.md': '# my-app: facts\n- 2026-10-01: use pnpm\n' })
  await $.session.start(start)
  expect(writes.some(w => w.path.includes('/facts/'))).toBe(false)
})

test('a seed with no signals is just the headings; one with many stays under 40 lines', () => {
  expect(factsSeed('p', '2026-10-19', {})).toContain('## Commands')
  const scripts = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`s${i}`, 'echo hi']))
  expect(factsSeed('p', '2026-10-19', { packageJson: JSON.stringify({ scripts }), cargo: '[workspace]', pyproject: '[tool.ruff]\npytest' }).split('\n').length).toBeLessThanOrEqual(41)
})
