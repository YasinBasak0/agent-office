// Device link (contract v3.28): unit tests for src/link-core.js and an integration test of two src/link.js
// instances paired over a local hyperdht testnet (no internet, no public DHT).
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const C = require('../src/link-core.js');
const { Link } = require('../src/link.js');

const pubA = 'a'.repeat(64);
const pubB = 'b'.repeat(64);

test('pairing codes: five words, canonical form, bad input refused', () => {
  const code = C.makeCode();
  assert.match(code, /^[a-z]+(-[a-z]+){4}$/);
  assert.equal(C.normalizeCode(code.toUpperCase().replace(/-/g, '  ')), code);
  assert.equal(C.normalizeCode('acid aged also area'), null);              // too short
  assert.equal(C.normalizeCode('acid aged also area zzzz'), null);         // not a word
  assert.equal(C.normalizeCode(null), null);
  assert.equal(C.makeCode(() => Buffer.from([0, 1, 2, 3, 255])), `acid-aged-also-area-${C.WORDS[255]}`);
});

test('pair secrets: deterministic per code, proofs bound to role and both keys', () => {
  const a = C.pairSecrets(`acid-aged-also-area-${C.WORDS[255]}`);
  const b = C.pairSecrets(`acid-aged-also-area-${C.WORDS[255]}`);
  const other = C.pairSecrets('acid-aged-also-area-lamp');
  assert.deepEqual(a.topic, b.topic);
  assert.notDeepEqual(a.topic, other.topic);
  assert.notDeepEqual(a.topic, a.key);
  const proof = C.pairProof(a.key, 'joiner', pubA, pubB);
  assert.ok(C.proofOk(b.key, 'joiner', pubA, pubB, proof));
  assert.ok(!C.proofOk(b.key, 'inviter', pubA, pubB, proof));             // role
  assert.ok(!C.proofOk(b.key, 'joiner', pubB, pubA, proof));              // direction
  assert.ok(!C.proofOk(other.key, 'joiner', pubA, pubB, proof));          // wrong code
  assert.ok(!C.proofOk(a.key, 'joiner', pubA, pubB, 'nope'));
  const s = crypto.randomBytes(32).toString('hex');
  assert.equal(C.pairTopic(s).length, 32);
  assert.notDeepEqual(C.pairTopic(s), C.pairTopic(crypto.randomBytes(32).toString('hex')));
});

test('message schema: known messages pass cleaned, unknown or oversized ones are dropped', () => {
  assert.equal(C.validateMessage({ t: 'exec', cmd: 'rm -rf /' }), null);
  assert.equal(C.validateMessage([]), null);
  assert.equal(C.validateMessage('x'), null);
  assert.deepEqual(C.validateMessage({ t: 'hello', v: 1, name: 'Mac\x1b[31m mini' }), { t: 'hello', v: 1, name: 'Mac mini' });
  assert.equal(C.validateMessage({ t: 'cmd', id: 'x', project: 'p', text: 'a'.repeat(C.MAX_COMMAND * 4 + 1) }), null);
  assert.equal(C.validateMessage({ t: 'cmd', id: '../../x', project: 'p', text: 'hi' }), null);
  assert.ok(C.validateMessage({ t: 'cmd', id: 'abc', project: 'p1', text: 'hi' }));
  assert.equal(C.validateMessage({ t: 'cmd-status', id: 'abc', status: 'done' }), null);
  assert.equal(C.validateMessage({ t: 'cmd-status', id: 'abc', status: 'rejected', reason: 'because' }), null);
  assert.ok(C.validateMessage({ t: 'cmd-status', id: 'abc', status: 'rejected', reason: 'rate-limited' }));
  const snap = { projects: [{ id: 'p1', name: 'shop', status: 'working', working: 2, delivered: 3, attention: 'x', secret: 'leak' }], workers: [{ id: 'w1', project: 'p1', type: 'Explore', description: 'd'.repeat(500), transcript: 'no' }, { id: 'w2', project: 'nope', type: 'x' }], delivered: 3 };
  const m = C.validateMessage({ t: 'state', seq: 1, snap });
  assert.equal(m.snap.projects[0].secret, undefined);
  assert.equal(m.snap.projects[0].attention, null);
  assert.equal(m.snap.workers.length, 1);
  assert.equal(m.snap.workers[0].transcript, undefined);
  assert.ok(m.snap.workers[0].description.length <= 120);
  assert.equal(C.validateMessage({ t: 'state', seq: 1, snap: { projects: [{ id: 'p', name: 'x', status: 'exploding' }] } }), null);
  assert.equal(C.validateMessage({ t: 'state', seq: 1, snap: { projects: new Array(51).fill({ id: 'p', status: 'idle' }) } }), null);
});

test('line reader: oversized frames close the stream, bad JSON is skipped', () => {
  const got = [];
  const r = new C.LineReader((m) => got.push(m), 100);
  assert.ok(r.push('{"t":"a"}\nnot json\n{"t":'));
  assert.ok(r.push('"b"}\n'));
  assert.deepEqual(got, [{ t: 'a' }, { t: 'b' }]);
  assert.equal(r.push('x'.repeat(200)), false);
  assert.equal(C.encode({ t: 'x', pad: 'x'.repeat(C.MAX_FRAME) }), null);
});

test('command sanitizing: escapes and control characters stripped, size limited, never empty', () => {
  assert.deepEqual(C.sanitizeCommand('fix the \x1b[2J\x1b]0;evil\x07tests\x00 now\r\n!rm -rf ~'), { ok: true, text: 'fix the tests now !rm -rf ~' });
  assert.deepEqual(C.sanitizeCommand('‮abc​'), { ok: true, text: 'abc' });
  assert.deepEqual(C.sanitizeCommand('\x1b[A\x03'), { ok: false, reason: 'empty' });
  assert.deepEqual(C.sanitizeCommand('é'.repeat(4097)), { ok: false, reason: 'too-large' });   // 8194 bytes
  assert.equal(C.sanitizeCommand('a'.repeat(8192)).ok, true);
  assert.deepEqual(C.sanitizeCommand({}), { ok: false, reason: 'not-text' });
  assert.equal(C.markedCommand('Ev "Mac"\x1b[1m', 'hi'), '[Agent Office: remote command from "Ev \'Mac\'"] hi');
});

