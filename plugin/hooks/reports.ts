// "One boss" (app contract v3.35), the side of the machine that runs a dispatched task: the app types the task as
// `[Agent Office: remote task #<id> from "<machine>"] <text>`; this module notes the id at prompt.submit and, on a
// main turn.complete with no worker of this session still running, writes <data dir>/reports/<id>.json (the answer,
// redacted and cut to 16 KB, and the commits made since the task arrived). The app sends it to the dispatcher and
// deletes the file. A new marked task closes a still open one as partial. On the dispatcher's side the boss gets only
// a fixed "report ready" row (readyText); the report itself is read through the office_reports tool.
import { clip, commitsSince, placeOfDir, redact } from './journal'
import type { Host, JournalCommit } from './journal'

export const REPORT_MAX = 16 * 1024
export const REPORTS_DIR = 'reports'
const MARKER = /^\[Agent Office: remote task #([A-Za-z0-9_.:-]{1,64}) from "[^"\n]{0,64}"\] /

export type PendingTask = { id: string; sinceMs: number; answer: string }
export type TaskReport = { ok: boolean; partial: boolean; summary: string; commits: JournalCommit[]; at: number }

/** The task id of a prompt the app typed for a dispatched task, or undefined. */
export function taskIdOf(text: string): string | undefined {
  return MARKER.exec(typeof text === 'string' ? text : '')?.[1]
}

/** The open task of this session: one at a time; it reports once the main turn ends with no worker running. */
export class ReportTracker {
  pending: PendingTask | undefined = undefined

  /** A prompt arrived: a marked one opens a task. → the previous task when it was still open (close it as partial). */
  prompt(text: string, now: number): PendingTask | undefined {
    const id = taskIdOf(text)
    if (!id) return undefined
    const before = this.pending
    this.pending = { id, sinceMs: now, answer: '' }
    return before
  }

  /** The main turn ended with `running` workers of this session still at work. → the task to report now, if any. */
  complete(answer: string, running: number): PendingTask | undefined {
    const task = this.pending
    if (!task) return undefined
    if (answer.trim()) task.answer = answer
    if (running > 0) return undefined // its agents are still working: the turn after their notifications reports
    this.pending = undefined
    return task
  }
}

/** The report of a task: the answer redacted and cut, the commits, the time. */
export function reportOf(task: PendingTask, commits: JournalCommit[], now: number, partial = false): TaskReport {
  const summary = clip(redact(task.answer.trim()), REPORT_MAX) || '(the session gave no answer)'
  return { ok: true, partial, summary, commits: commits.slice(0, 12), at: now }
}

/** Writes <root>/reports/<id>.json for the app (never throws). */
export async function writeReport(host: Host, root: string, cwd: string, task: PendingTask, now: number, partial = false, isWindows = false) {
  try {
    const place = cwd ? await placeOfDir(host, cwd) : { path: '' }
    const commits = 'top' in place && place.top ? (await commitsSince(host, place.top, task.sinceMs)).commits : []
    const dir = `${root}/${REPORTS_DIR}`
    await host.run(isWindows ? ['cmd.exe', '/d', '/c', 'if not exist "' + dir.replace(/\//g, '\\') + '" mkdir "' + dir.replace(/\//g, '\\') + '"'] : ['/bin/mkdir', '-p', '--', dir]).catch(() => undefined)
    await host.write(`${dir}/${task.id}.json`, JSON.stringify(reportOf(task, commits, now, partial)))
  } catch {
    // best effort: the dispatcher then sees the task as delivered without a report
  }
}

const cleanName = (value: unknown, max = 64) =>
  typeof value === 'string' ? clip(value.replace(/[\u0000-\u001f\u007f"`[\]]/g, ' ').replace(/\s+/g, ' ').trim(), max) : ''

/**
 * The prompt for an inbox row of kind 'report-ready' (the app writes { at, kind, id, machine, project }, never report
 * text): a fixed notice, not a task. undefined for any other row.
 */
export function readyText(row: unknown, wrap: (id: string, project: string, machine: string) => string): string | undefined {
  if (row === null || typeof row !== 'object') return undefined
  const r = row as Record<string, unknown>
  if (r.kind !== 'report-ready' || typeof r.id !== 'string' || !/^[A-Za-z0-9_.:-]{1,64}$/.test(r.id)) return undefined
  return wrap(r.id, cleanName(r.project) || '?', cleanName(r.machine) || '?')
}
