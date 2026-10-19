// Engine per project (contract v3.18): how a tab of an Antigravity project starts. Pure functions (no Electron;
// tested with node --test). Google Antigravity CLI (`agy`, 1.3.6 or newer) keeps its own login and data
// (~/.gemini/antigravity-cli), so none of Claude Code's setup (account folder, plugin, status line, memory, MCP
// config) is passed to it.
const { promptArg } = require('./resume.js');

// macOS/Linux launch line, run by the login shell like claude's (PATH and rc files apply); the arguments come via "$@".
const AGY_COMMAND = 'exec agy "$@"';

/**
 * agy's arguments for a start: `--continue` (the most recent conversation) when resuming, then, only when resuming
 * and a prompt is given, `-i <prompt>` (agy's initial prompt, then interactive). A fresh start has no arguments.
 * @param {{ resume?: boolean, prompt?: string }} [o]
 */
function agyArgs({ resume = false, prompt = '' } = {}) {
  const p = resume && prompt ? promptArg(prompt) : '';
  return [...(resume ? ['--continue'] : []), ...(p ? ['-i', p] : [])];
}

module.exports = { AGY_COMMAND, agyArgs };