test('rate limiter: burst of 3, then one per 10 s, per device', () => {
  let now = 0;
  const r = new C.RateLimiter({ now: () => now });
  assert.deepEqual([r.take('a'), r.take('a'), r.take('a'), r.take('a')], [true, true, true, false]);
  assert.equal(r.take('b'), true);
  now += 9999; assert.equal(r.take('a'), false);
  now += 2; assert.equal(r.take('a'), true);
});

test('trust checks: only listed keys with a secret; commands only with the toggle', () => {
  const devices = C.normalizeDevices([{ pub: pubA, name: 'A', addedAt: 1, allowCommands: true }, { pub: pubB, name: 'B' }, { pub: 'zz', name: 'bad' }, { pub: pubA, name: 'dup' }]);
  assert.equal(devices.length, 2);
  assert.equal(devices[1].allowCommands, false);                          // off by default
  const secrets = { [pubA]: 'c'.repeat(64) };
  assert.equal(C.trusted(devices, secrets, Buffer.from(pubA, 'hex')).name, 'A');
  assert.equal(C.trusted(devices, secrets, pubB), null);                  // no secret, no trust
  assert.equal(C.trusted(devices, secrets, 'd'.repeat(64)), null);
  assert.equal(C.mayCommand(devices, secrets, pubA), true);
  assert.equal(C.mayCommand(devices, { ...secrets, [pubB]: 'e'.repeat(64) }, pubB), false);
});

test('snapshot: built from OfficeData, only status lines', () => {
  const office = { delivered: 4, projects: [{ name: 'shop', working: 1, delivered: 4, isBossBusy: false, waiting: { tool: 'Bash', since: 1 } }, { name: 'blog', working: 0, delivered: 0, isBossBusy: false, waiting: null }],
    workers: [{ id: 'w1', project: 'shop', type: 'Explore', description: 'Find the bug', tool: 'Grep', detail: 'secret path', prompt: 'long prompt', result: 'answer', spawnAt: 5 }] };
  const s = C.snapshotOf([{ id: 'p1', name: 'shop', engine: 'claude' }, { id: 'p2', name: 'blog', engine: 'agy' }], office, new Map([['p1', 'permission']]));
  assert.deepEqual(s.projects.map((p) => [p.status, p.attention, p.engine]), [['approval', 'permission', 'claude'], ['idle', null, 'agy']]);
  assert.deepEqual(Object.keys(s.workers[0]).sort(), ['description', 'id', 'project', 'spawnAt', 'tool', 'type']);
  assert.equal(C.logEntry(0, 'A', 'shop', 'line one\nline two', 'queued').firstLine, 'line one');
});

test('integration: pair over a local testnet, mirror state, send a command, revoke', { timeout: 60000 }, async (t) => {
  const createTestnet = require('hyperdht/testnet');
  const DHT = require('hyperdht');
  const testnet = await createTestnet(3);
  t.after(() => testnet.destroy());
  const persisted = { a: null, b: null };
  const a = new Link({ keyPair: DHT.keyPair(), name: 'Studio', bootstrap: testnet.bootstrap });
  const b = new Link({ keyPair: DHT.keyPair(), name: 'Laptop', bootstrap: testnet.bootstrap });
  t.after(() => Promise.all([a.destroy(), b.destroy()]));
  a.on('persist', (p) => { persisted.a = p; });
  b.on('persist', (p) => { persisted.b = p; });
  const until = (fn, ms = 20000) => new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => { const v = fn(); if (v) return resolve(v); if (Date.now() - t0 > ms) return reject(new Error('timeout')); setTimeout(tick, 50); };
    tick();
  });

  // a wrong code never pairs (b gives up when cancelled)
  const { code } = await a.invite();
  assert.equal(a.view().pairing.code, code);
  const paired = new Promise((resolve) => a.once('paired', resolve));
  const dev = await b.join(code);
  assert.equal(dev.name, 'Studio');
  assert.equal((await paired).name, 'Laptop');
  assert.equal(a.pairing, null);
  assert.equal(persisted.a.devices[0].allowCommands, false);
  assert.equal(persisted.a.secrets[b.pub], persisted.b.secrets[a.pub]);  // the shared pair secret

  // mirror: a publishes, b sees it
  await until(() => a.view().devices[0]?.online && b.view().devices[0]?.online);
  a.publish({ projects: [{ id: 'p1', name: 'shop', engine: 'claude', status: 'approval', working: 1, delivered: 2, attention: 'permission', tool: 'Bash' }], workers: [{ id: 'w1', project: 'p1', type: 'Explore', description: 'Find it' }], delivered: 2 });
  const remote = await until(() => b.view().remotes[0]);
  assert.equal(remote.name, 'Studio');
  assert.equal(remote.projects[0].status, 'approval');

  // commands are refused until a allows them
  const commands = [];
  a.on('command', (c) => { commands.push(c); c.reply('queued'); setTimeout(() => c.reply('delivered'), 20); });
  const r1 = b.sendCommand(a.pub, 'p1', 'run the tests');
  await until(() => b.outgoing.find((o) => o.id === r1.id).status === 'rejected');
  assert.equal(b.outgoing[0].reason, 'not-allowed');
  a.setAllow(b.pub, true);
  const r2 = b.sendCommand(a.pub, 'p1', 'run the \x1b[31mtests\x07');
  await until(() => b.outgoing.find((o) => o.id === r2.id).status === 'delivered');
  assert.equal(commands.length, 1);
  assert.equal(commands[0].text, 'run the tests');
  assert.equal(commands[0].device.name, 'Laptop');
  // rate limit: the bucket had 3, one spent (the refused one did not reach it)
  for (let i = 0; i < 3; i++) b.sendCommand(a.pub, 'p1', `again ${i}`);
  await until(() => b.outgoing.slice(0, 3).every((o) => o.status !== 'sent'));
  assert.equal(b.outgoing[0].reason, 'rate-limited');

  // removing revokes at once: the connection closes and does not come back
  await a.remove(b.pub);
  await until(() => !b.view().devices[0].online);
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(b.view().devices[0].online, false);
  assert.equal(a.view().devices.length, 0);
});

