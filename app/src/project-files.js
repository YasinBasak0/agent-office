// Opt-in project files (contract v3.38): with the project's "Let Agent Office add its files to this project" toggle on,
// Antigravity (agy) and Command Code get Agent Office's setup from files in the project folder, because neither takes it
// on the launch line. Everything written is static text or the project's own data:
//   agy  .agents/rules/agent-office-manager.md   manager brief (manager mode on only)       antigravity.google/docs/rules
//        .agents/agents/ao-worker.md              worker agent pinned to the agent model     antigravity.google/docs/subagents
//        .agents/hooks.json                       Stop gate: check before done (manager on)  antigravity.google/docs/hooks
//        .agents/mcp_config.json                  the project's own APPROVED .mcp.json only  antigravity.google/docs/mcp
//   cmd  .commandcode/agents/ao-worker.md         worker agent pinned to the agent model     commandcode.ai/docs/agents
// Nothing of Claude Code's or the office's setup (accounts, office directory, journal, other projects, env) goes in.
// Ownership: <root>/.agent-office-files.json (root = .agents or .commandcode) lists every file written with its sha256;
// Markdown files also carry a marker comment. A file is only replaced or removed while it is unchanged since we wrote it;
// a user's file of the same name is never touched (refused, with a notice). The paths go in .git/info/exclude.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MARKER = 'agent-office:generated';
const MANIFEST = '.agent-office-files.json';
const ROOTS = { agy: '.agents', commandcode: '.commandcode' };
const EXCLUDE_BEGIN = '# >>> Agent Office project files (removed when the toggle is off)';
const EXCLUDE_END = '# <<< Agent Office project files';
const HOOK_NAME = 'agent-office-verify';

const MANAGER_BRIEF = [
  'You are the boss of this project.',
  'Split the work and hand each part to a subagent; keep the main conversation for planning, review and decisions.',
  'Give every subagent a clear goal, the files it may touch and the check that proves it is done.',
  'Ask each subagent for a report of at most 15 lines.',
  'Verify the result (tests, build, a look at the diff) before you call a task done.',
  'If the same error comes back twice, stop and rethink instead of retrying.',
];
const WORKER_BODY = [
  'You are a worker of Agent Office: you get one well-scoped part of the work.',
  'Stay inside the goal and the files you were given; run the check you were given before you finish.',
  'Report in at most 15 lines: what you changed, the check and its result, anything left open.',
];
const STOP_REASON = 'Agent Office check before you finish: run the project\'s tests or build and look at the diff. '
  + 'If you already did and they pass, say so in one line and stop. If the same error came back twice, stop and report instead of retrying.';

const comment = `<!-- ${MARKER}: written by Agent Office ("Let Agent Office add its files to this project"); turning that off removes this file. -->`;

// agy agent tiers (docs/subagents: inherit | flash | pro); Command Code takes full model ids (docs/agents, reference/cli/models).
const AGY_TIER = { haiku: 'flash', sonnet: 'flash', opus: 'pro' };
const CMD_MODEL = { haiku: 'claude-haiku-5-5', sonnet: 'claude-sonnet-5-5', opus: 'claude-opus-5-5' };

const isObj = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const str = (v) => typeof v === 'string';

/**
 * The project's own .mcp.json servers translated to agy's mcp_config.json shape: stdio keeps command/args/env/cwd,
 * remote (url) becomes serverUrl (+headers); anything else is dropped. Only `approved` names are taken.
 */
function agyMcpServers(projectMcp, approved) {
  const ok = new Set(approved || []);
  const out = {};
  for (const [name, s] of Object.entries(isObj(projectMcp?.mcpServers) ? projectMcp.mcpServers : {})) {
    if (!ok.has(name) || !isObj(s)) continue;
    if (str(s.command) && s.command) {
      out[name] = { command: s.command };
      if (Array.isArray(s.args)) out[name].args = s.args.filter(str);
      if (isObj(s.env)) out[name].env = Object.fromEntries(Object.entries(s.env).filter(([, v]) => str(v)));
      if (str(s.cwd)) out[name].cwd = s.cwd;
    } else if (str(s.url) && /^https?:\/\//i.test(s.url)) {
      out[name] = { serverUrl: s.url };
      if (isObj(s.headers)) out[name].headers = Object.fromEntries(Object.entries(s.headers).filter(([, v]) => str(v)));
    }
  }
  return out;
}

