export type Worker = {
  id: string
  type: string
  description: string
  spawnAt: number
  doneAt?: number
  isOk?: boolean
  tool?: string
  // agent details (contract v2.2), all optional: files without them keep working
  prompt?: string // the task given to the agent, whitespace collapsed, ≤ 600 chars
  detail?: string // the current tool's input in one line, ≤ 160 chars
  history?: ToolCall[] // the last 20 tool calls, oldest first
  toolCount?: number // all tool calls so far
  // step budget (app contract v3.20): wrap-up reminders it got, and tool calls refused past the hard cap
  nudges?: number
  denied?: number
  result?: string // the agent's final answer, ≤ 4000 chars (600 before v2.6), once done
  // work across projects (app contract v3.5): the folder it last worked in, absolute (its last file's folder, a
  // Glob/Grep path, a leading `cd`, its spawn cwd); left out = the session's own folder
  dir?: string
}

export type ToolCall = { at: number; tool: string; detail: string }

// a background shell command (contract v2.3): Bash with run_in_background (or moved to the background
// by Ctrl+B or its timeout) and Monitor's command; the server room draws one rack slot each
export type Shell = {
  id: string // the engine's background task id (Bash backgroundTaskId, Monitor taskId), else the tool_use_id
  command: string // one line, ≤ 160 chars (same rule as Worker.detail)
  description?: string // the tool call's description, if any
  agentId?: string // set when a subagent started it
  startAt: number
  endAt?: number // when it finished (or was killed); omitted while running
  exitCode?: number
  status?: 'running' | 'completed' | 'failed' | 'killed'
}

// today: ids delivered on that local day; outlives FORGET so the viewer's TODAY count never misses one
// waiting (contract v2.6): a permission dialog is open for `tool`, since `since`; gone once it is answered
export type Waiting = { kind: 'permission'; tool: string; since: number }
// one delivery of the day (contract v2.9): what the end-of-day summary lists
export type Delivery = { id: string; type: string; description: string; spawnAt: number; doneAt: number; isOk: boolean; toolCount: number; nudges?: number; denied?: number }
// bossDir (app contract v3.5): the folder the main loop works in this turn, same rules as Worker.dir; left out = the session's own
export type OfficeStats = { delivered: number; isBossBusy: boolean; today?: { date: string; ids: string[]; log?: Delivery[] }; waiting?: Waiting; bossDir?: string }

// the last frame the viewer wrote: its number and the theme's colours (hex without #)
export type OfficeFrame = { gen: number; accent: string; frameColor: string; title: string }

declare module 'claude-code' {
  interface PluginState {
    'agent-office': {
      workers: Worker[]
      shells: Shell[]
      stats: OfficeStats
      inboxSeen: number
      isOpen: boolean
      frame: OfficeFrame
      // the office journal (app contract v3.12): read up to `cursor`, the ids seen around it
      journal: { cursor: number; seen: string[] }
    }
  }
}