test('integration: a wrong code does not pair', { timeout: 30000 }, async (t) => {
  const createTestnet = require('hyperdht/testnet');
  const DHT = require('hyperdht');
  const testnet = await createTestnet(3);
  t.after(() => testnet.destroy());
  const a = new Link({ keyPair: DHT.keyPair(), name: 'A', bootstrap: testnet.bootstrap });
  const b = new Link({ keyPair: DHT.keyPair(), name: 'B', bootstrap: testnet.bootstrap });
  t.after(() => Promise.all([a.destroy(), b.destroy()]));
  const { code } = await a.invite();
  const words = code.split('-');
  words[0] = words[0] === 'acid' ? 'aged' : 'acid';
  const p = b.join(words.join('-')).catch((e) => e);
  await new Promise((r) => setTimeout(r, 3000));
  assert.equal(a.devices.length, 0);
  await b.cancelPairing();
  assert.match(String(await p), /cancelled/);
  await assert.rejects(b.join('not a code'), /bad-code/);
});

test('heartbeat: pings keep a quiet session online, a silent peer shows offline after 3 missed pings', { timeout: 30000 }, async (t) => {
  assert.deepEqual(C.validateMessage({ t: 'ping', extra: 1 }), { t: 'ping' });
  assert.equal(C.HEARTBEAT_MS * C.HEARTBEAT_MISSES, 15000);                 // the default: offline at most ~15 s after a peer vanishes
  const createTestnet = require('hyperdht/testnet');
  const DHT = require('hyperdht');
  const testnet = await createTestnet(3);
  t.after(() => testnet.destroy());
  const heartbeatMs = 200;
  const a = new Link({ keyPair: DHT.keyPair(), name: 'Studio', bootstrap: testnet.bootstrap, heartbeatMs });
  const b = new Link({ keyPair: DHT.keyPair(), name: 'Laptop', bootstrap: testnet.bootstrap, heartbeatMs });
  t.after(() => Promise.all([a.destroy(), b.destroy()]));
  const until = (fn, ms = 20000) => new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => { if (fn()) return resolve(Date.now() - t0); if (Date.now() - t0 > ms) return reject(new Error('timeout')); setTimeout(tick, 20); };
    tick();
  });
  const { code } = await a.invite();
  await b.join(code);
  await until(() => a.view().devices[0]?.online && b.view().devices[0]?.online);
  // no state or commands flow, only pings: both stay online well past 3 heartbeats
  await new Promise((r) => setTimeout(r, heartbeatMs * 6));
  assert.ok(a.view().devices[0].online && b.view().devices[0].online);
  // b goes silent without closing the stream (a crash or a frozen process): a drops it after 3 missed pings
  b.write = () => {};
  const took = await until(() => !a.view().devices[0].online, heartbeatMs * 20);
  assert.ok(took >= heartbeatMs * 2, `offline too early (${took} ms)`);
  assert.ok(took <= heartbeatMs * 3 + 1000, `offline too late (${took} ms)`);
});

// --- project handoff (contract v3.29)
const fs = require('fs');
const os = require('os');
const path = require('path');
const H = require('../src/handoff.js');

Object.assign(process.env, { GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.com', GIT_CONFIG_NOSYSTEM: '1' });
const tmp = (t, name) => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `ao-ho-${name}-`))); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };
function repo(t, name) {
  const d = tmp(t, name);
  H.git(d, ['init', '-q', '-b', 'main']);
  fs.writeFileSync(path.join(d, 'a.txt'), 'one\n');
  fs.writeFileSync(path.join(d, '.gitignore'), 'secret.env\n');
  H.git(d, ['add', '-A']);
  H.git(d, ['commit', '-q', '-m', 'first']);
  return d;
}
const state = (d) => ({ head: H.git(d, ['rev-parse', 'HEAD']), branch: H.git(d, ['symbolic-ref', '--short', 'HEAD']), status: H.git(d, ['status', '--porcelain']), index: H.git(d, ['diff', '--cached', '--name-status']), a: fs.readFileSync(path.join(d, 'a.txt'), 'utf8') });

test('handoff: the WIP snapshot leaves the branch, index and working tree unchanged', (t) => {
  const d = repo(t, 'wip');
  fs.writeFileSync(path.join(d, 'a.txt'), 'one\ntwo\n');        // modified
  fs.writeFileSync(path.join(d, 'new.txt'), 'new\n');           // untracked
  fs.writeFileSync(path.join(d, 'secret.env'), 'KEY=1\n');      // ignored
  fs.writeFileSync(path.join(d, 'staged.txt'), 'staged\n');
  H.git(d, ['add', 'staged.txt']);
  const before = state(d);
  const snap = H.snapshotWip(d, { now: () => Date.UTC(2026, 9, 20, 10, 0, 0) });
  assert.match(snap.wip, /^agent-office\/handoff-20261020100000/);
  assert.deepEqual(state(d), before);
  assert.equal(H.git(d, ['show', `${snap.wip}:a.txt`]), 'one\ntwo');
  assert.equal(H.git(d, ['show', `${snap.wip}:new.txt`]), 'new');
  assert.equal(H.git(d, ['show', `${snap.wip}:staged.txt`]), 'staged');
  assert.throws(() => H.git(d, ['show', `${snap.wip}:secret.env`]));
  assert.equal(H.git(d, ['rev-parse', `${snap.wip}^`]), before.head);
  assert.equal(snap.base, before.head);
  assert.equal(snap.branch, 'main');
  assert.ok(!fs.readdirSync(path.join(d, '.git')).some((f) => f.includes('handoff') && f.endsWith('.index')));
});

