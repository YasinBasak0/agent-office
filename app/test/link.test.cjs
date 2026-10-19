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
