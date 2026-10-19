// Agent Office for Command Code: a mod that tells the office what its `cmd` session is doing.
// Claude Code runs the TSX plugin (hooks/register.tsx) with its own event engine; Command Code's mod API
// (cmd.on / cmd.hooks / cmd.addCommand) exposes the same lifecycle as AgentEvents, so this file maps it to
// the office's session files: <AGENT_OFFICE_DATA_DIR || ~/.claude/agent-office>/sessions/<session id>.json,
// shape { format: 2, project, updatedAt, endedAt?, workers, shells, stats } (app CONTRACT v2.x/v3.5). The
// app reads both CLIs from that one folder, so a `cmd` session walks in like a `claude` one.
// Not carried over (Command Code has no such surface yet): the live viewer TUI (office.mjs), background
// shells, waiting-on-approval badges, read tasks (inbox), the office journal and nested-session detection.
const fs = require('fs');
const os = require('os');
const path = require('path');

// Limits mirror plugin/hooks/register.tsx; the app's panel clips the same fields by contract.
const RESULT_MAX = 4000;
const PROMPT_MAX = 600;
const DESCRIPTION_MAX = 200;
const LOG_MAX = 300;
const DETAIL_MAX = 160;
const HISTORY_MAX = 20;
const PUBLISH_MS = 500; // tool-call publishes coalesce to one write per interval (the state file churns otherwise)
const FORGET_MINUTES = { min: 1, max: 60, default: 5 };
const AGENT_TOOLS = ['Agent', 'Task'].map((s) => s.toLowerCase()); // the agents' spawning tools, name-insensitive

// Manager mode (AGENT_OFFICE_MANAGER=1, set by the app): the brief rides every request's system prompt, so it
// survives --continue/--resume and compaction. Must be byte-stable per run (the provider cache keys off it).
// The text is Claude Code plugin's own (plugin/hooks/register.tsx, v0.10.0's manager brief); keep the two in step.
const MANAGER_TEMPLATE = `# Manager mode (Agent Office)

You are the manager in Agent Office: a dispatcher who hands the work to agents and stays available to the person. Your agents are subagents you start with the Agent tool; they work in the background (set run_in_background if your Agent tool has it) while the person watches them at their desks, and you are told when each one finishes. The person can only talk to you between your turns, so keep your own turns short.

- Delegate when the input is large and the answer small (investigating or reading code, builds, tests, long commands, batches of MCP calls) or when pieces can run in parallel: start those agents in the same message (in separate git worktrees when they would touch the same files). Don't delegate a small edit whose brief would be as long as the change: do trivial edits, quick commands and lookups yourself.
- Brief each agent self-contained: goal, folder, what done looks like, how to check it. Put long context in a file and pass its path, never paste it. Tell every agent to write long findings to a file and report at most 15 lines plus the path.
- Otherwise your own tool use is quick orientation, reviewing reports, merging and the final check. Several steps into bigger work, hand the rest to an agent.
- One scoped task per agent. When an agent's job is done, start a fresh agent for the next task rather than sending the finished one more work: a continued agent re-reads its whole, ever-growing context on every request.
- {{MODEL}}
- While agents run, answer the person, take new requests and dispatch them. Don't redo an agent's work or wait on it in silence.
- A job for another project: work in that project's folder with absolute paths (in Bash, \`cd <folder> && …\`) and have your agents do the same, so Agent Office shows the work under that project.
- Keep going until the task list is done. Don't end a turn with a list of remaining work, things left for later or "next steps" that you or your agents could do now: do them, or dispatch them.
- Make technical choices yourself (libraries, structure, how to fix something) and give the reason in one line. Never end a turn with an offer ("want me to…?", "istersen…"): do it.
- Stop only for what genuinely needs the person: approving outward-facing or destructive actions (deploying to production, publishing, deleting data, spending money), credentials or logins, and decisions that are theirs to make. For those, finish everything else first, then ask in one short list.
- Report honestly what you verified and what you did not.

The person's own instructions (AGENTS.md, explicit requests) take precedence over this.`;
const MODEL_AUTO =
  'Pick each agent\'s model with the Agent tool\'s model parameter: "haiku" for searches and lookups, "sonnet" for mechanical edits, test and build runs and routine fixes; leave it out (your own model) for design, hard debugging and reviews.';
const modelPinned = (model) => `Every agent of this session runs on ${model} (the person's setting in Agent Office), so don't set the Agent tool's model parameter.`;

const clip = (text, max) => {
  const s = String(text ?? '');
  return s.length > max ? s.slice(0, max) : s;
};
const firstLine = (text, max = DESCRIPTION_MAX) =>
  clip(String(text ?? '').split('\n').map((l) => l.trim()).find(Boolean) || '', max);