test('handoff: bundle round trip between two repos; restored only when clean on the same commit', async (t) => {
  const a = repo(t, 'src');
  fs.writeFileSync(path.join(a, 'a.txt'), 'changed\n');
  fs.writeFileSync(path.join(a, 'b.txt'), 'b\n');
  const snap = H.snapshotWip(a);
  const bundle = H.createBundle(snap, tmp(t, 'bundles'));
  assert.ok(bundle.length > 0);
  const g = { mode: 'bundle', wip: snap.wip, base: snap.base, root: snap.root, branch: snap.branch, remote: '' };
  const file = path.join(tmp(t, 'f'), 'x.bundle');
  fs.writeFileSync(file, bundle);
  // a fresh folder: the sender's branch at its base, the WIP as uncommitted changes
  const fresh = path.join(tmp(t, 'dst'), 'proj');
  await H.receiveCode(fresh, g, file);
  assert.equal(H.restoreWip(fresh, g), 'restored');
  assert.equal(H.git(fresh, ['symbolic-ref', '--short', 'HEAD']), 'main');
  assert.equal(H.git(fresh, ['rev-parse', 'HEAD']), snap.base);
  assert.equal(fs.readFileSync(path.join(fresh, 'a.txt'), 'utf8'), 'changed\n');
  assert.equal(fs.readFileSync(path.join(fresh, 'b.txt'), 'utf8'), 'b\n');
  assert.match(H.git(fresh, ['status', '--porcelain']), /M a\.txt/);
  // a clone with local changes keeps them: only the branch arrives
  const dirty = tmp(t, 'dirty');
  H.git(dirty, ['clone', '-q', a, '.']);
  fs.writeFileSync(path.join(dirty, 'a.txt'), 'mine\n');
  assert.ok(H.sameRepo(dirty, g));
  await H.receiveCode(dirty, g, file);
  assert.equal(H.restoreWip(dirty, g), 'branch-only');
  assert.equal(fs.readFileSync(path.join(dirty, 'a.txt'), 'utf8'), 'mine\n');
  assert.equal(H.git(dirty, ['rev-parse', snap.wip]), snap.commit);
  // a different repository is not the same repo; a non-empty foreign folder is refused
  const other = repo(t, 'other');
  H.git(other, ['commit', '-q', '--allow-empty', '-m', 'x']);
  const otherRoot = H.gitInfo(other).root;
  assert.equal(H.sameRepo(other, { ...g, root: otherRoot === g.root ? 'f'.repeat(40) : g.root }), false);
  const junk = tmp(t, 'junk');
  fs.writeFileSync(path.join(junk, 'x'), '1');
  await assert.rejects(H.receiveCode(junk, g, file), /not-empty/);
  assert.equal(H.defaultTarget({ dir: junk, git: g }), null);
});

test('handoff: slugs, path rewrite, settings and remote URLs', () => {
  assert.equal(H.slugOf('/Users/me/my proj'), '-Users-me-my-proj');
  const line = JSON.stringify({ cwd: '/Users/me/proj', file: '/Users/me/proj/src/a.js', other: '/Users/me/project2/x', note: 'in /Users/me/proj, ok' });
  const out = JSON.parse(H.rewritePaths(line, '/Users/me/proj', '/home/me/work/proj'));
  assert.equal(out.cwd, '/home/me/work/proj');
  assert.equal(out.file, '/home/me/work/proj/src/a.js');
  assert.equal(out.other, '/Users/me/project2/x');
  assert.equal(out.note, 'in /home/me/work/proj, ok');
  assert.equal(H.rewritePaths('C:\\\\a\\\\b', 'C:\\a\\b', 'D:\\c'), 'D:\\\\c');
  assert.deepEqual(H.cleanSettings({ manager: true, savings: { cache: 1 }, accountId: 'x', oauthAccount: { k: 1 }, primaryApiKey: 'sk' }), { manager: true, savings: { cache: 1 } });
  assert.equal(H.safeRemote('https://user:ghp_token@github.com/a/b.git'), 'https://github.com/a/b.git');
  assert.equal(H.safeRemote('git@github.com:a/b.git'), 'git@github.com:a/b.git');
});

