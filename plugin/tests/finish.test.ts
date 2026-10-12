import { expect, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'
import { FINISH_REASON_MANAGER, FINISH_REASON_SOLO, JUDGE_LABELS, heuristicBlocks } from '../hooks/finish'

// the finish guard (app contract v3.10): classic.Stop blocks a main-loop stop whose final message lists work
// the loop could still do, in manager mode and with AGENT_OFFICE_FINISH=1

type Harness = Parameters<TestBody>[1]
type Engine = Parameters<TestBody>[0]

const MANAGER = { HOME: '/home/tester', AGENT_OFFICE_APP: '1', AGENT_OFFICE_MANAGER: '1' }
const LIST = 'Added `sum()` with tests.\n\n## Next steps\n- add docs\n- wire it into the CLI'
const APPROVAL = 'Everything is built and tested. Shall I deploy it to production?'
const DONE = 'Added `sum()` with tests; all of them pass.'

// a session in /work/my-app; the judge ($.model.classify) answers with `label` (a function: per call), or fails;
// the Stop hooks beneath answer `beneath`
function setUp(
  on: Harness,
  env: Record<string, string>,
  label: (() => string | undefined) | 'fails' = () => JUDGE_LABELS[0],
  beneath: { block?: string } = {},
) {
  const judged: string[] = []
  on('env.get', (_$, e) => ({ value: env[e.name] }))
  on('session.id', () => ({ value: 'session-1' }))
  on('session.root', () => ({ value: '/work/my-app' }))
  on('session.cwd', () => ({ value: '/work/my-app' }))
  on('command.register', () => ({ value: undefined as never }))
  on('clock.every', () => ({ value: undefined as never }))
  on('fs.write', () => ({ value: undefined }))
  on('fs.read', (_$, e) => {
    throw new Error(`ENOENT: ${e.path}`)
  })
  on('fs.list', () => ({ value: [] }))
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('session.start', (_$, e) => e)
  on('model.classify', (_$, e) => {
    judged.push(e.text)
    if (label === 'fails') throw new Error('overloaded')
    return { value: label() }
  })
  on('classic.Stop', () => beneath)
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  return { judged }
}

const start = { cwd: '/work/my-app', surface: 'terminal', isInteractive: true } as const
const stop = ($: Engine, message: string, more: Record<string, unknown> = {}) =>
  $.classic.Stop({ stop_hook_active: false, last_assistant_message: message, background_tasks: [], session_crons: [], ...more } as never)
const prompt = ($: Engine, text: string, kind = 'composer') => $.prompt.submit({ text, origin: { kind } } as never)

test('manager mode: a final message with next steps blocks the stop and says to do them through agents', async ($, on) => {
  const { judged } = setUp(on, MANAGER)
  await $.session.start(start)
  await prompt($, 'add a sum function')
  const answer = await stop($, LIST)
  expect(answer.block).toBe(FINISH_REASON_MANAGER)
  expect(answer.block).toContain('delegate the independent parts to sub-agents in parallel')
  expect(judged).toEqual([LIST])
})

test('a message with no work cue stops without asking the judge', async ($, on) => {
  const { judged } = setUp(on, MANAGER)
  await $.session.start(start)
  for (const message of [DONE, 'Which header colour do you prefer, blue or green?', '', 'Hepsi tamamlandı, kalan iş yok.'])
    expect((await stop($, message)).block).toBeUndefined()
  expect(judged).toEqual([])
})

test("the judge's label decides a message with a cue", async ($, on) => {
  const labels = [JUDGE_LABELS[1], JUDGE_LABELS[2], JUDGE_LABELS[0]]
  setUp(on, MANAGER, () => labels.shift())
  await $.session.start(start)
  expect((await stop($, LIST)).block).toBeUndefined()
  expect((await stop($, LIST)).block).toBeUndefined()
  expect((await stop($, 'Done. Want me to also add input validation?')).block).toBe(FINISH_REASON_MANAGER)
})

for (const [name, label] of [
  ['fails', 'fails'],
  ['names no label', () => 'maybe'],
] as const) {
  test(`when the judge ${name} the heuristic decides: a list blocks, an approval request stops`, async ($, on) => {
    setUp(on, MANAGER, label === 'fails' ? 'fails' : () => undefined)
    await $.session.start(start)
    expect((await stop($, APPROVAL)).block).toBeUndefined()
    expect((await stop($, 'Kod hazır. Canlıya almak için onay verir misin? Kalanlar: yok değil, README.')).block).toBeUndefined()
    expect((await stop($, LIST)).block).toBe(FINISH_REASON_MANAGER)
  })
}

test('a soft cue only goes to the judge: its label blocks; with no label the stop stands', async ($, on) => {
  const SOFT = "It only handles ASCII. If your blog has Turkish titles, that's the first thing to add next."
  const labels: (string | undefined)[] = [JUDGE_LABELS[0], undefined]
  const { judged } = setUp(on, MANAGER, () => labels.shift())
  await $.session.start(start)
  expect(heuristicBlocks(SOFT)).toBe(false)
  expect((await stop($, SOFT)).block).toBe(FINISH_REASON_MANAGER)
  expect((await stop($, SOFT)).block).toBeUndefined()
  expect(judged).toEqual([SOFT, SOFT])
})

test('AGENT_OFFICE_FINISH_JUDGE=0: no model call, the heuristic alone', async ($, on) => {
  const { judged } = setUp(on, { ...MANAGER, AGENT_OFFICE_FINISH_JUDGE: '0' })
  await $.session.start(start)
  expect((await stop($, 'Bitti. Kalanlar:\n- README güncellemesi\n- testler')).block).toBe(FINISH_REASON_MANAGER)
  expect((await stop($, APPROVAL)).block).toBeUndefined()
  expect(judged).toEqual([])
})

test("at most two blocks per prompt of the person's; a task notification does not reset the count", async ($, on) => {
  setUp(on, MANAGER)
  await $.session.start(start)
  await prompt($, 'build it')
  expect((await stop($, LIST)).block).toBe(FINISH_REASON_MANAGER)
  expect((await stop($, LIST, { stop_hook_active: true })).block).toBe(FINISH_REASON_MANAGER)
  expect((await stop($, LIST, { stop_hook_active: true })).block).toBeUndefined()
  await prompt($, '<task-notification>done</task-notification>', 'task-notification')
  expect((await stop($, LIST)).block).toBeUndefined()
  // the person's next prompt: two more
  await prompt($, 'and the docs')
  expect((await stop($, LIST)).block).toBe(FINISH_REASON_MANAGER)
})

test('never while background work or a cron will wake the loop, for a subagent, or after an error or an interrupt', async ($, on) => {
  setUp(on, MANAGER)
  await $.session.start(start)
  const agent = { id: 'a1', type: 'subagent', status: 'running', description: 'write the docs' }
  expect((await stop($, LIST, { background_tasks: [agent] })).block).toBeUndefined()
  expect((await stop($, LIST, { session_crons: [{ id: 'c1' }] })).block).toBeUndefined()
  expect((await stop($, LIST, { agent_id: 'agent-1' })).block).toBeUndefined()
  // a finished background task no longer counts
  expect((await stop($, LIST, { background_tasks: [{ ...agent, status: 'completed' }] })).block).toBe(FINISH_REASON_MANAGER)
  for (const reason of ['error', 'aborted']) {
    await $.turn.start({ text: 'go', turnId: 'turn-1' })
    await $.turn.complete({ reason, answer: LIST, durationMs: 1, isAborted: reason === 'aborted', turnId: 'turn-1' } as never)
    expect((await stop($, LIST)).block).toBeUndefined()
  }
  // a turn that answered: the guard is back
  await $.turn.start({ text: 'go', turnId: 'turn-2' })
  await $.turn.complete({ reason: 'answer', answer: LIST, durationMs: 1, isAborted: false, turnId: 'turn-2' } as never)
  expect((await stop($, LIST)).block).toBe(FINISH_REASON_MANAGER)
})

test('a prompt that asks for the list itself is answered by the list; asking to finish what is left is not', async ($, on) => {
  setUp(on, MANAGER)
  await $.session.start(start)
  for (const asked of [
    'Add add(a, b) to math.js and end your reply with a list of follow-up improvements.',
    'Just a plan for the login page, do not implement it yet.',
    'Login sayfası için sonraki adımları listele.',
    'Bu modül için ne önerirsin?',
  ]) {
    await prompt($, asked)
    expect((await stop($, LIST)).block).toBeUndefined()
  }
  for (const asked of ['Kalan işleri de yap.', 'Finish what is left on the list.', 'Uygulamaya dark mode ekle.']) {
    await prompt($, asked)
    expect((await stop($, LIST)).block).toBe(FINISH_REASON_MANAGER)
  }
})

test('a block from the hooks beneath stands as it is', async ($, on) => {
  setUp(on, MANAGER, undefined, { block: 'run the linter first' })
  await $.session.start(start)
  expect((await stop($, LIST)).block).toBe('run the linter first')
})

test('manager mode off: no guard; AGENT_OFFICE_FINISH=1 ("does it itself") guards without the delegation wording', async ($, on) => {
  const env: Record<string, string> = { HOME: '/home/tester', AGENT_OFFICE_APP: '1' }
  const { judged } = setUp(on, env)
  await $.session.start(start)
  expect((await stop($, LIST)).block).toBeUndefined()
  env.AGENT_OFFICE_MANAGER = '0'
  expect((await stop($, LIST)).block).toBeUndefined()
  expect(judged).toEqual([])
  env.AGENT_OFFICE_FINISH = '1'
  const answer = await stop($, LIST)
  expect(answer.block).toBe(FINISH_REASON_SOLO)
  expect(answer.block).not.toContain('sub-agents')
})

// the heuristic alone (the judge's fallback), Turkish and English
const BLOCKS: string[] = [
  LIST,
  'Bitti. Kalanlar:\n- README güncellemesi\n- testler',
  'Bundan sonra şunlar yapılacak: lint düzeltmeleri, testler.',
  'Tamam, istersen dark mode da ekleyeyim?',
  'Want me to also add input validation?',
  'Deploy script added. Next steps:\n1. add tests\n2. add docs',
  'Tests pass; I could also add a benchmark if useful.',
  '**Sonraki adımlar**\n1. Hata mesajlarını Türkçeleştirmek\n2. E2E testleri',
  'Done for now. Remaining work: the settings page is not implemented yet.',
  'Login formu hazır. Şifre sıfırlama henüz yapılmadı, sonra yapılabilir.',
  "The module is done. If you want any of the follow-ups from the list, say which and I'll dispatch them.",
  'Hazır. Testleri de yazmamı söylersen eklerim.',
  'Kapsam: başka komut yok. İzin verirsen iki `add`, boş metin ve bozuk `todos.json` senaryolarını çalıştırıp sonucu bildiririm.',
  "With your permission, I'll run the full test suite next.",
  'Turkish letters are dropped. If your titles use them, I can add a character map in the next version.',
  'It only handles ASCII. If your blog has Turkish titles, the next step would be adding a transliteration map.',
]
const STOPS: string[] = [
  DONE,
  'Done; all tests pass. Nothing left to do.',
  'Hepsi tamamlandı, kalan iş yok.',
  APPROVAL,
  'Kod hazır ve testler geçti. Canlıya almak için onay verir misin?',
  'Which do you prefer for the header: blue or green?',
  'Header için hangisini istersin: A mı B mi?',
  'Added the function. I need your API token to test against the real service, please.',
  'Fixed the bug in `todo.js` and removed the `// TODO` comment.',
  'Next steps (for you): log in to Vercel and approve the deploy.',
  'Agents are working on it; I will integrate when they report.',
  'Değişiklik tamam. Bu ayar bundan sonra her açılışta uygulanır.',
  'Kaydı silmemi ister misin?',
  'Eski tabloları silmek geri alınamaz: sileyim mi?',
  'Done. To finish the release I need you to sign in to npm (`npm login`); everything else is done.',
  'Let me know if anything else comes up.',
  'Build passes. İzin verirsen canlıya alırım.',
  "Everything else is done; with your permission I'll publish 1.2.0 to npm.",
  'Here is the plan:\n```\n// TODO: next steps\n```\nAll implemented and verified.',
]

test('the heuristic: lists, next steps and offers block; finished reports and requests to the person stop', () => {
  expect(BLOCKS.filter(message => !heuristicBlocks(message))).toEqual([])
  expect(STOPS.filter(message => heuristicBlocks(message))).toEqual([])
})