/** The tool's own one-line detail for the worker panel: the input's most telling string field. */
const toolDetail = (input) => {
  if (input && typeof input === 'object') {
    for (const key of ['command', 'file_path', 'pattern', 'path', 'url', 'target', 'dir']) {
      if (typeof input[key] === 'string' && input[key]) return clip(input[key], DETAIL_MAX);
    }
    return firstLine(input.prompt || input.description, DETAIL_MAX);
  }
  return input ? clip(input, DETAIL_MAX) : '';
};
const todayOf = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const isAgentTool = (name) => AGENT_TOOLS.includes(String(name || '').toLowerCase());
const envOf = (name) => (typeof process.env[name] === 'string' ? process.env[name] : '');

/** Projects in this Agent Office (contract v3.9): the JSON the app wrote for this tab, as one prompt section. */
function projectsSection(json) {
  const data = JSON.parse(json);
  const lines = [
    '# Projects in this Agent Office',
    '',
    'Every project of this Agent Office (the app\'s sidebar); its name is its folder\'s name in this list.',
    '',
    '| Name | Folder |',
    '| --- | --- |',
  ];
  for (const p of data.projects || []) lines.push(`| ${p?.name} | ${p?.dir} |`);
  if (data.current) lines.push('', `You are working in: ${data.current}`);
  return lines.join('\n');
}