test('handoff: paths outside the target folders are rejected, whole pack', (t) => {
  for (const bad of ['../x', '/etc/passwd', 'a/../../b', 'a\\..\\b', 'C:/x', '', 'a//b', './a', 'a\0b']) assert.equal(H.safeRel(bad), false, bad);
  assert.equal(H.inside('/base', '../x'), null);
  assert.equal(H.inside('/base', 'a/b.jsonl'), path.resolve('/base/a/b.jsonl'));
  const pack = (files) => Buffer.from(JSON.stringify({ v: 1, dir: '/old', settings: {}, sessionIds: ['s1'], files }));
  const ok = { area: 'projects', rel: 's1.jsonl', data: Buffer.from('{"cwd":"/old"}\n').toString('base64') };
  assert.ok(H.parsePack(pack([ok])));
  assert.equal(H.parsePack(pack([ok, { area: 'projects', rel: '../../.credentials.json', data: '' }])), null);
  assert.equal(H.parsePack(pack([{ area: 'home', rel: 'x', data: '' }])), null);
  assert.equal(H.parsePack(pack([{ area: 'facts', rel: 'other.md', data: '' }])), null);
  assert.equal(H.parsePack(Buffer.from('{"v":1,"dir":"/old","files":[],"sessionIds":["../x"]}')), null);
  assert.equal(H.parsePack(Buffer.from('nope')), null);
  // pack → write: under the new slug, paths rewritten, a continued transcript replaces, a foreign one gets lines
  const root = tmp(t, 'cfg');
  const src = path.join(root, 'projects', H.slugOf('/old'));
  fs.mkdirSync(path.join(src, 's1', 'subagents'), { recursive: true });
  fs.writeFileSync(path.join(src, 's1.jsonl'), '{"cwd":"/old"}\n');
  fs.writeFileSync(path.join(src, 's1', 'subagents', 'agent-1.jsonl'), '{"cwd":"/old/sub"}\n');
  fs.writeFileSync(path.join(src, 'other.jsonl'), 'not sent\n');
  const mem = path.join(root, 'mem');
  fs.mkdirSync(mem);
  fs.writeFileSync(path.join(mem, 'MEMORY.md'), '- see /old/README\n');
  const facts = path.join(root, 'facts.md');
  fs.writeFileSync(facts, '# old: facts\n');
  fs.writeFileSync(path.join(root, '.credentials.json'), '{"secret":1}');
  const buf = H.packSession({ root, dir: '/old', sessionIds: ['s1', 'missing', '../x'], memoryDir: mem, factsFile: facts, settings: { manager: true } });
  assert.ok(!buf.toString().includes('secret'));
  const p = H.parsePack(buf);
  assert.deepEqual(p.sessionIds, ['s1']);
  const dst = tmp(t, 'cfg2');
  const r = H.writeSession(p, { from: '/old', to: '/new/place', root: dst, memoryDir: path.join(dst, 'm'), factsFile: path.join(dst, 'f', 'place.md') });
  assert.equal(r.written, 4);
  const slug = path.join(dst, 'projects', H.slugOf('/new/place'));
  assert.equal(fs.readFileSync(path.join(slug, 's1.jsonl'), 'utf8'), '{"cwd":"/new/place"}\n');
  assert.equal(fs.readFileSync(path.join(slug, 's1', 'subagents', 'agent-1.jsonl'), 'utf8'), '{"cwd":"/new/place/sub"}\n');
  assert.ok(!fs.existsSync(path.join(slug, 'other.jsonl')));
  assert.equal(fs.readFileSync(path.join(dst, 'm', 'MEMORY.md'), 'utf8'), '- see /new/place/README\n');
  assert.equal(fs.readFileSync(path.join(dst, 'f', 'place.md'), 'utf8'), '# old: facts\n');
  assert.throws(() => H.writeSession({ files: [{ area: 'projects', rel: '../evil', data: '' }] }, { from: '/a', to: '/b', root: dst, memoryDir: dst, factsFile: path.join(dst, 'x') }), /bad-path/);
});

test('handoff: refusals (busy, engine, not git, offline) and the offer schema', () => {
  assert.equal(H.refusal({ engine: 'claude', git: true, busy: true, online: true }), 'busy');
  assert.equal(H.refusal({ engine: 'agy', git: true, online: true }), 'engine');
  assert.equal(H.refusal({ engine: 'claude', git: false, online: true }), 'not-git');
  assert.equal(H.refusal({ engine: 'claude', git: true, online: false }), 'offline');
  assert.equal(H.refusal({ engine: 'claude', git: true, busy: false, online: true }), null);
  const sha = 'a'.repeat(64);
  const offer = { t: 'ho-offer', id: 'abc', name: 'shop', dir: '/x/shop', engine: 'claude', git: { mode: 'bundle', wip: 'agent-office/handoff-20261020100000123', base: 'b'.repeat(40), root: 'c'.repeat(40), branch: 'main', remote: '' }, pack: { size: 10, sha }, bundle: { size: 10, sha } };
  assert.ok(C.validateMessage(offer));
  assert.equal(C.validateMessage({ ...offer, engine: 'agy' }), null);
  assert.equal(C.validateMessage({ ...offer, git: { ...offer.git, wip: 'main' } }), null);
  assert.equal(C.validateMessage({ ...offer, git: { ...offer.git, branch: '--upload-pack=x' } }), null);
  assert.equal(C.validateMessage({ ...offer, git: { ...offer.git, branch: 'a/../b' } }), null);
  assert.equal(C.validateMessage({ ...offer, git: { ...offer.git, mode: 'remote', remote: '-oProxy=x' } }), null);
  assert.equal(C.validateMessage({ ...offer, bundle: { size: C.MAX_BUNDLE + 1, sha } }), null);
  assert.equal(C.validateMessage({ ...offer, bundle: null }), null);                 // bundle mode needs a bundle
  assert.equal(C.validateMessage({ t: 'ho-chunk', id: 'abc', part: 'pack', seq: 0, data: 'not base64!' }), null);
  assert.equal(C.validateMessage({ t: 'ho-chunk', id: 'abc', part: 'pack', seq: 0, data: 'A'.repeat(C.CHUNK * 2) }), null);
  assert.equal(C.validateMessage({ t: 'ho-result', id: 'abc', ok: false, reason: 'whatever' }), null);
  assert.ok(C.encode({ t: 'ho-chunk', id: 'abc', part: 'bundle', seq: 99999, data: Buffer.alloc(C.CHUNK, 255).toString('base64') }));
  assert.deepEqual(C.normalizeDevices([{ pub: pubA, name: 'x', allowHandoff: 'yes' }])[0].allowHandoff, false);
});

