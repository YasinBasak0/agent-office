// One boss (contract v3.35): src/office-mcp.js over stdio against the app's socket; token auth; socket path length;
// the server added by prepareShared stays out of the MCP fingerprint.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const OM = require('../src/office-mcp.js');
const SC = require('../src/shared-config.js');

const SCRIPT = path.join(__dirname, '..', 'src', 'office-mcp.js');

function client(env) {
  const p = spawn(process.execPath, [SCRIPT], { env: { PATH: process.env.PATH, ...env }, stdio: ['pipe', 'pipe', 'inherit'] });
  let buf = '';
  const waiting = new Map();
  p.stdout.on('data', (c) => {
    buf += c;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); waiting.get(m.id)?.(m); }
  });
  let n = 0;
  const call = (method, params) => new Promise((resolve) => { const id = ++n; waiting.set(id, resolve); p.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); });
  return { call, notify: (method) => p.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`), close: () => p.stdin.end() };
}

test('office-mcp: initialize, tools/list and tools/call over stdio; a wrong token is refused', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-om-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const calls = [];
  const sock = OM.createOfficeSocket({ socketFile: OM.socketPath(dir), handle: (tab, tool, args) => { calls.push([tab, tool, args]); return tool === 'office_dispatch' ? { id: 'abc', status: 'queued' } : { machines: [] }; } });
  t.after(() => sock.close());
  assert.equal(await sock.ready, true);
  if (process.platform !== 'win32') assert.equal((fs.statSync(sock.socketFile).mode & 0o777).toString(8), '600');
  const token = sock.add('p1');
  const c = client({ AGENT_OFFICE_SOCKET: sock.socketFile, AGENT_OFFICE_TOKEN: token });
  t.after(() => c.close());
  const init = await c.call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
  assert.equal(init.result.serverInfo.name, 'agent-office');
  assert.ok(init.result.capabilities.tools);
  c.notify('notifications/initialized');
  const list = await c.call('tools/list', {});
  assert.deepEqual(list.result.tools.map((x) => x.name), ['office_machines', 'office_dispatch', 'office_reports']);
  const r = await c.call('tools/call', { name: 'office_dispatch', arguments: { machine: 'Laptop', project: 'shop', task: 'run the tests' } });
  assert.deepEqual(JSON.parse(r.result.content[0].text), { id: 'abc', status: 'queued' });
  assert.deepEqual(calls, [['p1', 'office_dispatch', { machine: 'Laptop', project: 'shop', task: 'run the tests' }]]);
  const big = await c.call('tools/call', { name: 'office_dispatch', arguments: { project: 'shop', task: 'x'.repeat(OM.TASK_MAX + 1) } });
  assert.equal(big.result.isError, true);
  assert.equal(calls.length, 1);
  const unknown = await c.call('nope/method', {});
  assert.equal(unknown.error.code, -32601);
  // wrong token, and a token whose tab ended
  const bad = client({ AGENT_OFFICE_SOCKET: sock.socketFile, AGENT_OFFICE_TOKEN: 'f'.repeat(48) });
  t.after(() => bad.close());
  const denied = await bad.call('tools/call', { name: 'office_machines', arguments: {} });
  assert.equal(denied.result.isError, true);
  assert.deepEqual(JSON.parse(denied.result.content[0].text), { error: 'unauthorized' });
  sock.remove('p1');
  const gone = await c.call('tools/call', { name: 'office_machines', arguments: {} });
  assert.deepEqual(JSON.parse(gone.result.content[0].text), { error: 'unauthorized' });
  assert.equal(calls.length, 1);
});

test('office-mcp: socket path at most 100 bytes; server config carries the token only in its env', () => {
  const long = path.join('/Users/someone', 'x'.repeat(120), 'Agent Office');
  const p = OM.socketPath(long, { platform: 'darwin', tmpdir: '/var/folders/ab/cdefgh/T' });
  assert.ok(Buffer.byteLength(p) <= 100, p);
  assert.equal(OM.socketPath('/Users/a/Library/Application Support/Agent Office', { platform: 'darwin' }), '/Users/a/Library/Application Support/Agent Office/link/office.sock');
  assert.match(OM.socketPath('C:\\Users\\a', { platform: 'win32' }), /^\\\\\.\\pipe\\agent-office-[0-9a-f]{12}$/);
  const cfg = OM.serverConfig({ socket: '/s', token: 'tok', execPath: '/e', script: '/m.js' });
  assert.deepEqual(cfg, { type: 'stdio', command: '/e', args: ['/m.js'], env: { ELECTRON_RUN_AS_NODE: '1', AGENT_OFFICE_SOCKET: '/s', AGENT_OFFICE_TOKEN: 'tok' } });
});

test('office-mcp: prepareShared writes the boss server (0600) but the MCP fingerprint ignores it', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-omh-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const mcpFile = path.join(home, 'mcp', 'p1.json');
  const extra = { 'agent-office': OM.serverConfig({ socket: '/s', token: 'tok' }) };
  const before = SC.mcpFingerprint(SC.mcpPlan({ account: {}, home, cwd: null }));
  const r = SC.prepareShared({ account: {}, home, cwd: null, stageRoot: path.join(home, 'st'), mcpFile, extra });
  assert.equal(r.mcpConfig, mcpFile);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(mcpFile, 'utf8')).mcpServers), ['agent-office']);
  if (process.platform !== 'win32') assert.equal((fs.statSync(mcpFile).mode & 0o777).toString(8), '600');
  assert.equal(SC.mcpFingerprint(SC.mcpPlan({ account: {}, home, cwd: null })), before);
  assert.deepEqual(r.mcpNames, {});
});
