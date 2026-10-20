// What each engine can do with the project row's controls (contract v3.36). Pure data, no DOM, no Electron:
// the sidebar renders EVERY control for every engine and disables the ones an engine can't honour, with a one-line
// reason (the locale key `sidebar.na.<reason>`). Tested with node --test (app/test/engine-caps.test.mjs).

export const ENGINES = ['claude', 'agy', 'commandcode'];

/** The features of a project row, in the order the sidebar shows them. */
export const FEATURES = ['account', 'login', 'manager', 'bossModel', 'agentModel', 'contextCap', 'savings', 'backup', 'workers', 'approvals', 'cost'];

const OK = Object.freeze({ ok: true });
const no = (reason) => Object.freeze({ ok: false, reason });

// Command Code: manager mode, context cap, savings, workers and approvals arrive with its launch config and mod
// (contract v3.37). Antigravity: what it can't take without files in the project or ~/.gemini stays off (v3.36).
const TABLE = {
  claude: {},
  agy: {
    manager: no('agyManager'),
    agentModel: no('agyAgentModel'),
    contextCap: no('agyContextCap'),
    savings: no('agySavings'),
    backup: no('agyBackup'),
    workers: no('agyWorkers'),
    cost: no('agyCost'),
  },
  commandcode: {
    agentModel: no('cmdAgentModel'),
    backup: no('cmdBackup'),
  },
};

const engineOf = (e) => (ENGINES.includes(e) ? e : 'claude');

/** The engine's capabilities: { [feature]: { ok: true } | { ok: false, reason } } for every feature. */
export function caps(engine) {
  const row = TABLE[engineOf(engine)];
  return Object.fromEntries(FEATURES.map((f) => [f, row[f] || OK]));
}

/** One feature of one engine. */
export const cap = (engine, feature) => caps(engine)[feature] || OK;

// The boss model choices per engine (contract v3.27, v3.36): value + label. Auto ('auto', stored as nothing) comes
// first everywhere. Claude: claude's aliases (the sidebar shows their locale strings). Antigravity: its documented model tiers
// (antigravity.google/docs/subagents). Command Code: full model ids (commandcode.ai/docs/reference/cli/models).
// projects.js BOSS_MODELS_BY_ENGINE holds the same values (the test checks it).
export const BOSS_MODEL_CHOICES = {
  claude: [{ value: 'sonnet', label: 'Sonnet' }, { value: 'opus', label: 'Opus' }, { value: 'haiku', label: 'Haiku' }],
  agy: [{ value: 'flash', label: 'Gemini Flash' }, { value: 'pro', label: 'Gemini Pro' }],
  commandcode: [
    { value: 'claude-sonnet-5-5', label: 'Sonnet 5.5' }, { value: 'claude-opus-5-5', label: 'Opus 5.5' },
    { value: 'claude-haiku-5-5', label: 'Haiku 5.5' }, { value: 'deepseek/deepseek-v4-flash', label: 'DeepSeek V4 Flash' },
  ],
};

/** The boss model choices of an engine. */
export const bossModelChoices = (engine) => BOSS_MODEL_CHOICES[engineOf(engine)];