// The Stop hook (docs/hooks: stdin has conversationId, executionNum; stdout {decision:"continue", reason}). POSIX sh only.
// It sends the agent back once per execution: state "<num> g|a" in $TMPDIR; a stop right after a gate is let through.
const STOP_COMMAND = [
  'in=$(tr -d "\\n");',
  'id=$(printf %s "$in" | sed -n "s/.*\\"conversationId\\"[[:space:]]*:[[:space:]]*\\"\\([A-Za-z0-9._-]*\\)\\".*/\\1/p");',
  'n=$(printf %s "$in" | sed -n "s/.*\\"executionNum\\"[[:space:]]*:[[:space:]]*\\([0-9][0-9]*\\).*/\\1/p");',
  'if [ -z "$id" ] || [ -z "$n" ]; then echo "{\\"decision\\":\\"stop\\"}"; exit 0; fi;',
  'f="${TMPDIR:-/tmp}/agent-office-agy-stop-$id"; set -- $(cat "$f" 2>/dev/null);',
  'if [ "$2" = g ] && { [ "$1" = "$n" ] || [ "$1" = "$((n-1))" ]; }; then echo "$n a" > "$f"; echo "{\\"decision\\":\\"stop\\"}";',
  `else echo "$n g" > "$f"; echo ${JSON.stringify(JSON.stringify({ decision: 'continue', reason: STOP_REASON }))}; fi`,
].join(' ');

/**
 * The files Agent Office wants in the project: [{ rel, content }] (rel uses '/').
 * @param {{ engine?: string, enabled?: boolean, manager?: boolean, agentModel?: string | null, projectMcp?: any, approved?: string[] }} [opts]
 * @returns {{ rel: string, content: string }[]}
 */
function desiredFiles({ engine, enabled, manager = false, agentModel = null, projectMcp = null, approved = [] } = {}) {
  if (!enabled) return [];
  const out = [];
  if (engine === 'agy') {
    const tier = AGY_TIER[agentModel];
    if (manager) {
      out.push({
        rel: '.agents/rules/agent-office-manager.md',
        content: ['---', 'trigger: always_on', 'description: Agent Office manager mode for this project', '---', comment, '',
          '# Agent Office manager mode', '', ...MANAGER_BRIEF.map((l) => `- ${l}`),
          ...(tier ? ['- Hand implementation parts to the `ao-worker` agent.'] : []), ''].join('\n'),
      });
      out.push({
        rel: '.agents/hooks.json',
        content: JSON.stringify({ [HOOK_NAME]: { Stop: [{ type: 'command', command: STOP_COMMAND, timeout: 10 }] } }, null, 2) + '\n',
      });
    }
    if (tier) out.push({ rel: '.agents/agents/ao-worker.md', content: agentFile({ model: tier }) });
    const servers = agyMcpServers(projectMcp, approved);
    if (Object.keys(servers).length) out.push({ rel: '.agents/mcp_config.json', content: JSON.stringify({ mcpServers: servers }, null, 2) + '\n' });
  } else if (engine === 'commandcode') {
    const model = CMD_MODEL[agentModel];
    if (model) out.push({ rel: '.commandcode/agents/ao-worker.md', content: agentFile({ model, tools: '"*"' }) });
  }
  return out;
}

function agentFile({ model, tools = null }) {
  return ['---', 'name: ao-worker',
    'description: Agent Office worker. Takes one well-scoped part of the work (goal, files, check) and reports in at most 15 lines.',
    `model: ${model}`, ...(tools ? [`tools: ${tools}`] : []), '---', comment, '', ...WORKER_BODY, ''].join('\n');
}

const readText = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
const readManifest = (dir, root) => {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(dir, root, MANIFEST), 'utf8'));
    return isObj(m?.files) ? m.files : {};
  } catch { return {}; }
};
/** Ours: listed with the same hash, or a Markdown file with our marker. */
const isOurs = (text, rel, files) => text !== null && (files[rel] === sha(text) || (rel.endsWith('.md') && text.includes(MARKER)));

