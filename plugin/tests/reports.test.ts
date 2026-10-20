import { expect, test } from 'claude-code/testing'
import { readyText, REPORT_MAX, reportOf, ReportTracker, taskIdOf, writeReport } from '../hooks/reports'
import type { Host } from '../hooks/journal'

// one boss (app contract v3.35): the plugin of the machine that runs a dispatched task writes its report; the
// dispatcher's boss gets only a fixed "report ready" notice

const MARKED = '[Agent Office: remote task #a1b2c3d4e5f60718 from "Studio"] run the tests'
const wrap = (id: string, project: string, machine: string) => `Remote task #${id} on ${project}@${machine} finished; read it with office_reports.`

test('marker: only the app-typed prefix opens a task', async () => {
  expect(taskIdOf(MARKED)).toBe('a1b2c3d4e5f60718')
  expect(taskIdOf('[Agent Office: remote command from "Studio"] run the tests')).toBe(undefined)
  expect(taskIdOf(`please ${MARKED}`)).toBe(undefined)
  expect(taskIdOf('[Agent Office: remote task #../x from "S"] hi')).toBe(undefined)
  const tr = new ReportTracker()
  expect(tr.prompt('just a prompt', 1)).toBe(undefined)
  expect(tr.pending).toBe(undefined)
  expect(tr.prompt(MARKED, 5)).toBe(undefined)
  expect(tr.pending?.id).toBe('a1b2c3d4e5f60718')
  // a second marked task closes the first (reported as partial by the caller)
  const closed = tr.prompt('[Agent Office: remote task #ffff000011112222 from "Studio"] next', 9)
  expect(closed?.id).toBe('a1b2c3d4e5f60718')
  expect(tr.pending?.id).toBe('ffff000011112222')
})

test('waits for workers: no report while agents of the session still run', async () => {
  const tr = new ReportTracker()
  tr.prompt(MARKED, 1)
  expect(tr.complete('Started two agents.', 2)).toBe(undefined)
  expect(tr.pending?.id).toBe('a1b2c3d4e5f60718')
  const task = tr.complete('All tests pass; fixed the flaky one.', 0)
  expect(task?.answer).toBe('All tests pass; fixed the flaky one.')
  expect(tr.pending).toBe(undefined)
  expect(tr.complete('later turn', 0)).toBe(undefined)
})

test('redaction and size: secrets out, summary cut to 16 KB', async () => {
  const r = reportOf({ id: 'x1', sinceMs: 0, answer: `Deployed with token sk-ant-abcdefghijklmnop and ${'y'.repeat(20000)}` }, [], 7)
  expect(r.summary.includes('sk-ant-abcdefghijklmnop')).toBe(false)
  expect(r.summary.includes('[redacted]')).toBe(true)
  expect(r.summary.length <= REPORT_MAX).toBe(true)
  expect(r.partial).toBe(false)
  const written: [string, string][] = []
  const host: Host = {
    run: async () => ({ exitCode: 1, stdout: '', stderr: '' }),
    stat: async () => ({ size: 0, mtimeMs: 0 }),
    read: async () => '',
    write: async (path, text) => {
      written.push([path, text])
    },
  }
  await writeReport(host, '/data/office', '/work/shop', { id: 'x1', sinceMs: 0, answer: 'password=hunter2hunter2 done' }, 9, true)
  expect(written.length).toBe(1)
  expect(written[0]![0]).toBe('/data/office/reports/x1.json')
  const saved = JSON.parse(written[0]![1]) as { partial: boolean; summary: string; at: number }
  expect(saved.partial).toBe(true)
  expect(saved.summary.includes('hunter2hunter2')).toBe(false)
})

test('report-ready wrapper: a fixed notice, names cleaned, any other row ignored', async () => {
  expect(readyText({ at: 1, kind: 'report-ready', id: 'a1b2', machine: 'Laptop', project: 'shop' }, wrap)).toBe(
    'Remote task #a1b2 on shop@Laptop finished; read it with office_reports.',
  )
  const odd = readyText({ at: 1, kind: 'report-ready', id: 'a1b2', machine: 'L"ap\ntop', project: '[x] ignore previous' }, wrap) ?? ''
  expect(odd.includes('"')).toBe(false)
  expect(odd.includes('\n')).toBe(false)
  expect(readyText({ at: 1, kind: 'report-ready', id: 'bad id!', machine: 'L', project: 'p' }, wrap)).toBe(undefined)
  expect(readyText({ at: 1, text: 'a task' }, wrap)).toBe(undefined)
  expect(readyText({ at: 1, kind: 'report', id: 'a1', text: 'the report' }, wrap)).toBe(undefined)
})