export default function (cmd) {
  let sessionId = '';
  let cwd = '';
  let stateFile = '';
  let forgetMs = FORGET_MINUTES.default * 60_000;
  let workers = new Map(); // agent tool's toolCallId → the office Worker while the session knows it
  let delivered = 0; // across the session's lifetime (days aggregated, ids live under stats.today)
  let today = null; // { date, ids, log } once something delivers
  let isBossBusy = false;
  let lastPublish = 0;
  let publishTimer = null;
  let systemSection = ''; // the manager brief (+ the projects section), byte-stable within a run

  const str = (v) => (typeof v === 'string' ? v : '');
  const now = () => Date.now();
  const readState = () => { try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { return null; } };

  function init(payload, ctx) {
    sessionId = str(payload?.sessionId) || sessionId;
    cwd = str(ctx?.cwd) || process.cwd();
    if (!sessionId || !cwd) return;
    const root = envOf('AGENT_OFFICE_DATA_DIR') || path.join(os.homedir(), '.claude', 'agent-office');
    stateFile = path.join(root, 'sessions', `${sessionId}.json`);
    try {
      const minutes = JSON.parse(fs.readFileSync(path.join(root, 'settings.json'), 'utf8')).forgetMinutes;
      forgetMs = Math.min(FORGET_MINUTES.max, Math.max(FORGET_MINUTES.min, Number(minutes) || FORGET_MINUTES.default)) * 60_000;
    } catch {}
    // a resume of the same session keeps its earlier workers and the day's deliveries
    const prior = readState();
    workers = new Map((prior?.workers || []).filter((w) => w && w.id).map((w) => [w.id, w]));
    delivered = prior?.stats?.delivered || 0;
    today = prior?.stats?.today && prior.stats.today.date === todayOf() ? prior.stats.today : null;
    isBossBusy = false;
    systemSection = ''; // the run's envs apply fresh; recomputed lazily on the first system prompt
    publish(); // run start: the boss walks in even before doing anything
  }

  function prune() {
    const told = now() - forgetMs;
    for (const [id, w] of workers) if (w.doneAt && w.doneAt < told) workers.delete(id);
  }
  function todayEntry() {
    const date = todayOf();
    if (!today || today.date !== date) today = { date, ids: [], log: [] };
    return today;
  }
  function publish(endedAt) {
    if (!stateFile) return;
    lastPublish = now();
    prune();
    const stats = { delivered, isBossBusy };
    if (today) stats.today = today;
    // the session's name is its folder's basename, like Claude Code's plugin does it (projects.js sessionAliases:
    // a worktree tab's `<repo>-wt-<n>` counts toward its project; the app filters offices by these names)
    const data = { format: 2, project: path.basename(cwd), updatedAt: lastPublish, workers: [...workers.values()], shells: [], stats };
    if (endedAt) data.endedAt = endedAt;
    try {
      fs.mkdirSync(path.dirname(stateFile), { recursive: true });
      fs.writeFileSync(stateFile, JSON.stringify(data));
    } catch {}
  }
  function publishSoon() {
    const wait = lastPublish + PUBLISH_MS - now();
    if (wait <= 0) return publish();
    if (publishTimer) return;
    publishTimer = setTimeout(() => { publishTimer = null; publish(); }, wait);
    if (typeof publishTimer.unref === 'function') publishTimer.unref();
  }

  // The agent tool's completion (subagent_stop's bracket close, or the call's terminal tool event) delivers:
  // the worker goes home with its result, the day's count and log grow by one.
  function deliver(id, isOk, result) {
    const w = workers.get(id);
    if (!w || w.doneAt) return false;
    w.doneAt = now();
    w.isOk = Boolean(isOk);
    if (result) w.result = clip(result, RESULT_MAX);
    const entry = todayEntry();
    if (!entry.ids.includes(w.id)) entry.ids.push(w.id);
    entry.log = [...entry.log, { id: w.id, type: w.type, description: w.description, spawnAt: w.spawnAt, doneAt: w.doneAt, isOk: w.isOk, toolCount: w.toolCount }].slice(-LOG_MAX);
    delivered += 1;
    return true;
  }
  const resultText = (e) => {
    const r = e?.result;
    if (typeof r === 'string') return r;
    if (r && typeof r === 'object') return firstLine(r.text || (Array.isArray(r.content) ? r.content[0]?.text : ''), RESULT_MAX);
    return '';
  };

  cmd.on('run_start', (e, ctx) => init(e, ctx));

  cmd.on('turn_start', () => {
    if (!stateFile) return;
    isBossBusy = true;
    publish();
  });

  // A queued tool call: agent tools become workers; other events only matter through subagent_progress.
  cmd.on('tool_queued', (e) => {
    if (!stateFile) return;
    const id = str(e?.toolCallId);
    if (!id || !isAgentTool(e?.toolName)) return;
    const input = e?.input ?? {};
    workers.set(id, {
      id,
      type: str(input?.subagent_type ?? input?.subagentType ?? input?.type) || 'agent',
      description: firstLine(input?.description || input?.prompt),
      spawnAt: now(),
      prompt: clip(input?.prompt, PROMPT_MAX),
      tool: '',
      detail: '',
      history: [],
      toolCount: 0,
    });
    isBossBusy = true;
    publishSoon();
  });

  // Progress from inside a running sub-agent: the tool it is on right now (the desk's item and history).
  cmd.on('subagent_progress', (e) => {
    const w = workers.get(str(e?.toolCallId));
    if (!w || w.doneAt) return;
    w.tool = str(e?.toolName);
    w.detail = toolDetail(e?.toolInput);
    w.history = [...w.history, { at: now(), tool: w.tool, detail: w.detail }].slice(-HISTORY_MAX);
    w.toolCount += 1;
    publishSoon();
  });

  // The nested run ended: its result reached the boss (the tool call's own shape may differ per version, so the
  // tool events below are the fallback either way).
  cmd.on('subagent_stop', (e) => {
    if (deliver(str(e?.toolCallId), true)) publish();
  });
  cmd.on('tool_completed', (e) => {
    if (deliver(str(e?.toolCallId), true, resultText(e))) publish();
  });
  cmd.on('tool_errored', (e) => {
    if (deliver(str(e?.toolCallId), false, str(e?.error))) publish();
  });

  cmd.on('run_end', () => {
    isBossBusy = false;
    publish(now());
  });
  cmd.on('interrupted', () => {
    isBossBusy = false;
    publish(now());
  });

  cmd.hooks({
    // The manager brief and the office directory, appended after the engine's own system prompt (byte-stable:
    // computed once per run, the section text never changes within it).
    appendSystemPrompt: () => {
      if (!stateFile) return undefined;
      if (!systemSection) {
        const sections = [];
        if (envOf('AGENT_OFFICE_APP') && envOf('AGENT_OFFICE_MANAGER') === '1') {
          sections.push(MANAGER_TEMPLATE.replace('{{MODEL}}', envOf('AGENT_OFFICE_AGENT_MODEL') ? modelPinned(envOf('AGENT_OFFICE_AGENT_MODEL')) : MODEL_AUTO));
        }
        if (envOf('AGENT_OFFICE_APP') && envOf('AGENT_OFFICE_DIRECTORY')) {
          try { sections.push(projectsSection(fs.readFileSync(envOf('AGENT_OFFICE_DIRECTORY'), 'utf8'))); } catch {}
        }
        systemSection = sections.join('\n\n');
      }
      return systemSection || undefined;
    },
  });

  // /office in the terminal: today's counts as text. Outside the app, the live drawing needs the node viewer
  // Claude Code's runner provides; the summary is the same either way.
  cmd.addCommand({
    name: 'office',
    description: 'Agent Office: what this session and the office did today',
    handler: () => ({
      message: [
        `This session: ${[...workers.values()].filter((w) => !w.doneAt).length} agent(s) on the desks, ${isBossBusy ? 'boss is working' : 'boss is free'}`,
        `Deliveries today: ${today?.ids?.length || 0}`,
        `Agents finished just now: ${[...workers.values()].filter((w) => w.doneAt && w.doneAt > now() - forgetMs).length}`,
      ].join('\n'),
    }),
  });
}