/** The repository's exclude file and the project's path inside the repository (no git run). null when not in git. */
function gitExclude(dir) {
  let d = path.resolve(dir);
  for (;;) {
    const g = path.join(d, '.git');
    let st = null;
    try { st = fs.statSync(g); } catch { /* not here */ }
    if (st) {
      let gitDir = g;
      if (st.isFile()) {
        const m = /^gitdir:\s*(.+)$/m.exec(readText(g) || '');
        if (!m) return null;
        gitDir = path.resolve(d, m[1].trim());
        const common = (readText(path.join(gitDir, 'commondir')) || '').trim();
        if (common) gitDir = path.resolve(gitDir, common);
      }
      return { file: path.join(gitDir, 'info', 'exclude'), prefix: path.relative(d, path.resolve(dir)).split(path.sep).filter(Boolean).join('/') };
    }
    const up = path.dirname(d);
    if (up === d) return null;
    d = up;
  }
}

/** Replaces Agent Office's block in .git/info/exclude with `rels` (none: the block goes). */
function writeExclude(dir, rels) {
  const ex = gitExclude(dir);
  if (!ex) return false;
  const before = readText(ex.file) || '';
  const lines = before.split('\n');
  const kept = [];
  for (let i = 0, skip = false; i < lines.length; i++) {
    if (lines[i] === EXCLUDE_BEGIN) { skip = true; continue; }
    if (skip) { if (lines[i] === EXCLUDE_END) skip = false; continue; }
    kept.push(lines[i]);
  }
  while (kept.length && kept[kept.length - 1] === '') kept.pop();
  const add = rels.length ? [EXCLUDE_BEGIN, ...rels.map((r) => '/' + (ex.prefix ? ex.prefix + '/' : '') + r), EXCLUDE_END] : [];
  const next = [...kept, ...add].join('\n') + (kept.length || add.length ? '\n' : '');
  if (next === before) return true;
  fs.mkdirSync(path.dirname(ex.file), { recursive: true });
  fs.writeFileSync(ex.file, next);
  return true;
}

const rmdirEmpty = (dir, root, rel) => {
  for (let d = path.dirname(path.join(dir, rel)); d.startsWith(path.join(dir, root)) && d !== dir; d = path.dirname(d)) {
    try { fs.rmdirSync(d); } catch { return; }
  }
};

/**
 * Makes the project folder hold exactly the desired files of ours (both roots; files of the engine not in use go).
 * → { written: rel[], removed: rel[], refused: rel[] (a user's file, or ours changed by the user: left alone) }.
 */
function syncProjectFiles(dir, desired) {
  const res = { written: [], removed: [], refused: [] };
  const want = new Map(desired.map((f) => [f.rel, f.content]));
  const owned = [];
  for (const root of Object.values(ROOTS)) {
    const files = readManifest(dir, root);
    const next = {};
    for (const [rel, content] of want) {
      if (!rel.startsWith(root + '/')) continue;
      const abs = path.join(dir, rel);
      const now = readText(abs);
      if (now !== null && !isOurs(now, rel, files)) { res.refused.push(rel); continue; }
      if (now !== content) {
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, content);
        res.written.push(rel);
      }
      next[rel] = sha(content);
    }
    for (const rel of Object.keys(files)) {
      if (next[rel] || !rel.startsWith(root + '/') || rel.includes('..')) continue;
      const abs = path.join(dir, rel);
      const now = readText(abs);
      if (now === null) continue;
      if (!isOurs(now, rel, files)) { res.refused.push(rel); continue; }
      fs.rmSync(abs, { force: true });
      res.removed.push(rel);
      rmdirEmpty(dir, root, rel);
    }
    const mf = path.join(dir, root, MANIFEST);
    if (Object.keys(next).length) {
      const text = JSON.stringify({ writtenBy: 'Agent Office', note: 'Files Agent Office wrote; turning its project files off removes them.', files: next }, null, 2) + '\n';
      if (readText(mf) !== text) { fs.mkdirSync(path.dirname(mf), { recursive: true }); fs.writeFileSync(mf, text); }
      owned.push(...Object.keys(next), `${root}/${MANIFEST}`);
    } else if (readText(mf) !== null) {
      fs.rmSync(mf, { force: true });
      try { fs.rmdirSync(path.join(dir, root)); } catch { /* not empty: the user's */ }
    }
  }
  writeExclude(dir, owned);
  res.refused = [...new Set(res.refused)];
  return res;
}

module.exports = {
  MARKER, MANIFEST, ROOTS, HOOK_NAME, STOP_COMMAND, STOP_REASON, EXCLUDE_BEGIN, EXCLUDE_END,
  agyMcpServers, desiredFiles, syncProjectFiles, gitExclude, writeExclude,
};
