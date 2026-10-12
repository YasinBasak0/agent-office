// Windows-only checks that need a real Windows (CI's windows job): the status line command through Git Bash and
// PowerShell, and npm-style .cmd launching through cmd.exe. Skipped elsewhere; the pure decisions are in main.test.cjs.
// node --test app/test/windows.test.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const OS = require('../src/platform.js');
const U = require('../src/usage.js');

const skip = process.platform !== 'win32' && 'Windows only';
const isFile = (f) => { try { return fs.statSync(f).isFile(); } catch { return false; } };

// statusline.js and agent-office-statusline.cmd as main writes them, with node.exe standing in for the app's
// executable (the .cmd sets ELECTRON_RUN_AS_NODE, which node ignores).
function statusLineDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao win '));
  fs.writeFileSync(path.join(dir, U.WIN_SCRIPT_NAME), U.WIN_SCRIPT);
  fs.writeFileSync(path.join(dir, U.WIN_CMD), U.windowsCmdFile(process.execPath));
  return dir;
}
const input = JSON.stringify({ rate_limits: { five_hour: { used_percentage: 42, resets_at: 1 } } });

test('status line: Git Bash runs the bare command, the input lands in the file and the user command shows', { skip }, () => {
  const bash = OS.findGitBash(process.env, isFile);
  assert.ok(bash, 'Git Bash not found');
  const dir = statusLineDir();
  const out = path.join(dir, 'tab one.json');
  const command = JSON.parse(U.windowsStatusLineSettings(null)).statusLine.command;
  const env = { ...OS.withPathDir(process.env, dir), AGENT_OFFICE_USAGE_OUT: out, AGENT_OFFICE_STATUSLINE: 'wc -c | tr -d " "', AGENT_OFFICE_STATUSLINE_SHELL: bash };
  const shown = execFileSync(bash, ['-c', command], { input, env }).toString();
  assert.equal(fs.readFileSync(out, 'utf8'), input);
  assert.equal(shown.trim(), String(input.length));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('status line: PowerShell runs the bare command too (no Git Bash: the user command runs in PowerShell)', { skip }, () => {
  const dir = statusLineDir();
  const out = path.join(dir, 'tab.json');
  const command = JSON.parse(U.windowsStatusLineSettings(null)).statusLine.command;
  const env = { ...OS.withPathDir(process.env, dir), AGENT_OFFICE_USAGE_OUT: out, AGENT_OFFICE_STATUSLINE: '$input | Measure-Object -Character | ForEach-Object { $_.Characters }', AGENT_OFFICE_STATUSLINE_SHELL: '' };
  const shown = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { input, env }).toString();
  assert.equal(fs.readFileSync(out, 'utf8'), input);
  assert.match(shown.trim(), /^\d+$/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('claude.cmd: arguments with spaces reach the program unchanged through cmd.exe /d /s /c', { skip }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao cmd '));
  const echo = path.join(dir, 'echo.js');
  fs.writeFileSync(echo, 'process.stdout.write(JSON.stringify(process.argv.slice(2)))');
  // like npm's shim: the .cmd hands %* to node
  const shim = path.join(dir, 'claude.cmd');
  fs.writeFileSync(shim, `@echo off\r\n"${process.execPath}" "%~dp0echo.js" %*\r\n`);
  assert.equal(OS.findOnPath('claude', { PATH: dir, PATHEXT: '.EXE;.CMD' }, isFile), shim);
  const args = ['--plugin-dir', path.join(dir, 'Agent Office', 'plugin'), '--settings', path.join(dir, 'p q.json'), '--continue'];
  const cmd = OS.windowsCommand(shim, args, process.env);
  const got = execFileSync(cmd.file, cmd.args, { windowsVerbatimArguments: cmd.verbatim }).toString();
  assert.deepEqual(JSON.parse(got), args);
  fs.rmSync(dir, { recursive: true, force: true });
});