test('integration: a full handoff over the link (opt-in refused first, then bundle + sessions applied)', { timeout: 60000 }, async (t) => {
  const createTestnet = require('hyperdht/testnet');
  const DHT = require('hyperdht');
  const testnet = await createTestnet(3);
  t.after(() => testnet.destroy());
  const a = new Link({ keyPair: DHT.keyPair(), name: 'Studio', bootstrap: testnet.bootstrap });
  const b = new Link({ keyPair: DHT.keyPair(), name: 'Laptop', bootstrap: testnet.bootstrap });
  t.after(() => Promise.all([a.destroy(), b.destroy()]));
  const until = (fn, ms = 20000) => new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => { const v = fn(); if (v) return resolve(v); if (Date.now() - t0 > ms) return reject(new Error('timeout')); setTimeout(tick, 20); };
    tick();
  });
  const { code } = await a.invite();
  await b.join(code);
  await until(() => a.view().devices[0]?.online && b.view().devices[0]?.online);

  // the sender's project: a repo with uncommitted work, a transcript, ~200 KB of history to need many chunks
  const src = repo(t, 'proj');
  fs.writeFileSync(path.join(src, 'big.bin'), crypto.randomBytes(200 * 1024));
  H.git(src, ['add', '-A']);
  H.git(src, ['commit', '-q', '-m', 'big']);
  fs.writeFileSync(path.join(src, 'a.txt'), 'wip\n');
  const cfgA = tmp(t, 'cfgA');
  fs.mkdirSync(path.join(cfgA, 'projects', H.slugOf(src)), { recursive: true });
  fs.writeFileSync(path.join(cfgA, 'projects', H.slugOf(src), 'sess-1.jsonl'), `${JSON.stringify({ cwd: src, sessionId: 'sess-1' })}\n`);
  const before = state(src);
  const snap = H.snapshotWip(src);
  assert.deepEqual(state(src), before);
  const bundle = H.createBundle(snap, tmp(t, 'b'));
  const pack = H.packSession({ root: cfgA, dir: src, sessionIds: ['sess-1'], settings: { manager: true } });
  const offer = { name: 'proj', dir: src, git: { mode: 'bundle', wip: snap.wip, base: snap.base, root: snap.root, branch: snap.branch, remote: '' } };

  // opt-in: b has not allowed handoffs from a
  const refused = await a.offerHandoff(b.pub, offer, { pack, bundle });
  assert.deepEqual(refused, { ok: false, reason: 'not-allowed' });
  b.setAllowHandoff(a.pub, true);

  // b accepts and applies into a new folder under its own config dir
  const dstParent = tmp(t, 'dst');
  const dst = path.join(dstParent, 'proj');
  const cfgB = tmp(t, 'cfgB');
  b.on('handoff-offer', ({ offer: o }) => { assert.equal(o.name, 'proj'); b.answerHandoff(o.id, true); });
  b.on('handoff-data', async ({ offer: o, parts, done }) => {
    const file = path.join(dstParent, 'in.bundle');
    fs.writeFileSync(file, parts.bundle);
    await H.receiveCode(dst, o.git, file);
    const applied = H.restoreWip(dst, o.git);
    H.writeSession(H.parsePack(parts.pack), { from: o.dir, to: dst, root: cfgB, memoryDir: path.join(cfgB, 'mem'), factsFile: path.join(cfgB, 'facts.md') });
    done({ ok: true, applied });
  });
  const r = await a.offerHandoff(b.pub, offer, { pack, bundle });
  assert.deepEqual(r, { ok: true, applied: 'restored' });
  assert.equal(a.view().handoffs.out.at(-1).stage, 'done');
  assert.equal(b.view().handoffs.in.length, 0);
  assert.equal(fs.readFileSync(path.join(dst, 'a.txt'), 'utf8'), 'wip\n');
  assert.ok(fs.readFileSync(path.join(dst, 'big.bin')).equals(fs.readFileSync(path.join(src, 'big.bin'))));
  const moved = JSON.parse(fs.readFileSync(path.join(cfgB, 'projects', H.slugOf(dst), 'sess-1.jsonl'), 'utf8'));
  assert.equal(moved.cwd, dst);

});

// --- handoff review fixes: bundle first, subfolder, changes during the transfer, timeouts, drop before adopt
test('handoff: the code goes as a bundle when it fits; a push only above the cap, confirmed, with hooks, deleted after', async (t) => {
  const src = repo(t, 'bf');
  const bare = tmp(t, 'bare');
  H.git(bare, ['init', '-q', '--bare']);
  H.git(src, ['remote', 'add', 'origin', bare]);
  H.git(src, ['push', '-q', 'origin', 'main']);
  H.git(src, ['branch', '-q', '--set-upstream-to', 'origin/main']);
  fs.writeFileSync(path.join(src, 'a.txt'), 'wip\n');
  const marker = path.join(tmp(t, 'mk'), 'pre-push-ran');
  fs.writeFileSync(path.join(src, '.git', 'hooks', 'pre-push'), `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
  const snap = H.snapshotWip(src);
  const asked = [];
  const confirmPush = (url) => { asked.push(url); return true; };
  const small = await H.prepareCode(snap, tmp(t, 'b1'), { confirmPush });
  assert.equal(small.mode, 'bundle');
  assert.ok(small.bundle.length > 0);
  assert.deepEqual(asked, []);
  assert.equal(H.git(bare, ['branch', '--list', snap.wip]), '', 'nothing pushed when the bundle fits');
  const declined = await H.prepareCode(snap, tmp(t, 'b2'), { confirmPush: () => false, maxBundle: 1 });
  assert.deepEqual(declined, { reason: 'push-declined' });
  const big = await H.prepareCode(snap, tmp(t, 'b3'), { confirmPush, maxBundle: 1 });
  assert.deepEqual(big, { mode: 'remote', bundle: null });
  assert.deepEqual(asked, [bare]);
  assert.ok(fs.existsSync(marker), 'the pre-push hook ran (no --no-verify)');
  assert.match(H.git(bare, ['branch', '--list', snap.wip]), /handoff/);
  assert.equal(await H.deleteRemoteWip(snap), true);
  assert.equal(H.git(bare, ['branch', '--list', snap.wip]), '');
  // no remote at all and too big: too-large, nobody asked
  const lone = repo(t, 'lone');
  assert.deepEqual(await H.prepareCode(H.snapshotWip(lone), tmp(t, 'b4'), { confirmPush: () => assert.fail('asked'), maxBundle: 1 }), { reason: 'too-large' });
});

test('handoff: a subfolder of a larger repository is refused; changes after the snapshot are detected', (t) => {
  const d = repo(t, 'sub');
  const sub = path.join(d, 'pkg');
  fs.mkdirSync(sub);
  assert.equal(H.isRepoRoot(d), true);
  assert.equal(H.isRepoRoot(sub), false);
  assert.equal(H.refusal({ engine: 'claude', git: true, subfolder: true, online: true }), 'subfolder');
  assert.equal(H.refusal({ engine: 'claude', git: true, subfolder: false, online: true }), null);
  fs.writeFileSync(path.join(d, 'a.txt'), 'wip\n');
  const snap = H.snapshotWip(d);
  assert.equal(H.changedSince(snap, d), null);
  fs.writeFileSync(path.join(d, 'a.txt'), 'wip more\n');               // an already-changed file changed again
  assert.equal(H.changedSince(snap, d), 'changed');
  fs.writeFileSync(path.join(d, 'a.txt'), 'wip\n');
  assert.equal(H.changedSince(snap, d), null);
  fs.writeFileSync(path.join(d, 'new.txt'), 'x\n');                     // a new untracked file
  assert.equal(H.changedSince(snap, d), 'changed');
  fs.rmSync(path.join(d, 'new.txt'));
  H.git(d, ['commit', '-q', '-am', 'during']);                         // a commit
  assert.equal(H.changedSince(snap, d), 'changed');
});

test('integration: handoff timeouts reach the receiver, busy/changed aborts, a dropped receiver does not adopt', { timeout: 60000 }, async (t) => {
  const createTestnet = require('hyperdht/testnet');
  const DHT = require('hyperdht');
  const testnet = await createTestnet(3);
  t.after(() => testnet.destroy());
  const a = new Link({ keyPair: DHT.keyPair(), name: 'Studio', bootstrap: testnet.bootstrap });
  const b = new Link({ keyPair: DHT.keyPair(), name: 'Laptop', bootstrap: testnet.bootstrap });
  t.after(() => Promise.all([a.destroy(), b.destroy()]));
  const until = (fn, ms = 20000) => new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => { const v = fn(); if (v) return resolve(v); if (Date.now() - t0 > ms) return reject(new Error('timeout')); setTimeout(tick, 20); };
    tick();
  });
  const { code } = await a.invite();
  await b.join(code);
  await until(() => a.view().devices[0]?.online && b.view().devices[0]?.online);
  b.setAllowHandoff(a.pub, true);
  const pack = Buffer.from(JSON.stringify({ v: 1, dir: '/x/p', settings: {}, sessionIds: [], files: [] }));
  const offer = { name: 'p', dir: '/x/p', git: { mode: 'remote', wip: 'agent-office/handoff-20261020100000123', base: 'b'.repeat(40), root: 'c'.repeat(40), branch: 'main', remote: 'https://example.com/r.git' } };

  // 1. the sender's answer timeout is told to the receiver: its offer card goes away
  const r1 = await a.offerHandoff(b.pub, offer, { pack }, { answerMs: 300 });
  assert.deepEqual(r1, { ok: false, reason: 'timeout' });
  await until(() => b.handoffsIn.size === 0);

  // 2. the receiver's own timer: an offer nobody answers is declined with timeout
  b.handoffAskMs = 300;
  const r2 = await a.offerHandoff(b.pub, offer, { pack });
  assert.deepEqual(r2, { ok: false, reason: 'timeout' });
  assert.equal(b.handoffsIn.size, 0);
  b.handoffAskMs = 10 * 60 * 1000;

  // 3. busy / changed just before sending: aborted, nothing sent, the receiver drops it
  const onOffer = ({ offer: o }) => b.answerHandoff(o.id, true);
  b.on('handoff-offer', onOffer);
  let gotData = false;
  const onData = () => { gotData = true; };
  b.on('handoff-data', onData);
  const r3 = await a.offerHandoff(b.pub, offer, { pack }, { beforeSend: async () => 'changed' });
  assert.deepEqual(r3, { ok: false, reason: 'changed' });
  await until(() => b.handoffsIn.size === 0);
  assert.equal(gotData, false);
  b.off('handoff-data', onData);

  // 4. the sender times out while the receiver applies: unknown on the sender, alive() false on the receiver (no
  //    adopt), and the receiver's result arrives late
  let pending = null;
  b.on('handoff-data', (x) => { pending = x; });
  const late = new Promise((resolve) => a.once('handoff-late-result', resolve));
  const r4 = await a.offerHandoff(b.pub, offer, { pack }, { resultMs: 500 });
  assert.equal(r4.ok, false);
  assert.equal(r4.reason, 'timeout');
  assert.equal(r4.unknown, true);
  assert.match(r4.id, /^[0-9a-f]{16}$/);
  assert.equal(a.view().handoffs.out.at(-1).stage, 'unknown');
  await until(() => pending && pending.alive() === false);
  pending.done({ ok: false, reason: 'cancelled' });
  const lr = await late;
  assert.equal(lr.id, r4.id);
  assert.equal(lr.ok, false);
  assert.equal(b.handoffsIn.size, 0);
});

test('integration: a persisted handoff result survives a Link restart and answers ho-query', { timeout: 90000 }, async (t) => {
  const createTestnet = require('hyperdht/testnet');
  const DHT = require('hyperdht');
  const testnet = await createTestnet(3);
  t.after(() => testnet.destroy());
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-hores-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const resultsFile = path.join(tmp, 'link', 'handoff-results.json');
  const a = new Link({ keyPair: DHT.keyPair(), name: 'Studio', bootstrap: testnet.bootstrap });
  let b = new Link({ keyPair: DHT.keyPair(), name: 'Laptop', bootstrap: testnet.bootstrap, resultsFile });
  t.after(() => Promise.all([a.destroy(), b.destroy()]));
  const until = (fn, ms = 30000) => new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => { const v = fn(); if (v) return resolve(v); if (Date.now() - t0 > ms) return reject(new Error('timeout')); setTimeout(tick, 20); };
    tick();
  });
  const { code } = await a.invite();
  await b.join(code);
  await until(() => a.view().devices[0]?.online && b.view().devices[0]?.online);
  b.setAllowHandoff(a.pub, true);
  b.on('handoff-offer', ({ offer: o }) => b.answerHandoff(o.id, true));
  let pending = null;
  b.on('handoff-data', (x) => { pending = x; });
  const pack = Buffer.from(JSON.stringify({ v: 1, dir: '/x/p', settings: {}, sessionIds: [], files: [] }));
  const offer = { name: 'p', dir: '/x/p', git: { mode: 'remote', wip: 'agent-office/handoff-20261020100000123', base: 'b'.repeat(40), root: 'c'.repeat(40), branch: 'main', remote: 'https://example.com/r.git' } };
  const r = await a.offerHandoff(b.pub, offer, { pack }, { resultMs: 500 });
  assert.equal(r.unknown, true);
  await until(() => pending);
  // the apply started and is on disk; the receiver dies before it finishes (no result was ever sent)
  assert.equal(JSON.parse(fs.readFileSync(resultsFile, 'utf8'))[r.id].status, 'applying');
  const restart = async () => {
    const keep = { keyPair: b.keyPair, devices: b.devices, secrets: b.secrets };
    await b.destroy();
    b = new Link({ ...keep, name: 'Laptop', bootstrap: testnet.bootstrap, resultsFile });
    b.ensureSwarm();
    await until(() => a.view().devices[0]?.online && b.view().devices[0]?.online);
  };
  const ask = (id) => { const p = new Promise((resolve) => a.once('handoff-status', resolve)); assert.equal(a.queryHandoff(b.pub, id), true); return p; };
  await restart();
  assert.equal(b.results.get(r.id).status, 'unknown');
  const s1 = await ask(r.id);
  assert.deepEqual([s1.id, s1.status], [r.id, 'unknown']);
  assert.equal((await ask('0123456789abcdef')).status, 'not-applied');   // never got as far as applying
  assert.equal(C.validateMessage({ t: 'ho-status', id: 'x', status: 'maybe' }), null);
  assert.equal(C.validateMessage({ t: 'ho-query', id: '../x' }), null);

  // an outcome decided while the sender was away is kept on disk, sent once it is back (also after a restart),
  // and still answers ho-query afterwards
  const late = new Promise((resolve) => a.once('handoff-late-result', resolve));
  b.setResult(r.id, a.pub, 'applied', { applied: 'restored' });
  assert.equal(b.results.get(r.id).sent, false);
  await restart();
  const lr = await late;
  assert.deepEqual([lr.id, lr.ok, lr.applied], [r.id, true, 'restored']);
  await until(() => b.results.get(r.id)?.sent === true);
  const s2 = await ask(r.id);
  assert.deepEqual([s2.status, s2.applied], ['applied', 'restored']);
  const rec = JSON.parse(fs.readFileSync(resultsFile, 'utf8'))[r.id];
  assert.deepEqual(Object.keys(rec).sort(), ['applied', 'at', 'pub', 'sent', 'status']);   // nothing secret
});

test('handoff: Keep it here unlocks a project whose handoff outcome is unknown (after the warning)', async (t) => {
  const { setupLink } = require('../src/link-host.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-hokeep-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const dir = path.join(tmp, 'link');
  fs.mkdirSync(dir, { recursive: true });
  const folder = path.join(tmp, 'proj');
  const pub = 'ab'.repeat(32);
  fs.writeFileSync(path.join(dir, 'owners.json'), JSON.stringify({ [folder]: { owner: 'unknown', ownerName: 'Laptop', project: 'proj', at: 1, handoffId: '0123456789abcdef', pub, projectId: 'p1' } }));
  fs.writeFileSync(path.join(dir, 'devices.json'), JSON.stringify({ name: 'Studio', devices: [] }));
  const handlers = {};
  const locks = [];
  let answer = false;
  const host = setupLink({
    app: { getPath: () => tmp },
    safeStorage: { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'keychain', encryptString: (s) => Buffer.from(s), decryptString: (b) => b.toString() },
    ipcMain: { handle: (ch, fn) => { handlers[ch] = fn; } },
    send: () => {}, notify: () => {}, T: (k) => k, projects: () => [], tabState: () => 'gone', type: () => {},
    handoff: { lock: (id, on) => locks.push([id, on]), release: () => {}, describe: () => null, confirmPush: async () => false, confirmKeep: async () => answer, target: () => ({}), adopt: () => {}, pickFolder: async () => null },
  });
  t.after(() => host.destroy());
  assert.deepEqual(locks, [['p1', true]]);                          // re-locked at start
  assert.deepEqual(host.unknownFor('p1'), { dir: folder, project: 'proj', deviceName: 'Laptop', online: false });
  assert.equal(host.askAgain(folder), false);                        // the receiver is offline
  const v0 = await handlers['link:handoffKeep'](null, folder);       // the person said Cancel
  assert.equal(v0.owners[0].unknown, true);
  assert.deepEqual(locks, [['p1', true]]);
  answer = true;
  const v1 = await handlers['link:handoffKeep'](null, folder);
  assert.deepEqual(v1.owners, []);
  assert.deepEqual(locks.at(-1), ['p1', false]);
  assert.equal(host.unknownFor('p1'), null);
  const log = fs.readFileSync(path.join(dir, 'handoff.log'), 'utf8');
  assert.match(log, /"outcome":"query:offline"/);
  assert.match(log, /"outcome":"kept-here"/);
});
