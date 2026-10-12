// Main's pure state logic: node --test test/main.test.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../src/projects.js');
const A = require('../src/accounts.js');
const L = require('../src/locales.js');
const UP = require('../src/updates.js');

const LOCALES = L.loadLocales();
/** a language's translator, as in main (src/i18n.mjs) */
const tFor = async (lang) => (await import('../src/i18n.mjs')).translator(LOCALES[lang], LOCALES.en, lang);

let n = 0;
const id = () => `p${++n}`;
const empty = () => P.normalizeState({}, { id });

test('boş durum: yalnız varsayılan hesap, proje yok', () => {
  const s = empty();
  assert.deepEqual(s.projects, []);
  assert.equal(s.activeId, null);
  assert.deepEqual(s.accounts, [{ id: 'default', label: 'Varsayılan', configDir: null }]);
});

test('göç: eski lastProject ilk proje ve etkin olur', () => {
  const s = P.normalizeState({ lastProject: '/a/b/proj' }, { id: () => 'x1' });
  assert.deepEqual(s.projects, [{ id: 'x1', dir: '/a/b/proj', name: 'proj', accountId: 'default' }]);
  assert.equal(s.activeId, 'x1');
});

test('göç: projeler varsa lastProject yok sayılır', () => {
  const s = P.normalizeState({ lastProject: '/old', projects: [{ id: 'k', dir: '/new', accountId: 'default' }], activeId: 'k' });
  assert.deepEqual(s.projects.map((p) => p.dir), ['/new']);
});

test('normalize: bozuk kayıtlar, yinelenen klasör, bilinmeyen hesap ve etkin id düzeltilir', () => {
  const s = P.normalizeState({
    projects: [null, { dir: '' }, { id: 'a', dir: '/x', accountId: 'gone' }, { id: 'b', dir: '/x' }, { dir: '/y', accountId: 'w' }],
    accounts: [{ id: 'default', label: 'eski', configDir: '/z' }, { id: 'w', label: ' İş ', configDir: '/acc/w' }, { id: 'bad' }],
    activeId: 'nope',
  }, { id });
  assert.equal(s.projects.length, 2);
  assert.equal(s.projects[0].accountId, 'default');
  assert.equal(s.projects[1].accountId, 'w');
  assert.ok(s.projects[1].id);
  assert.equal(s.activeId, 'a');
  assert.deepEqual(s.accounts, [A.DEFAULT_ACCOUNT, { id: 'w', label: 'İş', configDir: '/acc/w' }]);
});

test('ekle: yeni klasör eklenir ve etkinleşir; listedeki klasör yalnızca etkinleşir', () => {
  let r = P.addProject(empty(), '/p/one', { id: () => 'one' });
  assert.equal(r.isNew, true);
  assert.equal(r.state.activeId, 'one');
  assert.equal(r.project.name, 'one');
  r = P.addProject(r.state, '/p/two', { id: () => 'two' });
  assert.equal(r.state.activeId, 'two');
  const again = P.addProject(r.state, '/p/one', { id: () => 'dup' });
  assert.equal(again.isNew, false);
  assert.equal(again.project.id, 'one');
  assert.equal(again.state.activeId, 'one');
  assert.equal(again.state.projects.length, 2);
});

test('sil: etkin proje silinince komşusu etkinleşir; sonuncusu silinince null', () => {
  let s = empty();
  for (const d of ['a', 'b', 'c']) s = P.addProject(s, '/' + d, { id: () => d }).state;
  s = P.setActive(s, 'b');
  s = P.removeProject(s, 'b');
  assert.equal(s.activeId, 'c');
  s = P.removeProject(s, 'c');
  assert.equal(s.activeId, 'a');
  s = P.removeProject(s, 'zzz');
  assert.equal(s.projects.length, 1);
  s = P.removeProject(s, 'a');
  assert.equal(s.activeId, null);
});

test('etkinleştir / hesap ata: bilinmeyen id değişiklik yapmaz', () => {
  let s = P.addProject(empty(), '/a', { id: () => 'a' }).state;
  assert.equal(P.setActive(s, 'none'), s);
  assert.equal(P.setProjectAccount(s, 'a', 'none'), s);
  s = A.addAccount(s, 'İş', { id: 'w', root: '/u/accounts' }).state;
  s = P.setProjectAccount(s, 'a', 'w');
  assert.equal(s.projects[0].accountId, 'w');
});

test('hesap ekle / yeniden adlandır: configDir = root/id, varsayılan adlandırılamaz', () => {
  let r = A.addAccount(empty(), '  Kişisel ', { id: 'k1', root: '/u/accounts' });
  assert.deepEqual(r.account, { id: 'k1', label: 'Kişisel', configDir: '/u/accounts/k1' });
  const blank = A.addAccount(r.state, '   ', { id: 'k2', root: '/u/accounts' });
  assert.equal(blank.account.label, 'Hesap 2');
  let s = A.renameAccount(r.state, 'k1', 'Ev');
  assert.equal(s.accounts[1].label, 'Ev');
  assert.equal(A.renameAccount(s, 'default', 'X'), s);
  assert.equal(A.renameAccount(s, 'k1', '  '), s);
});

test('hesap sil: projeleri varsayılana geçer ve yeniden başlatılacaklar döner', () => {
  let s = empty();
  s = A.addAccount(s, 'İş', { id: 'w', root: '/r' }).state;
  for (const d of ['a', 'b', 'c']) s = P.addProject(s, '/' + d, { id: () => d }).state;
  s = P.setProjectAccount(s, 'a', 'w');
  s = P.setProjectAccount(s, 'c', 'w');
  const r = A.removeAccount(s, 'w');
  assert.deepEqual(r.moved, ['a', 'c']);
  assert.ok(r.state.projects.every((p) => p.accountId === 'default'));
  assert.deepEqual(r.state.accounts.map((a) => a.id), ['default']);
  assert.equal(A.removeAccount(r.state, 'default').state, r.state);
  assert.deepEqual(A.removeAccount(r.state, 'nope').moved, []);
});

test('accountOf: bilinmeyen hesap varsayılana düşer', () => {
  const s = A.addAccount(empty(), 'İş', { id: 'w', root: '/r' }).state;
  assert.equal(A.accountOf(s, { accountId: 'w' }).configDir, '/r/w');
  assert.equal(A.accountOf(s, { accountId: 'gone' }).configDir, null);
});

test('ptyEnv: iç içe işaretleri ve üst CLAUDE_CONFIG_DIR atılır, hesabın klasörü verilir', () => {
  const base = { PATH: '/bin', CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_CODE_OAUTH_TOKEN: 't', CLAUDE_PID: '9', CLAUDE_CONFIG_DIR: '/parent', CLAUDE_EFFORT: 'x', ANTHROPIC_MODEL: 'm' };
  const def = A.ptyEnv(base, null);
  assert.equal(def.PATH, '/bin');
  assert.equal(def.ANTHROPIC_MODEL, 'm');
  assert.equal(def.TERM, 'xterm-256color');
  for (const k of ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_PID', 'CLAUDE_CONFIG_DIR', 'CLAUDE_EFFORT', 'AGENT_OFFICE_CONFIG_DIR']) {
    assert.equal(k in def, false, k);
  }
  const acc = A.ptyEnv(base, '/u/accounts/w');
  assert.equal(acc.CLAUDE_CONFIG_DIR, '/u/accounts/w');
  assert.equal(acc.AGENT_OFFICE_CONFIG_DIR, '/u/accounts/w');
  assert.equal(base.CLAUDE_CONFIG_DIR, '/parent');
});

test('sessionEnv: AGENT_OFFICE_APP her zaman, AGENT_OFFICE_MANAGER yalnız müdür modu açıkken', () => {
  const base = A.ptyEnv({ PATH: '/bin', AGENT_OFFICE_MANAGER: '1' }, null);
  const on = A.sessionEnv(base, { manager: true });
  assert.equal(on.AGENT_OFFICE_APP, '1');
  assert.equal(on.AGENT_OFFICE_MANAGER, '1');
  assert.equal(on.PATH, '/bin');
  assert.equal(A.sessionEnv(base).AGENT_OFFICE_MANAGER, '1'); // varsayılan açık
  const off = A.sessionEnv(base, { manager: false });
  assert.equal(off.AGENT_OFFICE_APP, '1');
  assert.equal('AGENT_OFFICE_MANAGER' in off, false); // uygulamanın kendi ortamından gelse bile
  assert.equal(base.AGENT_OFFICE_MANAGER, '1'); // girdi değişmez
});

test('lastJsonObject: gürültü arasındaki son nesne, dizgedeki parantezler, iç içe nesneler', () => {
  const pretty = JSON.stringify({ loggedIn: false, authMethod: 'none', nested: { a: 1 } }, null, 2);
  assert.deepEqual(A.lastJsonObject(`rc: hello {not json}\n${pretty}\nbye`), { loggedIn: false, authMethod: 'none', nested: { a: 1 } });
  assert.deepEqual(A.lastJsonObject('{"a":1}\n{"b":"x}{\\"y"}'), { b: 'x}{"y' });
  assert.deepEqual(A.lastJsonObject('{"a":1} trailing { broken'), { a: 1 });
  assert.equal(A.lastJsonObject(''), null);
  assert.equal(A.lastJsonObject('no json here [1,2]'), null);
  assert.equal(A.lastJsonObject(undefined), null);
});

test('authFromStatus: girişli, girişsiz, bozuk', () => {
  assert.deepEqual(A.authFromStatus({ loggedIn: true, authMethod: 'claude.ai', email: 'a@b.c', configDirectory: '/x' }),
    { state: 'in', email: 'a@b.c', method: 'claude.ai' });
  assert.deepEqual(A.authFromStatus({ loggedIn: true }), { state: 'in' });
  assert.deepEqual(A.authFromStatus({ loggedIn: false, authMethod: 'none' }), { state: 'out' });
  assert.equal(A.authFromStatus({ loggedIn: 'yes' }).state, 'error');
  assert.equal(A.authFromStatus(null).state, 'error');
});

test('authFromRun: çıkış kodu sıfır değilse de JSON geçerli; zaman aşımı, claude yok, stderr', async () => {
  const tr = await tFor('tr');
  const en = await tFor('en');
  const code1 = Object.assign(new Error('Command failed'), { code: 1 });
  assert.deepEqual(A.authFromRun(code1, 'noise\n{"loggedIn": false}\n', ''), { state: 'out' });
  assert.deepEqual(A.authFromRun(null, '{"loggedIn": true, "email": "e@x"}', ''), { state: 'in', email: 'e@x' });
  const timeout = Object.assign(new Error('x'), { killed: true, signal: 'SIGKILL', code: null });
  assert.deepEqual(A.authFromRun(timeout, '', ''), { state: 'error', errorKey: 'timeout' });
  assert.deepEqual(A.localizeAuth(A.authFromRun(timeout, '', ''), tr), { state: 'error', error: 'zaman aşımı' });
  assert.deepEqual(A.localizeAuth(A.authFromRun(Object.assign(new Error('x'), { code: 127 }), '', 'zsh: command not found: claude'), en),
    { state: 'error', error: 'claude not found' });
  assert.deepEqual(A.localizeAuth({ state: 'in', email: 'e' }, en), { state: 'in', email: 'e' });
  assert.deepEqual(A.localizeAuth({ state: 'error', errorKey: 'yeni' }, tr), { state: 'error', error: 'yeni' });
  assert.deepEqual(A.authFromRun(code1, '', 'warn\nboom: bad thing\n'), { state: 'error', error: 'boom: bad thing' });
  assert.equal(A.authFromRun(code1, '', 'x'.repeat(500)).error.length, 118);
  assert.equal(A.authFromRun(null, 'hello', '').state, 'error');
});

test('withAuth / login id: auth bellekten eklenir, yoksa checking; state değişmez', () => {
  const s = A.addAccount(empty(), 'İş', { id: 'w', root: '/r' }).state;
  const auths = new Map([['default', { state: 'in', email: 'e' }]]);
  const out = A.withAuth(s.accounts, (id) => auths.get(id));
  assert.deepEqual(out.map((a) => a.auth.state), ['in', 'checking']);
  assert.equal('auth' in s.accounts[0], false);
  assert.equal(A.loginPtyId('w'), 'login:w');
  assert.equal(A.loginAccountId('login:w'), 'w');
  assert.equal(A.loginAccountId('p1'), null);
  assert.match(A.claudeCommand('auth status --json'), /export CLAUDE_CONFIG_DIR="\$AGENT_OFFICE_CONFIG_DIR"; exec claude auth status --json$/);
});

const U = require('../src/usage.js');

test('withAuth: kota varsa eklenir, yoksa alan yok', () => {
  const usage = { updatedAt: 1, fiveHour: { pct: 5 } };
  const out = A.withAuth([{ id: 'a' }, { id: 'b' }], () => ({ state: 'in' }), (id) => (id === 'a' ? usage : undefined));
  assert.deepEqual(out[0].usage, usage);
  assert.equal('usage' in out[1], false);
});

test('usageFromStatus: rate_limits → yüzde ve ms cinsinden sıfırlanma; yoksa null', () => {
  const st = { model: {}, rate_limits: { five_hour: { used_percentage: 6.4, resets_at: 1791586200 }, seven_day: { used_percentage: 124 } } };
  assert.deepEqual(U.usageFromStatus(st, 99), {
    updatedAt: 99, fiveHour: { pct: 6.4, resetsAt: 1791586200000 }, sevenDay: { pct: 100 },
  });
  assert.deepEqual(U.usageFromStatus({ rate_limits: { seven_day: { used_percentage: 0, resets_at: 2 } } }, 1),
    { updatedAt: 1, sevenDay: { pct: 0, resetsAt: 2000 } });
  assert.equal(U.usageFromStatus({ model: {} }, 1), null);
  assert.equal(U.usageFromStatus({ rate_limits: {} }, 1), null);
  assert.equal(U.usageFromStatus(undefined, 1), null);
});

test('usageFromCache: geçerli kayıt döner, bozuk olan null', () => {
  const u = { updatedAt: 5, sevenDay: { pct: 3 } };
  assert.equal(U.usageFromCache(u), u);
  assert.equal(U.usageFromCache({ updatedAt: 5 }), null);
  assert.equal(U.usageFromCache({ fiveHour: { pct: 1 } }), null);
  assert.equal(U.usageFromCache(undefined), null);
});

test('userStatusLine: ilk tanımlı statusLine kazanır; komut değilse null', () => {
  const cmd = { statusLine: { type: 'command', command: '~/sl.sh', padding: 0 } };
  assert.deepEqual(U.userStatusLine([undefined, {}, cmd]), { command: '~/sl.sh', padding: 0 });
  assert.deepEqual(U.userStatusLine([{ statusLine: { type: 'command', command: 'a' } }, cmd]), { command: 'a', padding: undefined });
  assert.equal(U.userStatusLine([{ statusLine: null }, cmd]), null);
  assert.equal(U.userStatusLine([{ statusLine: { type: 'command', command: ' ' } }, cmd]), null);
  assert.equal(U.userStatusLine([]), null);
});

test('settingsPaths: proje yerel, proje, hesap (yoksa ~/.claude)', () => {
  assert.deepEqual(U.settingsPaths('/p', null, '/h'), ['/p/.claude/settings.local.json', '/p/.claude/settings.json', '/h/.claude/settings.json']);
  assert.equal(U.settingsPaths('/p', '/acc', '/h')[2], '/acc/settings.json');
});

test('statusLineSettings: tırnaklı yollar, padding taşınır', () => {
  const s = JSON.parse(U.statusLineSettings("/x/Application Support/sl.sh", "/o/it's.json", { padding: 2 }));
  assert.deepEqual(s.statusLine, { type: 'command', command: `/bin/sh '/x/Application Support/sl.sh' '/o/it'\\''s.json'`, padding: 2 });
  assert.equal('padding' in JSON.parse(U.statusLineSettings('/a', '/b', null)).statusLine, false);
});

test('status line betiği: girdiyi dosyaya yazar, kullanıcının komutunu aynı girdiyle çalıştırır', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { execFileSync } = require('child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-sl-'));
  const script = path.join(dir, "s l.sh");
  fs.writeFileSync(script, U.SCRIPT);
  const out = path.join(dir, 'p.json');
  const cmd = JSON.parse(U.statusLineSettings(script, out, null)).statusLine.command;
  const input = JSON.stringify({ rate_limits: { five_hour: { used_percentage: 1 } } });
  const env = { PATH: process.env.PATH };
  assert.equal(execFileSync('/bin/sh', ['-c', cmd], { input, env }).toString(), '');
  assert.equal(fs.readFileSync(out, 'utf8'), input);
  const shown = execFileSync('/bin/sh', ['-c', cmd], { input, env: { ...env, AGENT_OFFICE_STATUSLINE: 'wc -c | tr -d " "' } }).toString();
  assert.equal(shown.trim(), String(input.length));
  assert.deepEqual(fs.readdirSync(dir).sort(), ['p.json', 's l.sh']);
  fs.rmSync(dir, { recursive: true });
});

const N = require('../src/attention.js');

test('nextAttention: izin ve bitiş bildirimi yalnız değişince, bakılan projede hiç; işaretler', () => {
  const projects = [{ id: 'a', name: 'alpha' }, { id: 'b', name: 'beta' }];
  const off = (aBusy, bWait) => [
    { name: 'alpha', isBossBusy: aBusy, waiting: null },
    { name: 'beta', isBossBusy: true, waiting: bWait },
  ];
  // first read: no event, but the open permission is marked
  let r = N.nextAttention(N.emptyAttention(), projects, off(true, { tool: 'Bash', since: 1 }), null);
  assert.deepEqual(r.events, []);
  assert.deepEqual([...r.attention], [['b', 'permission']]);
  // same permission: no event; new permission: event
  r = N.nextAttention(r.state, projects, off(true, { tool: 'Bash', since: 1 }), null);
  assert.deepEqual(r.events, []);
  r = N.nextAttention(r.state, projects, off(true, { tool: 'Edit', since: 2 }), null);
  assert.deepEqual(r.events, [{ kind: 'permission', id: 'b', tool: 'Edit' }]);
  // alpha's turn ended, not being looked at: 'done' event and marker; reading again gives no event, the marker stays
  r = N.nextAttention(r.state, projects, off(false, null), null);
  assert.deepEqual(r.events, [{ kind: 'done', id: 'a' }]);
  assert.deepEqual([...r.attention], [['a', 'done']]);
  r = N.nextAttention(r.state, projects, off(false, null), null);
  assert.deepEqual(r.events, []);
  assert.deepEqual([...r.attention], [['a', 'done']]);
  // looking at alpha clears the marker
  r = N.nextAttention(r.state, projects, off(false, null), 'a');
  assert.deepEqual([...r.attention], []);
  // no permission or done notification for the looked-at project
  r = N.nextAttention(r.state, projects, off(true, null), 'a');
  r = N.nextAttention(r.state, projects, off(false, { tool: 'Bash', since: 3 }), 'b');
  assert.deepEqual(r.events, [{ kind: 'done', id: 'a' }]);
  assert.deepEqual([...r.attention], [['a', 'done'], ['b', 'permission']]);
});

test('nextAttention: tur arka plan ajanları çalışırken biterse bitiş yok; ajanlar bitince bir kez', () => {
  const projects = [{ id: 'a', name: 'alpha' }];
  const off = (isBossBusy, working, waiting = null) => [{ name: 'alpha', working, delivered: 0, isBossBusy, waiting }];
  let r = N.nextAttention(N.emptyAttention(), projects, off(true, 2), null);
  // the main turn ends while two background agents still run: the boss waits for its agents, not for the user
  r = N.nextAttention(r.state, projects, off(false, 2), null);
  assert.deepEqual(r.events, []);
  assert.equal(r.attention.size, 0);
  r = N.nextAttention(r.state, projects, off(false, 1), null);
  assert.deepEqual(r.events, []);
  // a permission prompt from an agent still counts
  r = N.nextAttention(r.state, projects, off(false, 1, { tool: 'Bash', since: 4 }), null);
  assert.deepEqual(r.events, [{ kind: 'permission', id: 'a', tool: 'Bash' }]);
  r = N.nextAttention(r.state, projects, off(false, 1), null);
  assert.deepEqual(r.events, []);
  // the last agent finishes and the boss stays idle: 'done' once
  r = N.nextAttention(r.state, projects, off(false, 0), null);
  assert.deepEqual(r.events, [{ kind: 'done', id: 'a' }]);
  assert.deepEqual([...r.attention], [['a', 'done']]);
  r = N.nextAttention(r.state, projects, off(false, 0), null);
  assert.deepEqual(r.events, []);
  // the last agent finishes and Claude resumes a turn by itself: no 'done' until that turn ends
  r = N.nextAttention(N.emptyAttention(), projects, off(false, 1), null);
  r = N.nextAttention(r.state, projects, off(true, 0), null);
  assert.deepEqual(r.events, []);
  r = N.nextAttention(r.state, projects, off(false, 0), null);
  assert.deepEqual(r.events, [{ kind: 'done', id: 'a' }]);
});

test('usageAlerts: %80 ve %95 bir kez, sıfırlanınca yeniden; açılışta yalnız işaretler', () => {
  const NOW = 1000;
  const alerted = new Map();
  const u = (pct, resetsAt = 5000) => ({ updatedAt: 1, fiveHour: { pct, resetsAt }, sevenDay: { pct: 10, resetsAt: 9000 } });
  assert.deepEqual(N.usageAlerts('a', u(50), alerted, { now: NOW }), []);
  assert.deepEqual(N.usageAlerts('a', u(81), alerted, { now: NOW }), [{ window: 'fiveHour', pct: 81, level: 80, resetsAt: 5000 }]);
  assert.deepEqual(N.usageAlerts('a', u(85), alerted, { now: NOW }), []);
  assert.deepEqual(N.usageAlerts('a', u(96), alerted, { now: NOW }).map((x) => x.level), [95]);
  assert.deepEqual(N.usageAlerts('a', u(97), alerted, { now: NOW }), []);
  // a new window (different reset time) warns again; an expired window doesn't warn
  assert.deepEqual(N.usageAlerts('a', u(82, 8000), alerted, { now: NOW }).map((x) => x.level), [80]);
  assert.deepEqual(N.usageAlerts('a', u(99, 500), alerted, { now: NOW }), []);
  // seed: marks but doesn't announce
  const fresh = new Map();
  assert.deepEqual(N.usageAlerts('b', u(90), fresh, { seed: true, now: NOW }), []);
  assert.deepEqual(N.usageAlerts('b', u(91), fresh, { now: NOW }), []);
});

test('historyDir: Claude Code oturum klasörü, harf/rakam dışı karakterler "-"', () => {
  assert.equal(P.historyDir('/Users/a/Documents/my.app', null, '/Users/a'), '/Users/a/.claude/projects/-Users-a-Documents-my-app');
  assert.equal(P.historyDir('/Users/a/.claude/x_y', '/acc', '/Users/a'), '/acc/projects/-Users-a--claude-x-y');
});

const OS = require('../src/platform.js');

test('platform: kabuk $SHELL, yoksa macOS zsh, Linux bash', () => {
  assert.equal(OS.defaultShell({ SHELL: '/usr/bin/fish' }, 'linux'), '/usr/bin/fish');
  assert.equal(OS.defaultShell({}, 'darwin'), '/bin/zsh');
  assert.equal(OS.defaultShell({}, 'linux'), '/bin/bash');
  assert.equal(OS.isMac('darwin'), true);
  assert.equal(OS.isMac('linux'), false);
});

test('platform: Linux panosundaki dosyalar (uri-list, gnome-copied-files)', () => {
  assert.deepEqual(OS.filesFromUriList('copy\nfile:///home/a/b%20c.png\nfile:///tmp/x'), ['/home/a/b c.png', '/tmp/x']);
  assert.deepEqual(OS.filesFromUriList('# yorum\r\nfile://localhost/etc/hosts\r\nhttps://example.com/a\r\nfile://other-host/x\r\n'), ['/etc/hosts']);
  assert.deepEqual(OS.filesFromUriList(''), []);
  assert.deepEqual(OS.filesFromUriList('düz metin /home/a'), []);
});

test('platform: pano komutları Wayland\'de önce wl-paste, X11\'de önce xclip', () => {
  assert.equal(OS.linuxClipboardCommands({ WAYLAND_DISPLAY: 'wayland-0' })[0].cmd, 'wl-paste');
  assert.equal(OS.linuxClipboardCommands({})[0].cmd, 'xclip');
});

test('platform: kısayollar macOS ⌘ (rol kısayolları), Linux Ctrl+Shift', () => {
  assert.deepEqual(OS.shortcuts('darwin'), { paste: 'CmdOrCtrl+V', copy: null, cut: null });
  assert.deepEqual(OS.shortcuts('linux'), { paste: 'Ctrl+Shift+V', copy: 'Ctrl+Shift+C', cut: 'Ctrl+Shift+X' });
});

// ---- tabs and worktrees (contract v3.0)
const path = require('path');

test('normalize: eski dosyada tabs yok; bozuk, yinelenen ve ana (1) sekme atılır, worktree eksikse düz sekme', () => {
  const old = P.normalizeState({ projects: [{ id: 'a', dir: '/r/shop', accountId: 'default' }] });
  assert.equal('tabs' in old.projects[0], false);
  const wt = { root: '/r/shop-wt-3', repo: '/r/shop', branch: 'agent-office/3' };
  const s = P.normalizeState({ projects: [{ id: 'a', dir: '/r/shop', tabs: [
    null, { n: 1 }, { n: 'x' }, { n: 2 }, { n: 2, dir: '/dup' }, { n: 3, dir: '/r/shop-wt-3', worktree: wt, extra: 1 },
    { n: 4, dir: '/r/half', worktree: { root: '/r/half' } }, { n: 0 }, { n: 2.5 },
  ] }, { id: 'b', dir: '/r/x', tabs: 'bozuk' }] });
  assert.deepEqual(s.projects[0].tabs, [{ n: 2 }, { n: 3, dir: '/r/shop-wt-3', worktree: wt }, { n: 4 }]);
  assert.equal('tabs' in s.projects[1], false);
});

test('pty kimlikleri: ana sekme projectId, ek sekme <id>:<n>; giriş pty\'si ve bozuk kimlik null', () => {
  assert.equal(P.tabPtyId('abc'), 'abc');
  assert.equal(P.tabPtyId('abc', 1), 'abc');
  assert.equal(P.tabPtyId('abc', 3), 'abc:3');
  assert.deepEqual(P.parsePtyId('abc'), { projectId: 'abc', n: 1 });
  assert.deepEqual(P.parsePtyId('abc:3'), { projectId: 'abc', n: 3 });
  assert.equal(P.parsePtyId('abc:1'), null);
  assert.equal(P.parsePtyId('login:abc'), null);
  assert.equal(P.parsePtyId('login:abc:2'), null);
  assert.equal(P.parsePtyId(''), null);
  assert.deepEqual(P.ptyIdsOf({ id: 'abc', tabs: [{ n: 2 }, { n: 5 }] }), ['abc', 'abc:2', 'abc:5']);
  assert.deepEqual(P.ptyIdsOf({ id: 'abc' }), ['abc']);
});

test('sekme ekle / kaldır / çöz: ana sekme kaldırılamaz, son sekme gidince tabs alanı silinir', () => {
  let s = P.addProject(empty(), '/r/shop', { id: () => 'a' }).state;
  assert.equal(P.nextTabNumber(P.findProject(s, 'a')), 2);
  s = P.addTab(s, 'a', { n: 2 });
  const wt = { root: '/r/shop-wt-3', repo: '/r/shop', branch: 'agent-office/3' };
  s = P.addTab(s, 'a', { n: 3, dir: '/r/shop-wt-3', worktree: wt });
  assert.equal(P.addTab(s, 'a', { n: 3 }), s, 'aynı numara yok sayılır');
  assert.equal(P.addTab(s, 'a', { n: 1 }), s, 'ana sekme eklenmez');
  assert.equal(P.addTab(s, 'zz', { n: 9 }), s);
  assert.equal(P.nextTabNumber(P.findProject(s, 'a')), 4);
  assert.equal(P.nextTabNumber(P.findProject(s, 'a'), (k) => k < 6), 6, 'dolu numaralar atlanır');
  assert.deepEqual(P.resolvePty(s, 'a'), { project: P.findProject(s, 'a'), tab: null, dir: '/r/shop' });
  assert.equal(P.resolvePty(s, 'a:2').dir, '/r/shop', 'düz sekme proje klasöründe');
  assert.equal(P.resolvePty(s, 'a:3').dir, '/r/shop-wt-3');
  assert.equal(P.resolvePty(s, 'a:9'), null);
  assert.equal(P.resolvePty(s, 'login:a'), null);
  assert.equal(P.removeTab(s, 'a', 1), s, 'ana sekme kapanmaz');
  s = P.removeTab(s, 'a', 2);
  assert.deepEqual(P.findProject(s, 'a').tabs.map((t) => t.n), [3]);
  s = P.removeTab(s, 'a', 3);
  assert.equal('tabs' in P.findProject(s, 'a'), false);
  // account change and normalize keep the tabs
  s = P.addTab(s, 'a', { n: 2 });
  assert.deepEqual(P.setProjectAccount({ ...s, accounts: [...s.accounts, { id: 'w', label: 'w', configDir: '/w' }] }, 'a', 'w').projects[0].tabs, [{ n: 2 }]);
  assert.deepEqual(P.normalizeState(JSON.parse(JSON.stringify(s))).projects[0].tabs, [{ n: 2 }]);
});

test('worktree adlandırması: deponun yanında <depo>-wt-<n>, dal agent-office/<n>, alt klasör korunur', () => {
  assert.equal(P.worktreeRoot('/u/p/shop', 2), path.join('/u/p', 'shop-wt-2'));
  assert.equal(P.worktreeBranch(2), 'agent-office/2');
  assert.equal(P.worktreeDir('/u/p/shop', '/u/p/shop-wt-2', '/u/p/shop'), '/u/p/shop-wt-2');
  assert.equal(P.worktreeDir('/u/p/shop', '/u/p/shop-wt-2', '/u/p/shop/app'), '/u/p/shop-wt-2/app');
  assert.equal(P.worktreeDir('/u/p/shop', '/u/p/shop-wt-2', '/elsewhere'), '/u/p/shop-wt-2');
});

test('sessionAliases: worktree klasörünün adı projesine; aynı adlı ve başka projenin adıyla çakışan eşlenmez', () => {
  const wt = (root) => ({ root, repo: '/r/shop', branch: 'agent-office/2' });
  const projects = [
    { id: 'a', dir: '/r/shop', name: 'shop', tabs: [{ n: 2 }, { n: 3, dir: '/r/shop-wt-3', worktree: wt('/r/shop-wt-3') }, { n: 4, dir: '/r/other', worktree: wt('/r/other') }] },
    { id: 'b', dir: '/r/mono/app', name: 'app', tabs: [{ n: 2, dir: '/r/mono-wt-2/app', worktree: wt('/r/mono-wt-2') }] },
    { id: 'c', dir: '/r/other', name: 'other' },
  ];
  assert.deepEqual(P.sessionAliases(projects), { 'shop-wt-3': 'shop' });
  assert.deepEqual(P.sessionAliases([]), {});
});

test('nextAttention: worktree oturumu (eşlenen ad) projesinin onayı ve bitişi sayılır', () => {
  const projects = [{ id: 'a', name: 'shop' }];
  const aliases = { 'shop-wt-2': 'shop' };
  const office = (busy, waiting) => [
    { name: 'shop', working: 0, delivered: 0, isBossBusy: false, waiting: null },
    { name: 'shop-wt-2', working: busy ? 1 : 0, delivered: 0, isBossBusy: busy, waiting },
  ];
  let r = N.nextAttention(N.emptyAttention(), projects, office(true, null), null, aliases);
  assert.equal(r.attention.size, 0);
  r = N.nextAttention(r.state, projects, office(true, { tool: 'Bash', since: 5 }), null, aliases);
  assert.deepEqual(r.events, [{ kind: 'permission', id: 'a', tool: 'Bash' }]);
  assert.equal(r.attention.get('a'), 'permission');
  r = N.nextAttention(r.state, projects, office(true, null), null, aliases);
  r = N.nextAttention(r.state, projects, office(false, null), null, aliases);
  assert.deepEqual(r.events, [{ kind: 'done', id: 'a' }]);
  // without a map the worktree entry counts toward no project
  const plain = N.nextAttention(N.emptyAttention(), projects, office(true, { tool: 'Bash', since: 5 }), null);
  assert.equal(plain.attention.size, 0);
  // merging: oldest approval, busy OR
  const m = N.mergeAliases([
    { name: 'shop', working: 1, delivered: 2, isBossBusy: false, waiting: { tool: 'Edit', since: 9 } },
    { name: 'shop-wt-2', working: 2, delivered: 1, isBossBusy: true, waiting: { tool: 'Bash', since: 3 } },
  ], aliases);
  assert.deepEqual(m.get('shop'), { name: 'shop', working: 3, delivered: 3, isBossBusy: true, waiting: { tool: 'Bash', since: 3 } });
});

test('diller: locales/*.json bulunur, adları kendi dilinde; sistem dili dosyası olan koda çözülür', async () => {
  const langs = L.languagesOf(LOCALES);
  assert.deepEqual(langs.filter((l) => l.code === 'en' || l.code === 'tr'), [{ code: 'en', name: 'English' }, { code: 'tr', name: 'Türkçe' }]);
  assert.deepEqual(langs.map((l) => l.code), [...langs.map((l) => l.code)].sort());
  const codes = ['en', 'pt-BR', 'tr'];
  assert.equal(L.resolveLang('tr-TR', codes), 'tr');
  assert.equal(L.resolveLang('TR', codes), 'tr');
  assert.equal(L.resolveLang('pt_BR', codes), 'pt-BR');
  assert.equal(L.resolveLang('de-DE', codes), 'en');
  assert.equal(L.resolveLang('', codes), 'en');
  assert.equal(L.resolveLang(undefined, codes), 'en');
  const tr = await tFor('tr');
  const en = await tFor('en');
  assert.equal(tr('main.upToDate', { version: '1.2.3' }), 'Agent Office güncel (1.2.3).');
  assert.equal(en('panel.toolCalls', { n: 1 }), '1 tool call');
  assert.equal(en('panel.toolCalls', { n: 3 }), '3 tool calls');
  assert.equal(tr('panel.toolCalls', { n: 1 }), '1 araç çağrısı');
  assert.equal(en('no.such.key'), 'no.such.key');
  assert.equal(en.has('main.cancel'), true);
  assert.equal(en.has('main'), false);
  // a missing key falls back to English
  const { translator } = await import('../src/i18n.mjs');
  const de = translator({ main: { cancel: 'Abbrechen' } }, LOCALES.en, 'de');
  assert.equal(de('main.cancel'), 'Abbrechen');
  assert.equal(de('main.edit'), 'Edit');
});

test('güncelleme: sürüm karşılaştırma sayısal (0.10.0 > 0.9.1), sürüm olmayan → null', () => {
  assert.equal(UP.compareVersions('0.10.0', '0.9.1'), 1);
  assert.equal(UP.compareVersions('0.9.1', '0.10.0'), -1);
  assert.equal(UP.compareVersions('v1.2.3', '1.2.3'), 0);
  assert.equal(UP.compareVersions('1.2.10', '1.2.9'), 1);
  assert.equal(UP.compareVersions(null, '1.0.0'), null);
  assert.equal(UP.compareVersions('', '1.0.0'), null);
  assert.equal(UP.compareVersions('1.0', '1.0.0'), null);
});

test('güncelleme: elle denetimin iletisi', () => {
  const current = '0.9.1';
  assert.deepEqual(UP.updateMessage({ current, latest: '0.10.0' }), { kind: 'downloading', version: '0.10.0' });
  assert.deepEqual(UP.updateMessage({ current, latest: '0.9.1' }), { kind: 'upToDate', version: '0.9.1' });
  assert.deepEqual(UP.updateMessage({ current, latest: '0.9.0' }), { kind: 'upToDate', version: '0.9.1' });
  // no answer is not "up to date"
  assert.deepEqual(UP.updateMessage({ current, latest: null }), { kind: 'unknown', version: '0.9.1' });
  assert.deepEqual(UP.updateMessage({ current }), { kind: 'unknown', version: '0.9.1' });
  // a download in progress or finished wins over the check result
  assert.deepEqual(UP.updateMessage({ current, downloading: '0.10.0', latest: null }), { kind: 'downloading', version: '0.10.0' });
  assert.deepEqual(UP.updateMessage({ current, ready: '0.10.0', downloading: '0.10.1', latest: '0.10.1' }), { kind: 'ready', version: '0.10.0' });
});

test('güncelleme: odakta denetim yalnız son denetim 30 dakikadan eskiyse; saatte bir', () => {
  const now = 10 * 3600e3;
  assert.equal(UP.UPDATE_EVERY_MS, 3600e3);
  assert.equal(UP.shouldCheckOnFocus(0, now), true);
  assert.equal(UP.shouldCheckOnFocus(now - 29 * 60e3, now), false);
  assert.equal(UP.shouldCheckOnFocus(now - 30 * 60e3, now), true);
});

// ---- theme picker (contract v3.1): src/themes.mjs ----
const themesLib = () => import('../src/themes.mjs');
const fs = require('node:fs');
const GALLERY_DIR = path.join(__dirname, '..', '..', 'themes');
const galleryFiles = () => fs.readdirSync(GALLERY_DIR).filter((f) => f.endsWith('.json')).sort()
  .map((f) => JSON.parse(fs.readFileSync(path.join(GALLERY_DIR, f), 'utf8')));

test('tema galerisi: match atılır, açıklama ve renkler kalır; bozuk girdiler atlanır', async () => {
  const TH = await themesLib();
  const g = TH.galleryThemes([{ sakura: { description: 'pink', match: 'sakura', sign: 'SAKURA', colors: { accent: '#ff6f9c' } } }, null, [], { bad: 3, nocolors: { sign: 'X' } }]);
  assert.deepEqual(g.sakura, { description: 'pink', sign: 'SAKURA', colors: { accent: '#ff6f9c' } });
  assert.deepEqual(g.nocolors, { sign: 'X', colors: {} });
  assert.equal('bad' in g, false);
  // the real gallery: eight themes, none with match, each with a description
  const real = TH.galleryThemes(galleryFiles());
  assert.ok(Object.keys(real).length >= 8);
  for (const [name, t] of Object.entries(real)) {
    assert.equal('match' in t, false, `${name} kept match`);
    assert.equal(typeof t.description, 'string', `${name} has no description`);
  }
});

test('tema birleştirme: kullanıcının themes.json\'u çakışmada kazanır (renkler tek tek), match yalnız kullanıcıdan', async () => {
  const TH = await themesLib();
  const gallery = TH.galleryThemes([{ sakura: { description: 'pink', match: 'sakura', sign: 'SAKURA', colors: { accent: '#ff6f9c', body: '#f2f2f2' } } }]);
  const user = { sakura: { match: 'shop', colors: { accent: '#000000' } }, acme: { match: 'acme', colors: { frame: '#111111' } }, junk: 'x' };
  const m = TH.mergeThemes(gallery, user);
  assert.deepEqual(m.sakura, { description: 'pink', sign: 'SAKURA', match: 'shop', colors: { accent: '#000000', body: '#f2f2f2' } });
  assert.deepEqual(m.acme, { match: 'acme', colors: { frame: '#111111' } });
  assert.equal('junk' in m, false);
  // no user file, or a broken one ({} from sessions.js; anything not an object): the gallery alone
  assert.deepEqual(TH.mergeThemes(gallery, {}), gallery);
  assert.deepEqual(TH.mergeThemes(gallery, null), gallery);
  assert.equal(TH.mergeThemes(gallery, {}).sakura.match, undefined);
  // the input is not changed
  assert.equal(gallery.sakura.colors.accent, '#ff6f9c');
});

test('tema seçenekleri: önce yerleşikler (classic, forest), sonra diğerleri sırayla; açıklama temadan', async () => {
  const TH = await themesLib();
  const m = TH.mergeThemes(TH.galleryThemes([{ sakura: { description: 'pink' }, ocean: { colors: {} } }]), { forest: { colors: { accent: '#00ff00' } } });
  assert.deepEqual(TH.themeChoices(m), [
    { name: 'classic', description: '', isBuiltin: true },
    { name: 'forest', description: '', isBuiltin: true },
    { name: 'sakura', description: 'pink', isBuiltin: false },
    { name: 'ocean', description: '', isBuiltin: false },
  ]);
  assert.deepEqual(TH.themeChoices({}).map((c) => c.name), ['classic', 'forest']);
});

test('tema ayarı: auto ya da ad; bilinmeyen ad saklanır ama ofise boş (projeye göre) gider', async () => {
  const TH = await themesLib();
  for (const v of [undefined, null, 3, '', '   ', 'x'.repeat(101)]) assert.equal(TH.normalizeThemeSetting(v), 'auto');
  assert.equal(TH.normalizeThemeSetting(' sakura '), 'sakura');
  assert.equal(TH.normalizeThemeSetting('gone'), 'gone');
  const m = TH.galleryThemes([{ sakura: { colors: {} } }]);
  assert.equal(TH.effectiveTheme('auto', m), '');
  assert.equal(TH.effectiveTheme('sakura', m), 'sakura');
  assert.equal(TH.effectiveTheme('forest', m), 'forest');
  assert.equal(TH.effectiveTheme('classic', {}), 'classic');
  assert.equal(TH.effectiveTheme('gone', m), '');
  assert.equal(TH.effectiveTheme(undefined, m), '');
});

const M = require('../src/memory.js');
const fsT = require('fs');
const osT = require('os');
const pathT = require('path');

test('hafıza: slug Claude Code gibi, worktree ana klasörün hafızasını kullanır', () => {
  assert.equal(M.memorySlug('/Users/a/My Proj.x'), '-Users-a-My-Proj-x');
  assert.equal(M.memorySlug('/' + 'a'.repeat(250)), null);
  assert.equal(M.memorySlug('/a/s\u0327'), M.memorySlug('/a/\u015f')); // NFD path: same slug as NFC
  assert.equal(M.sharedMemoryDir({ configDir: null, home: '/h', base: '/r' }), null);
  assert.equal(M.sharedMemoryDir({ configDir: '/acc/w', home: '/h', base: '/r' }), '/h/.claude/projects/-r/memory');
  assert.equal(M.accountMemoryDir({ configDir: '/acc/w', base: '/r' }), '/acc/w/projects/-r/memory');
});

test('hafıza: anahtar klasör diskten bulunur (git root, worktree → ana kopya, symlink çözülür)', () => {
  const root = fsT.realpathSync(fsT.mkdtempSync(pathT.join(osT.tmpdir(), 'ao-base-')));
  const j = (...p) => pathT.join(root, ...p);
  const w = (p, txt) => { fsT.mkdirSync(pathT.dirname(p), { recursive: true }); fsT.writeFileSync(p, txt); };
  // main working copy and a linked worktree, laid out as git writes them
  fsT.mkdirSync(j('r', '.git', 'worktrees', 'r-wt'), { recursive: true });
  fsT.mkdirSync(j('r', 'sub'));
  w(j('r-wt', '.git'), `gitdir: ${j('r', '.git', 'worktrees', 'r-wt')}\n`);
  w(j('r', '.git', 'worktrees', 'r-wt', 'commondir'), '../..\n');
  w(j('r', '.git', 'worktrees', 'r-wt', 'gitdir'), `${j('r-wt', '.git')}\n`);
  fsT.mkdirSync(j('r-wt', 'deep', 'er'), { recursive: true });
  assert.equal(M.memoryBase(j('r')), j('r'));
  assert.equal(M.memoryBase(j('r', 'sub')), j('r'));
  assert.equal(M.memoryBase(j('r-wt', 'deep', 'er')), j('r'));
  // submodule: .git file into .git/modules (no commondir) → its own root
  w(j('r', 'mod', '.git'), 'gitdir: ../.git/modules/mod\n');
  fsT.mkdirSync(j('r', '.git', 'modules', 'mod'), { recursive: true });
  assert.equal(M.memoryBase(j('r', 'mod')), j('r', 'mod'));
  // worktree of a bare repository → the bare repository folder
  fsT.mkdirSync(j('b.git', 'worktrees', 'bw'), { recursive: true });
  w(j('bw', '.git'), `gitdir: ${j('b.git', 'worktrees', 'bw')}\n`);
  w(j('b.git', 'worktrees', 'bw', 'commondir'), '../..\n');
  assert.equal(M.memoryBase(j('bw')), j('b.git'));
  // not a repository; reached through a symlink → the real path, as Claude Code's cwd
  fsT.mkdirSync(j('plain'));
  fsT.symlinkSync(j('plain'), j('link'));
  if (!fsT.existsSync(pathT.join(pathT.parse(root).root, '.git'))) {
    assert.equal(M.memoryBase(j('link')), j('plain'));
    assert.equal(M.memoryBase(j('missing')), j('missing'));
  }
  fsT.rmSync(root, { recursive: true, force: true });
});

test('hafıza: --settings JSON\'una autoMemoryDirectory eklenir', () => {
  assert.equal(M.withMemorySetting(null, null), null);
  assert.equal(M.withMemorySetting('{"a":1}', null), '{"a":1}');
  assert.deepEqual(JSON.parse(M.withMemorySetting('{"statusLine":{"type":"command"}}', '/m')), { statusLine: { type: 'command' }, autoMemoryDirectory: '/m' });
  assert.deepEqual(JSON.parse(M.withMemorySetting(null, '/m')), { autoMemoryDirectory: '/m' });
});

test('hafıza: hesabın hafızası ~/.claude\'a birleşir, mevcut olan ezilmez', () => {
  const root = fsT.mkdtempSync(pathT.join(osT.tmpdir(), 'ao-mem-'));
  const from = pathT.join(root, 'acc'); const to = pathT.join(root, 'home');
  fsT.mkdirSync(from); fsT.mkdirSync(to);
  fsT.writeFileSync(pathT.join(to, 'MEMORY.md'), '# Memory Index\n\n- [Commit](commit.md) — no attribution');
  fsT.writeFileSync(pathT.join(to, 'commit.md'), 'home');
  fsT.writeFileSync(pathT.join(from, 'commit.md'), 'account');
  fsT.writeFileSync(pathT.join(from, 'new.md'), 'new');
  fsT.writeFileSync(pathT.join(from, 'MEMORY.md'), '- [New](new.md) — x\n- [Commit](commit.md) — old\n');
  assert.deepEqual(M.mergeMemory(from, to), ['new.md']);
  assert.equal(fsT.readFileSync(pathT.join(to, 'commit.md'), 'utf8'), 'home');
  assert.equal(fsT.readFileSync(pathT.join(to, 'new.md'), 'utf8'), 'new');
  assert.equal(fsT.readFileSync(pathT.join(to, 'MEMORY.md'), 'utf8'), '# Memory Index\n\n- [Commit](commit.md) — no attribution\n- [New](new.md) — x\n');
  // idempotent; a memory deleted from ~/.claude is not copied back; a new account memory still is
  assert.deepEqual(M.mergeMemory(from, to), []);
  fsT.rmSync(pathT.join(to, 'new.md'));
  fsT.writeFileSync(pathT.join(from, 'later.md'), 'later');
  assert.deepEqual(M.mergeMemory(from, to), ['later.md']);
  assert.equal(fsT.existsSync(pathT.join(to, 'new.md')), false);
  fsT.rmSync(pathT.join(from, 'later.md'));
  // a missing source or target folder is fine
  assert.deepEqual(M.mergeMemory(pathT.join(root, 'none'), to), []);
  const fresh = pathT.join(root, 'fresh', 'memory');
  fsT.rmSync(pathT.join(from, '.agent-office-merged.json'));
  assert.deepEqual(M.mergeMemory(from, fresh).sort(), ['commit.md', 'new.md']);
  assert.equal(fsT.readFileSync(pathT.join(fresh, 'MEMORY.md'), 'utf8'), '- [New](new.md) — x\n- [Commit](commit.md) — old\n');
  fsT.rmSync(root, { recursive: true, force: true });
});

test('terminal: ⌘Enter (macOS) ve Ctrl+Enter claude\'a ctrl+enter (hemen gönder) olarak gider', async () => {
  const K = await import('../src/terminal-keys.mjs');
  const enter = (m = {}) => ({ key: 'Enter', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...m });
  assert.equal(K.CTRL_ENTER, '\x1b[13;5u');
  assert.equal(K.translateKey(enter({ metaKey: true }), true), K.CTRL_ENTER);
  assert.equal(K.translateKey(enter({ ctrlKey: true }), true), K.CTRL_ENTER);
  assert.equal(K.translateKey(enter({ ctrlKey: true }), false), K.CTRL_ENTER);
  // plain Enter, Shift/Option+Enter and ⌘ on Linux stay with xterm
  assert.equal(K.translateKey(enter(), true), null);
  assert.equal(K.translateKey(enter({ shiftKey: true }), true), null);
  assert.equal(K.translateKey(enter({ altKey: true }), true), null);
  assert.equal(K.translateKey(enter({ ctrlKey: true, isComposing: true }), false), null);
  assert.equal(K.translateKey(enter({ metaKey: true }), false), null);
  assert.equal(K.translateKey(enter({ metaKey: true, ctrlKey: true }), true), null);
  assert.equal(K.translateKey({ key: 's', ctrlKey: true }, true), null);
});

test('uyku: ayar seçenekleri, varsayılan 30 dk, claude\'un pid dosyası hesabın klasöründe', () => {
  const Z = require('../src/sleep.js');
  assert.deepEqual(Z.SLEEP_CHOICES, [0, 15, 30, 60]);
  assert.equal(Z.normalizeSleep(undefined), 30);
  assert.equal(Z.normalizeSleep(0), 0);
  assert.equal(Z.normalizeSleep(60), 60);
  assert.equal(Z.normalizeSleep(7), 30);
  assert.equal(Z.normalizeSleep('15'), 30);
  assert.equal(Z.claudePidFile(null, '/h', 42), '/h/.claude/sessions/42.json');
  assert.equal(Z.claudePidFile('/u/accounts/a', '/h', 42), '/u/accounts/a/sessions/42.json');
});

test('uyku: gönderilmemiş yazı (Enter gönderir, Ctrl+C siler, kaçış dizileri saymaz)', () => {
  const { draftAfter } = require('../src/sleep.js');
  assert.equal(draftAfter(false, 'merhaba'), true);
  assert.equal(draftAfter(true, '\r'), false);
  assert.equal(draftAfter(false, 'fix the bug\r'), false);
  assert.equal(draftAfter(false, 'a\rb'), true);
  assert.equal(draftAfter(true, '\x03'), false);
  // arrows, focus in/out, SS3 keys, Alt+key and paste brackets alone are not text
  assert.equal(draftAfter(false, '\x1b[A\x1b[B\x1b[I\x1b[O\x1bOP\x1bb'), false);
  assert.equal(draftAfter(false, '\x1b[200~\x1b[201~'), false);
  // pasted text is a draft; a trailing Enter sends it
  assert.equal(draftAfter(false, '\x1b[200~long paste\x1b[201~'), true);
  assert.equal(draftAfter(false, '\x1b[200~long paste\x1b[201~\r'), false);
  // backspace and Escape keep what was there (safe side)
  assert.equal(draftAfter(true, '\x7f\x7f'), true);
  assert.equal(draftAfter(false, '\x7f'), false);
  assert.equal(draftAfter(true, '\x1b'), true);
  assert.equal(draftAfter(false, ''), false);
});

test('uyku: yalnız hiçbir şey kaybolmayacaksa (boşta, ajan/kabuk/onay/zamanlama yok, etkin proje değil)', () => {
  const { sleepBlocker, hasScheduleTool } = require('../src/sleep.js');
  const now = 10_000_000;
  const idle = {
    now, idleMs: 30 * 60000, lastActivityAt: now - 31 * 60000,
    claude: { pid: 1, sessionId: 's1', status: 'idle' },
    office: { format: 2, project: 'p', updatedAt: now, workers: [{ id: 'w', doneAt: now - 1 }], shells: [{ id: 'b', endAt: now - 1 }], stats: { isBossBusy: false } },
  };
  assert.equal(sleepBlocker(idle), '');
  assert.equal(sleepBlocker({ ...idle, idleMs: 0 }), 'off');
  assert.equal(sleepBlocker({ ...idle, isActive: true }), 'active');
  assert.equal(sleepBlocker({ ...idle, lastActivityAt: now - 29 * 60000 }), 'recent');
  assert.equal(sleepBlocker({ ...idle, hasDraft: true }), 'draft');
  // unknown session (no pid file, an odd one, no office file, an ended one): stays awake
  assert.equal(sleepBlocker({ ...idle, claude: undefined }), 'unknown');
  assert.equal(sleepBlocker({ ...idle, claude: { status: 'idle' } }), 'unknown');
  assert.equal(sleepBlocker({ ...idle, office: undefined }), 'unknown');
  assert.equal(sleepBlocker({ ...idle, office: { ...idle.office, endedAt: now } }), 'unknown');
  assert.equal(sleepBlocker({ ...idle, claude: { ...idle.claude, status: 'busy' } }), 'busy');
  assert.equal(sleepBlocker({ ...idle, claude: { ...idle.claude, status: undefined } }), 'busy');
  assert.equal(sleepBlocker({ ...idle, office: { ...idle.office, stats: { isBossBusy: true } } }), 'busy');
  assert.equal(sleepBlocker({ ...idle, office: { ...idle.office, stats: { waiting: { kind: 'permission', tool: 'Bash', since: now } } } }), 'waiting');
  assert.equal(sleepBlocker({ ...idle, office: { ...idle.office, workers: [{ id: 'w2' }] } }), 'agents');
  assert.equal(sleepBlocker({ ...idle, office: { ...idle.office, shells: [{ id: 'b2', status: 'running' }] } }), 'shells');
  assert.equal(sleepBlocker({ ...idle, hasSchedule: true }), 'scheduled');
  assert.equal(hasScheduleTool('{"type":"tool_use","name":"CronCreate","input":{}}'), true);
  assert.equal(hasScheduleTool('{"type":"tool_use","name":"ScheduleWakeup"}'), true);
  assert.equal(hasScheduleTool('{"type":"tool_use","name":"Bash"} CronCreate in prose'), false);
  assert.equal(hasScheduleTool(undefined), false);
});

test('uyku: readSession oturum dosyasını kimliğiyle okur, garip kimlik ya da bozuk dosya undefined', () => {
  const fsT = require('fs');
  const pathT = require('path');
  const S = require('../src/sessions.js');
  const root = fsT.mkdtempSync(pathT.join(require('os').tmpdir(), 'ao-sleep-'));
  fsT.mkdirSync(pathT.join(root, 'sessions'));
  fsT.writeFileSync(pathT.join(root, 'sessions', 'abc-1.json'), '{"format":2,"stats":{"isBossBusy":false}}');
  fsT.writeFileSync(pathT.join(root, 'sessions', 'bad.json'), '{');
  assert.deepEqual(S.readSession('abc-1', root), { format: 2, stats: { isBossBusy: false } });
  assert.equal(S.readSession('bad', root), undefined);
  assert.equal(S.readSession('missing', root), undefined);
  assert.equal(S.readSession('../sessions/abc-1', root), undefined);
  assert.equal(S.readSession(undefined, root), undefined);
  fsT.rmSync(root, { recursive: true, force: true });
});

// ---- Windows (decisions are pure and take the platform/env as arguments, so they run on any OS)
const W = require('path').win32;
const filesAt = (...files) => (f) => files.includes(f);

test('Windows: claude PATH\'te (PATHEXT sırası, Path anahtarı), yoksa kurulum klasörleri; hiç yoksa null', () => {
  const env = { Path: 'C:\\Windows;C:\\Users\\a\\AppData\\Roaming\\npm;"C:\\Users\\a\\.local\\bin"', PATHEXT: '.COM;.EXE;.BAT;.CMD;.PS1' };
  // .exe comes before .cmd in PATHEXT, but PATH order wins: npm's folder is earlier
  assert.equal(OS.findClaude(env, filesAt('C:\\Users\\a\\AppData\\Roaming\\npm\\claude.cmd', 'C:\\Users\\a\\.local\\bin\\claude.exe')),
    'C:\\Users\\a\\AppData\\Roaming\\npm\\claude.cmd');
  assert.equal(OS.findClaude(env, filesAt('C:\\Users\\a\\.local\\bin\\claude.exe')), 'C:\\Users\\a\\.local\\bin\\claude.exe');
  // an extensionless npm shim (a shell script) or a .ps1 is never picked
  assert.equal(OS.findClaude(env, filesAt('C:\\Users\\a\\AppData\\Roaming\\npm\\claude', 'C:\\Users\\a\\AppData\\Roaming\\npm\\claude.ps1')), null);
  // not on PATH: the native installer's folder, then npm's
  const bare = { PATH: 'C:\\Windows', USERPROFILE: 'C:\\Users\\b', APPDATA: 'C:\\Users\\b\\AppData\\Roaming' };
  assert.equal(OS.findClaude(bare, filesAt('C:\\Users\\b\\.local\\bin\\claude.exe')), 'C:\\Users\\b\\.local\\bin\\claude.exe');
  assert.equal(OS.findClaude(bare, filesAt('C:\\Users\\b\\AppData\\Roaming\\npm\\claude.cmd')), 'C:\\Users\\b\\AppData\\Roaming\\npm\\claude.cmd');
  assert.equal(OS.findClaude(bare, () => false), null);
  assert.equal(OS.findOnPath('git.exe', { PATH: 'C:\\Git\\cmd' }, filesAt('C:\\Git\\cmd\\git.exe')), 'C:\\Git\\cmd\\git.exe');
});

test('Windows: .exe doğrudan, .cmd cmd.exe /d /s /c ile tek satır (tırnaklar korunur)', () => {
  const args = ['--plugin-dir', 'C:\\Users\\a b\\AppData\\Roaming\\Agent Office\\plugin\\agent-office', '--settings', 'C:\\s\\p.json', '--continue'];
  assert.deepEqual(OS.windowsCommand('C:\\Users\\a\\.local\\bin\\claude.exe', args, {}), { file: 'C:\\Users\\a\\.local\\bin\\claude.exe', args, verbatim: false });
  const c = OS.windowsCommand('C:\\Users\\a b\\AppData\\Roaming\\npm\\claude.cmd', args, { ComSpec: 'C:\\Windows\\system32\\cmd.exe' });
  assert.equal(c.file, 'C:\\Windows\\system32\\cmd.exe');
  assert.equal(c.verbatim, true);
  assert.deepEqual(c.args.slice(0, 3), ['/d', '/s', '/c']);
  assert.equal(c.args[3], '""C:\\Users\\a b\\AppData\\Roaming\\npm\\claude.cmd" --plugin-dir "C:\\Users\\a b\\AppData\\Roaming\\Agent Office\\plugin\\agent-office" --settings C:\\s\\p.json --continue"');
  assert.equal(OS.windowsCommand('C:\\x\\claude.BAT', [], {}).file, 'cmd.exe');
  assert.equal(OS.cmdQuote('a&b'), '"a&b"');
  assert.equal(OS.cmdQuote('say "hi"'), '"say ""hi"""');
});

test('Windows: PATH\'e klasör eklenir (mevcut anahtar, bir kez); env değişken adı büyük/küçük harf duyarsız', () => {
  assert.deepEqual(OS.withPathDir({ Path: 'C:\\A;C:\\B' }, 'C:\\U s'), { Path: 'C:\\A;C:\\B;C:\\U s' });
  assert.deepEqual(OS.withPathDir({ Path: 'C:\\A;c:\\u s' }, 'C:\\U s'), { Path: 'C:\\A;c:\\u s' });
  assert.deepEqual(OS.withPathDir({}, 'C:\\U'), { PATH: 'C:\\U' });
  assert.equal(OS.envGet({ ComSpec: 'x' }, 'COMSPEC'), 'x');
  assert.equal(OS.envGet({}, 'COMSPEC'), undefined);
});

test('Windows: Git Bash CLAUDE_CODE_GIT_BASH_PATH, git.exe\'nin yanı, sonra varsayılan klasörler', () => {
  const bash = 'C:\\Program Files\\Git\\bin\\bash.exe';
  assert.equal(OS.findGitBash({ CLAUDE_CODE_GIT_BASH_PATH: 'D:\\g\\bash.exe' }, filesAt('D:\\g\\bash.exe', bash)), 'D:\\g\\bash.exe');
  assert.equal(OS.findGitBash({ PATH: 'C:\\Program Files\\Git\\cmd' }, filesAt('C:\\Program Files\\Git\\cmd\\git.exe', bash)), bash);
  assert.equal(OS.findGitBash({ ProgramFiles: 'C:\\Program Files' }, filesAt(bash)), bash);
  assert.equal(OS.findGitBash({ LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local' }, filesAt('C:\\Users\\a\\AppData\\Local\\Programs\\Git\\bin\\bash.exe')),
    'C:\\Users\\a\\AppData\\Local\\Programs\\Git\\bin\\bash.exe');
  assert.equal(OS.findGitBash({ PATH: 'C:\\Windows' }, () => false), null);
});

test('Windows: Gezgin\'den kopyalanan dosyalar (CF_HDROP, FileNameW, uri-list, PowerShell çıktısı)', () => {
  const names = ['C:\\Users\\a\\b c.png', 'D:\\x.txt'];
  const wide = Buffer.concat([Buffer.alloc(20), Buffer.from(names.join('\0') + '\0\0', 'utf16le')]);
  wide.writeUInt32LE(20, 0);
  wide.writeUInt32LE(1, 16);
  assert.deepEqual(OS.filesFromDropFiles(wide), names);
  const ansi = Buffer.concat([Buffer.alloc(20), Buffer.from('C:\\a.txt\0\0', 'latin1')]);
  ansi.writeUInt32LE(20, 0);
  assert.deepEqual(OS.filesFromDropFiles(ansi), ['C:\\a.txt']);
  assert.deepEqual(OS.filesFromDropFiles(Buffer.alloc(4)), []);
  assert.deepEqual(OS.filesFromFileNameW(Buffer.from('C:\\ç d.png\0', 'utf16le')), ['C:\\ç d.png']);
  assert.deepEqual(OS.filesFromFileNameW(Buffer.alloc(0)), []);
  assert.equal(OS.windowsClipboardKind('electron application/osclipboard;format="CF_HDROP"'), 'drop');
  assert.equal(OS.windowsClipboardKind('electron application/osclipboard;format="FileNameW"'), 'name');
  assert.equal(OS.windowsClipboardKind('text/uri-list'), 'uri');
  assert.equal(OS.windowsClipboardKind('electron application/osclipboard;format="HTML Format"'), null);
  assert.equal(OS.windowsClipboardKind('text/plain'), null);
  assert.deepEqual(OS.filesFromUriList('file:///C:/Users/a%20b/x.png\r\nfile://srv/share/y.txt\r\nhttps://e.com/z', 'win32'),
    ['C:\\Users\\a b\\x.png', '\\\\srv\\share\\y.txt']);
  assert.deepEqual(OS.filesFromLines('C:\\a b.txt\r\n\\\\srv\\s\\c.txt\r\nWARNING: x\r\n'), ['C:\\a b.txt', '\\\\srv\\s\\c.txt']);
});

test('Windows: kısayollar Linux gibi Ctrl+Shift; güncelleyici macOS, Windows ve AppImage\'da', () => {
  assert.deepEqual(OS.shortcuts('win32'), OS.shortcuts('linux'));
  assert.equal(OS.isWindows('win32'), true);
  assert.equal(OS.isWindows('darwin'), false);
  assert.equal(OS.canSelfUpdate('darwin', {}), true);
  assert.equal(OS.canSelfUpdate('win32', {}), true);
  assert.equal(OS.canSelfUpdate('linux', {}), false);
  assert.equal(OS.canSelfUpdate('linux', { APPIMAGE: '/x.AppImage' }), true);
});

test('Windows: görev çubuğu rozeti geçerli bir PNG', () => {
  const png = OS.dotPng(32, 0xe5484d);
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(png.readUInt32BE(16), 32);
  assert.equal(png.readUInt32BE(20), 32);
});

test('Windows: status line komutu tek çıplak sözcük; .cmd uygulamayı Node olarak çalıştırır', () => {
  const s = JSON.parse(U.windowsStatusLineSettings({ padding: 1 }));
  assert.deepEqual(s.statusLine, { type: 'command', command: 'agent-office-statusline.cmd', padding: 1 });
  assert.equal('padding' in JSON.parse(U.windowsStatusLineSettings(null)).statusLine, false);
  // no quotes, spaces or backslashes: Git Bash and PowerShell read it the same way
  assert.match(U.WIN_CMD, /^[\w.-]+$/);
  const cmd = U.windowsCmdFile('C:\\Users\\a 100%\\AppData\\Local\\Programs\\Agent Office\\Agent Office.exe');
  assert.equal(cmd.split('\r\n')[3], 'set ELECTRON_RUN_AS_NODE=1');
  assert.equal(cmd.split('\r\n')[4], '"C:\\Users\\a 100%%\\AppData\\Local\\Programs\\Agent Office\\Agent Office.exe" "%~dp0statusline.js"');
});

test('Windows: status line betiği (Node) girdiyi dosyaya yazar, kullanıcının komutunu aynı girdiyle çalıştırır', { skip: process.platform === 'win32' && 'runs the user command with /bin/sh here' }, () => {
  const fs = require('fs');
  const os = require('os');
  const { execFileSync } = require('child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-slw-'));
  const script = path.join(dir, U.WIN_SCRIPT_NAME);
  fs.writeFileSync(script, U.WIN_SCRIPT);
  const out = path.join(dir, 'p.json');
  const input = JSON.stringify({ rate_limits: { seven_day: { used_percentage: 3 } } });
  const env = { PATH: process.env.PATH, AGENT_OFFICE_USAGE_OUT: out };
  assert.equal(execFileSync(process.execPath, [script], { input, env }).toString(), '');
  assert.equal(fs.readFileSync(out, 'utf8'), input);
  const shown = execFileSync(process.execPath, [script], { input, env: { ...env, AGENT_OFFICE_STATUSLINE: 'wc -c | tr -d " "', AGENT_OFFICE_STATUSLINE_SHELL: '/bin/sh' } }).toString();
  assert.equal(shown.trim(), String(input.length));
  assert.deepEqual(fs.readdirSync(dir).sort(), ['p.json', U.WIN_SCRIPT_NAME]);
  fs.rmSync(dir, { recursive: true });
});

test('Windows: hafıza ve geçmiş slug\'ı C:\\ yollarında da Claude Code gibi', () => {
  assert.equal(M.memorySlug('C:\\Users\\a\\proj'), 'C--Users-a-proj');
  // a .git file's gitdir on Windows uses forward slashes: the same slug
  assert.equal(M.memorySlug('C:/Users/a/proj'), 'C--Users-a-proj');
  assert.equal(W.basename(P.historyDir('C:\\Users\\a\\my.proj', null, 'C:\\Users\\a')), 'C--Users-a-my-proj');
});

test('terminal: resim yapıştırma tuşu ve yol tırnakları (Windows çift tırnak)', async () => {
  const K = await import('../src/terminal-keys.mjs');
  assert.equal(K.imagePasteKey('darwin'), '\x16');
  assert.equal(K.imagePasteKey('linux'), '\x16');
  assert.equal(K.imagePasteKey('win32'), '\x1bv');
  assert.equal(K.quotePath('/a/b c', 'darwin'), "'/a/b c'");
  assert.equal(K.quotePath("/a/it's", 'linux'), "'/a/it'\\''s'");
  assert.equal(K.quotePath('/a/b', 'darwin'), '/a/b');
  assert.equal(K.quotePath('C:\\Users\\a\\b.png', 'win32'), 'C:\\Users\\a\\b.png');
  assert.equal(K.quotePath('C:\\Users\\a b\\c.png', 'win32'), '"C:\\Users\\a b\\c.png"');
  assert.equal(K.quotePath('C:\\R&D\\x', 'win32'), '"C:\\R&D\\x"');
});

test('terminal: macOS Option ile klavye düzeninin ürettiği ASCII işaret yazılır, diğerleri Meta kalır', async () => {
  const K = await import('../src/terminal-keys.mjs');
  const opt = (key, code, m = {}) => ({ key, code, altKey: true, metaKey: false, ctrlKey: false, shiftKey: false, ...m });
  // TR Q layout: Option+Q @, Option+7 {, Option+8 [; DE: Option+Shift+7 is a backslash
  assert.equal(K.translateKey(opt('@', 'KeyQ'), true), '@');
  assert.equal(K.translateKey(opt('{', 'Digit7'), true), '{');
  assert.equal(K.translateKey(opt('[', 'Digit8'), true), '[');
  assert.equal(K.translateKey(opt('\\', 'Digit7', { shiftKey: true }), true), '\\');
  assert.equal(K.translateKey(opt('~', 'KeyN'), true), '~');
  // US Option+p (π), letters/digits, keys without a character, dead keys: Meta (xterm sends ESC+key)
  assert.equal(K.translateKey(opt('π', 'KeyP'), true), null);
  assert.equal(K.translateKey(opt('p', 'KeyP'), true), null);
  assert.equal(K.translateKey(opt('1', 'Digit1'), true), null);
  assert.equal(K.translateKey(opt(' ', 'Space'), true), null);
  assert.equal(K.translateKey(opt('ArrowLeft', 'ArrowLeft'), true), null);
  assert.equal(K.translateKey(opt('Backspace', 'Backspace'), true), null);
  assert.equal(K.translateKey(opt('Enter', 'Enter'), true), null);
  assert.equal(K.translateKey(opt('Dead', 'KeyE'), true), null);
  // IME composition, Linux Alt, Cmd/Ctrl held with Option: left to xterm
  assert.equal(K.translateKey(opt('@', 'KeyQ', { isComposing: true }), true), null);
  assert.equal(K.translateKey(opt('@', 'KeyQ'), false), null);
  assert.equal(K.translateKey(opt('@', 'KeyQ', { metaKey: true }), true), null);
  assert.equal(K.translateKey(opt('@', 'KeyQ', { ctrlKey: true }), true), null);
});

test('uyku: uyanış seçenekleri (kendi oturumu, açılışta "son oturumdan devam et" o anki ayarı, hesap değişince temiz)', () => {
  const { wakeOptions } = require('../src/sleep.js');
  assert.deepEqual(wakeOptions({ sessionId: 's1' }, false), { sessionId: 's1' });
  assert.deepEqual(wakeOptions({ resume: true }, true), { resume: true });
  assert.deepEqual(wakeOptions({ resume: true }, false), { resume: false });
  assert.deepEqual(wakeOptions({}, true), { resume: false });
  assert.deepEqual(wakeOptions(undefined, true), { resume: false });
});

// --- moving a session to another computer (contract v3.4): src/transfer.js (pure) and src/transfer-io.js (files, git)
const TR = require('../src/transfer.js');
const TIO = require('../src/transfer-io.js');

const manifestOf = (over = {}) => ({
  format: TR.FORMAT, version: TR.VERSION, createdAt: '2026-10-12T00:00:00.000Z',
  source: { platform: 'darwin', projectDir: '/Users/a/proj', historyDir: '/Users/a/.claude/projects/-Users-a-proj' },
  session: { id: 'abc-123' }, git: null, ...over,
});
const archiveOf = (extra = [], manifest = manifestOf()) => [
  { name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest)) },
  { name: `transcript/${manifest.session?.id}.jsonl`, data: Buffer.from('{"type":"user"}\n') },
  ...extra,
];
const codeOf = (fn) => { try { fn(); } catch (e) { return e.code; } return 'no error'; };

test('transfer: tar.gz round trip keeps names (long, non-ASCII) and bytes', () => {
  const long = `memory/${'x'.repeat(150)}.md`;
  const entries = [
    { name: 'manifest.json', data: Buffer.from('{}') },
    { name: 'transcript/abc/subagents/agent-1.jsonl', data: Buffer.from('a\nb\n') },
    { name: long, data: Buffer.alloc(0) },
    { name: 'memory/çalışma_notları.md', data: Buffer.from('ğüş') },
    { name: 'git/handoff.bundle', data: Buffer.from([0, 1, 2, 255, 254, 0, 10, 13]) },
    { name: 'big', data: Buffer.alloc(70000, 7) },
  ];
  const back = TR.unpackArchive(TR.packArchive(entries, 1700000000));
  assert.deepEqual(back.map((e) => e.name), entries.map((e) => e.name));
  for (let i = 0; i < entries.length; i++) assert.ok(back[i].data.equals(entries[i].data), entries[i].name);
  assert.equal(codeOf(() => TR.unpackArchive(Buffer.from('not gzip'))), 'notArchive');
  assert.equal(codeOf(() => TR.unpackArchive(TR.packArchive([{ name: 'a', data: Buffer.alloc(5000) }]), 1000)), 'tooLarge');
  assert.equal(codeOf(() => TR.tarPack([{ name: '../evil', data: Buffer.alloc(1) }])), 'unsafeEntry');
});

test('transfer: the archive is refused for unknown formats, traversal, absolute paths, links and credentials', () => {
  const ok = TR.readArchive(archiveOf([{ name: 'memory/MEMORY.md', data: Buffer.from('- x') }, { name: 'office/abc-123.json', data: Buffer.from('{}') }, { name: 'transcript/abc-123/tool-results/x.txt', data: Buffer.from('t') }]));
  assert.equal(ok.manifest.session.id, 'abc-123');
  assert.equal(ok.memory[0].name, 'MEMORY.md');
  assert.equal(ok.sidecar[0].rel, 'tool-results/x.txt');
  assert.ok(ok.office);
  assert.equal(codeOf(() => TR.readArchive(archiveOf([], { ...manifestOf(), format: 'zip' }))), 'unknownFormat');
  assert.equal(codeOf(() => TR.readArchive(archiveOf([], { ...manifestOf(), version: TR.VERSION + 1 }))), 'newerFormat');
  assert.equal(codeOf(() => TR.readArchive(archiveOf([], { ...manifestOf(), session: { id: 'a b' } }))), 'badManifest');
  assert.equal(codeOf(() => TR.readArchive(archiveOf([], manifestOf({ git: { head: 'a'.repeat(40), branch: '--upload-pack=x' } })))), 'badManifest');
  assert.equal(codeOf(() => TR.readArchive(archiveOf([], manifestOf({ git: { head: 'nothex' } })))), 'badManifest');
  assert.equal(codeOf(() => TR.readArchive(archiveOf([], manifestOf({ source: { platform: 'darwin' } })))), 'badManifest');
  for (const name of ['../x', 'memory/../../x.md', '/etc/passwd', 'C:/x', 'c:\\x', 'memory\\..\\x.md', 'a//b', './a', 'a/./b', 'x\0y']) {
    assert.equal(codeOf(() => TR.readArchive(archiveOf([{ name, data: Buffer.alloc(1) }]))), 'unsafeEntry', name);
  }
  for (const name of ['transcript/abc-123/.credentials.json', 'memory/.claude.json', 'transcript/abc-123/login.keychain-db']) {
    assert.equal(codeOf(() => TR.readArchive(archiveOf([{ name, data: Buffer.alloc(1) }]))), 'secret', name);
  }
  assert.equal(codeOf(() => TR.readArchive(archiveOf([{ name: 'settings.json', data: Buffer.alloc(1) }]))), 'unexpectedEntry');
  assert.equal(codeOf(() => TR.readArchive(archiveOf([{ name: 'memory/sub/x.md', data: Buffer.alloc(1) }]))), 'unexpectedEntry');
  assert.equal(codeOf(() => TR.readArchive(archiveOf([{ name: 'manifest.json', data: Buffer.from('{}') }]))), 'duplicate');
  assert.equal(codeOf(() => TR.readArchive(archiveOf().slice(0, 1))), 'missingTranscript');
  assert.equal(codeOf(() => TR.readArchive([])), 'notArchive');
  // a symlink entry (type 2) in a hand-made tar is refused while reading
  const tar = TR.tarPack([{ name: 'manifest.json', data: Buffer.from('{}') }]);
  tar[156] = '2'.charCodeAt(0);
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 0x20 : tar[i];
  tar.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii');
  assert.equal(codeOf(() => TR.tarUnpack(tar)), 'unsafeEntry');
});

test('transfer: path prefixes in transcript lines (POSIX→POSIX, macOS→Windows, Windows→macOS)', () => {
  const src = { platform: 'darwin', projectDir: '/Users/a/proj', realDir: '/Users/a/proj', historyDir: '/Users/a/.claude/projects/-Users-a-proj', memoryDir: '/Users/a/.claude/projects/-Users-a-proj/memory' };
  const ids = { from: 's1', to: 's1' };
  // POSIX → POSIX
  let rw = TR.makeRewriter(TR.moveMaps(src, { projectDir: '/home/b/code/proj', historyDir: '/home/b/.claude/projects/-home-b-code-proj', memoryDir: '/home/b/.claude/projects/-home-b-code-proj/memory' }, ids), 'posix');
  const line = JSON.stringify({ type: 'user', cwd: '/Users/a/proj', sessionId: 's1', message: { content: [{ type: 'tool_use', input: { file_path: '/Users/a/proj/src/a b.js', command: 'cat /Users/a/proj/x.txt; ls /Users/a/project /x/Users/a/proj' } }, { type: 'text', text: 'saved to /Users/a/.claude/projects/-Users-a-proj/s1/tool-results/r.txt.' }] } });
  const out = JSON.parse(TR.rewriteJsonl(line, rw, ids));
  assert.equal(out.cwd, '/home/b/code/proj');
  assert.equal(out.message.content[0].input.file_path, '/home/b/code/proj/src/a b.js');
  assert.equal(out.message.content[0].input.command, 'cat /home/b/code/proj/x.txt; ls /Users/a/project /x/Users/a/proj');
  assert.equal(out.message.content[1].text, 'saved to /home/b/.claude/projects/-home-b-code-proj/s1/tool-results/r.txt.');
  // lines without a path stay byte for byte; broken lines too
  const plain = '{"type":"x",  "a":1.0}\nnot json /Users/a/proj\n';
  assert.equal(TR.rewriteJsonl(plain, rw, ids), plain);
  // macOS → Windows: separators follow, a whole-path field converts spaces and all
  rw = TR.makeRewriter(TR.moveMaps(src, { projectDir: 'C:\\Users\\b\\proj', historyDir: 'C:\\Users\\b\\.claude\\projects\\C--Users-b-proj', memoryDir: null }, ids), 'win32');
  const w = JSON.parse(TR.rewriteJsonl(JSON.stringify({ cwd: '/Users/a/proj', input: { file_path: '/Users/a/proj/my dir/a.js' }, text: 'edit /Users/a/proj/src/b.ts now' }), rw, ids));
  assert.equal(w.cwd, 'C:\\Users\\b\\proj');
  assert.equal(w.input.file_path, 'C:\\Users\\b\\proj\\my dir\\a.js');
  assert.equal(w.text, 'edit C:\\Users\\b\\proj\\src\\b.ts now');
  // Windows → macOS: any case, / or \ or JSON-escaped \\ between parts
  const wsrc = { platform: 'win32', projectDir: 'C:\\Users\\a\\proj', historyDir: 'C:\\Users\\a\\.claude\\projects\\C--Users-a-proj' };
  rw = TR.makeRewriter(TR.moveMaps(wsrc, { projectDir: '/Users/b/proj', historyDir: '/Users/b/.claude/projects/-Users-b-proj' }, ids), 'posix');
  const m = JSON.parse(TR.rewriteJsonl(JSON.stringify({ cwd: 'C:\\Users\\a\\proj', a: 'c:\\users\\A\\Proj\\src\\x.js', b: 'C:/Users/a/proj/y.js', c: '{"p":"C:\\\\Users\\\\a\\\\proj\\\\z.js"}', d: 'C:\\Users\\a\\project2' }), rw, ids));
  assert.equal(m.cwd, '/Users/b/proj');
  assert.equal(m.a, '/Users/b/proj/src/x.js');
  assert.equal(m.b, '/Users/b/proj/y.js');
  assert.equal(m.c, '{"p":"/Users/b/proj/z.js"}');
  assert.equal(m.d, 'C:\\Users\\a\\project2');
  // a new session id: the id fields and the session's own folder follow
  const ids2 = { from: 's1', to: 's2' };
  rw = TR.makeRewriter(TR.moveMaps(src, { projectDir: '/p', historyDir: '/h' }, ids2), 'posix');
  const r = JSON.parse(TR.rewriteJsonl(JSON.stringify({ sessionId: 's1', session_id: 's1', other: 's1', t: '/Users/a/.claude/projects/-Users-a-proj/s1/tool-results/a.txt' }), rw, ids2));
  assert.deepEqual(r, { sessionId: 's2', session_id: 's2', other: 's1', t: '/h/s2/tool-results/a.txt' });
});

test('transfer: the new folder\'s Claude Code slug (real path; Windows drive; too long → refused)', () => {
  const path = require('path');
  assert.equal(P.historyDir('C:\\Users\\b\\proj', null, 'C:\\Users\\b').replace(/\\/g, '/').split('/').pop(), 'C--Users-b-proj');
  assert.equal(path.basename(P.historyDir('/home/b/my proj.v2', null, '/home/b')), '-home-b-my-proj-v2');
  const fs = require('fs');
  const os = require('os');
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ao-slug-')));
  try {
    assert.equal(TIO.historyDirOf(tmp, null, '/h'), P.historyDir(tmp, null, '/h'));
    if (process.platform !== 'win32') {
      fs.symlinkSync(tmp, path.join(tmp, 'link'));
      assert.equal(TIO.historyDirOf(path.join(tmp, 'link'), '/cfg', '/h'), P.historyDir(tmp, '/cfg', '/h'));
    }
    const long = path.join(tmp, 'x'.repeat(210));
    fs.mkdirSync(long);
    const parsed = TR.readArchive(archiveOf());
    assert.equal(codeOf(() => TIO.placeSession(parsed, { targetDir: long, configDir: path.join(tmp, 'cfg'), home: tmp })), 'longPath');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('transfer: secrets stay out (Claude login files, untracked .env, keys), remote URLs lose their passwords', () => {
  for (const f of ['.credentials.json', 'x/.claude.json', '.env', '.env.local', 'config/.env.production', 'id_rsa', 'certs/server.key', 'a.pem', '.claude/settings.local.json', '.netrc', 'login.keychain-db']) assert.equal(TR.isSecretFile(f), true, f);
  for (const f of ['.env.example', 'src/env.js', 'id_rsa.pub', 'README.md', 'keys.ts', '.claude/agents/x.md']) assert.equal(TR.isSecretFile(f), false, f);
  assert.equal(TR.redactRemote('https://user:ghp_secret@github.com/a/b.git'), 'https://github.com/a/b.git');
  assert.equal(TR.redactRemote('https://x-access-token:abc@github.com/a/b'), 'https://github.com/a/b');
  assert.equal(TR.redactRemote('https://ghp_abcdef@github.com/a/b'), 'https://github.com/a/b');
  assert.equal(TR.redactRemote('https://me@gitlab.com/a/b'), 'https://me@gitlab.com/a/b');
  assert.equal(TR.redactRemote('git@github.com:a/b.git'), 'git@github.com:a/b.git');
  assert.ok(TR.remotesMatch(['git@github.com:Isisever/Agent-Office.git'], ['https://github.com/isisever/agent-office']));
  assert.ok(TR.remotesMatch(['ssh://git@github.com:22/a/b.git'], ['https://tok@github.com/a/b/']));
  assert.ok(!TR.remotesMatch(['git@github.com:a/b.git'], ['git@github.com:a/c.git']));
  assert.ok(!TR.remotesMatch([], ['git@github.com:a/b.git']));
});

test('transfer: only an idle session goes (sleep rules: busy boss, prompt, agents, shells, draft)', () => {
  const idle = { sessionId: 's', status: 'idle' };
  const office = { stats: {}, workers: [{ doneAt: 1 }], shells: [{ endAt: 2 }] };
  assert.equal(TR.exportBlocker({ running: false }), '');
  assert.equal(TR.exportBlocker({ running: true, claude: idle, office }), '');
  assert.equal(TR.exportBlocker({ running: true, claude: { sessionId: 's', status: 'busy' }, office }), 'busy');
  assert.equal(TR.exportBlocker({ running: true, claude: idle, office: { stats: { isBossBusy: true } } }), 'busy');
  assert.equal(TR.exportBlocker({ running: true, claude: idle, office: { stats: { waiting: { tool: 'Bash' } } } }), 'waiting');
  assert.equal(TR.exportBlocker({ running: true, claude: idle, office: { stats: {}, workers: [{ doneAt: null }] } }), 'agents');
  assert.equal(TR.exportBlocker({ running: true, claude: idle, office: { stats: {}, shells: [{}] } }), 'shells');
  assert.equal(TR.exportBlocker({ running: true, claude: idle, office, hasDraft: true }), 'draft');
  assert.equal(TR.exportBlocker({ running: true, claude: undefined, office }), 'unknown');
  assert.equal(TR.exportBlocker({ running: true, claude: idle, office: undefined }), 'unknown');
});

test('transfer: checkout plan, file name, versions', () => {
  const base = { base: 'b', isClean: true, branches: ['main', 'feat'], sourceBranch: 'feat', sessionId: '12345678-aaaa' };
  assert.deepEqual(TR.planCheckout({ ...base, head: 'b' }), { action: 'apply' });
  assert.deepEqual(TR.planCheckout({ ...base, head: 'b', isClean: false }), { action: 'dirty' });
  assert.deepEqual(TR.planCheckout({ ...base, head: 'x' }), { action: 'branch', branch: 'agent-office/handoff-12345678' });
  assert.deepEqual(TR.planCheckout({ ...base, head: 'x', sourceBranch: 'new' }), { action: 'branch', branch: 'new' });
  assert.deepEqual(TR.planCheckout({ ...base, head: 'x', branches: ['feat', 'agent-office/handoff-12345678'] }), { action: 'branch', branch: 'agent-office/handoff-12345678-2' });
  assert.deepEqual(TR.planCheckout({ ...base, head: 'x', sourceBranch: null }), { action: 'branch', branch: 'agent-office/handoff-12345678' });
  assert.equal(TR.archiveName('shop', new Date(2026, 9, 2)), 'shop-2026-10-02.agentoffice');
  assert.equal(TR.archiveName('a:b/c', new Date(2026, 0, 1)), 'a-b-c-2026-01-01.agentoffice');
  assert.ok(TR.compareVersions('2.1.200 (Claude Code)', '2.1.296') < 0);
  assert.equal(TR.compareVersions('2.1.296', '2.1.296 (Claude Code)'), 0);
  assert.equal(TR.compareVersions(null, '2.1.296'), 0);
  assert.ok(TR.compareVersions('3.0.0', '2.9.9') > 0);
});

test('transfer: export → file → import into another home at another path (git, memory, office, new id)', async (t) => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { execFileSync } = require('child_process');
  try { execFileSync('git', ['--version']); } catch { return t.skip('git not installed'); }
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ao-move-')));
  const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main', ...args], { cwd, encoding: 'utf8' }).trim();
  const write = (f, s) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s); };
  try {
    // origin with one pushed commit; the source clone has one unpushed commit, a change, a new file, an ignored file and a .env
    const origin = path.join(tmp, 'origin.git');
    git(tmp, 'init', '-q', '--bare', origin);
    const homeA = path.join(tmp, 'a');
    const src = path.join(homeA, 'code', 'shop');
    fs.mkdirSync(src, { recursive: true });
    git(src, 'init', '-q');
    write(path.join(src, 'app.txt'), 'one\n');
    write(path.join(src, 'gone.txt'), 'bye\n');
    write(path.join(src, '.gitignore'), 'build/\n');
    git(src, 'add', '-A'); git(src, 'commit', '-q', '-m', 'first');
    git(src, 'remote', 'add', 'origin', origin);
    git(src, 'push', '-q', '-u', 'origin', 'main');
    git(src, 'checkout', '-q', '-b', 'feature');
    write(path.join(src, 'app.txt'), 'one\ntwo\n');
    git(src, 'commit', '-q', '-am', 'unpushed');
    write(path.join(src, 'app.txt'), 'one\ntwo\nthree (uncommitted)\n');
    fs.rmSync(path.join(src, 'gone.txt'));
    write(path.join(src, 'new.txt'), 'untracked\n');
    write(path.join(src, 'bin.dat'), Buffer.from([0, 1, 2, 3, 255]));
    write(path.join(src, 'build', 'out.js'), 'ignored');
    write(path.join(src, '.env'), 'TOKEN=secret');
    const indexBefore = fs.readFileSync(path.join(src, '.git', 'index'));
    // Claude Code's files for the session in home A
    const id = '0f0e0d0c-1111-4222-8333-444455556666';
    const hist = P.historyDir(src, null, homeA);
    write(path.join(hist, `${id}.jsonl`), [
      JSON.stringify({ type: 'user', cwd: src, sessionId: id, message: { role: 'user', content: 'remember the word banana' } }),
      JSON.stringify({ type: 'assistant', cwd: src, sessionId: id, message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: path.join(src, 'app.txt') } }] } }),
    ].join('\n') + '\n');
    write(path.join(hist, id, 'subagents', 'agent-a1.jsonl'), JSON.stringify({ cwd: src, sessionId: id }) + '\n');
    write(path.join(hist, id, 'subagents', 'agent-a1.meta.json'), '{"agentType":"Explore"}');
    write(path.join(hist, id, 'tool-results', 'r1.txt'), `listing of ${src}\n`);
    write(path.join(hist, id, '.credentials.json'), '{"secret":1}');
    write(path.join(hist, 'other-session.jsonl'), '{}\n');
    const mem = TIO.memoryDirOf(src, homeA);
    write(path.join(mem, 'MEMORY.md'), '- [Rule](rule.md) — a rule\n');
    write(path.join(mem, 'rule.md'), 'always test');
    write(TIO.officeSessionFile(homeA, id), JSON.stringify({ format: 2, project: 'shop', workers: [], shells: [], stats: { delivered: 2 } }));

    const ex = await TIO.collectExport({ dir: src, sessionId: id, configDir: null, home: homeA, appVersion: '0.7.0', claudeVersion: '2.1.296', accountLabel: 'Default', hostname: 'mac-a' });
    const names = ex.entries.map((e) => e.name);
    assert.ok(names.includes(`transcript/${id}.jsonl`));
    assert.ok(names.includes(`transcript/${id}/subagents/agent-a1.jsonl`));
    assert.ok(names.includes(`transcript/${id}/tool-results/r1.txt`));
    assert.ok(!names.some((n) => n.includes('credentials')), 'no credentials');
    assert.ok(!names.some((n) => n.includes('other-session')), 'only this session');
    assert.ok(names.includes('memory/rule.md') && names.includes('memory/MEMORY.md'));
    assert.ok(names.includes(`office/${id}.json`));
    assert.ok(names.includes('git/handoff.bundle') && names.includes('git/changes.patch'));
    assert.equal(ex.manifest.git.branch, 'feature');
    assert.equal(ex.manifest.git.unpushed, 1);
    assert.equal(ex.manifest.git.upstream, null);
    assert.deepEqual(ex.notes.skipped, ['.env']);
    const patch = ex.entries.find((e) => e.name === 'git/changes.patch').data.toString();
    assert.match(patch, /three \(uncommitted\)/);
    assert.match(patch, /new\.txt/);
    assert.doesNotMatch(patch, /TOKEN=secret|out\.js/);
    // the source repository is untouched: same index, no leftover ref, same status
    assert.ok(fs.readFileSync(path.join(src, '.git', 'index')).equals(indexBefore));
    assert.equal(git(src, 'for-each-ref', 'refs/agent-office'), '');

    const file = path.join(tmp, TR.archiveName('shop'));
    TIO.writeArchive(file, ex.entries);
    const parsed = TIO.loadArchive(file);
    assert.equal(parsed.manifest.session.id, id);

    // home B: a clone of origin (without the unpushed commit) at another path, a separate config dir (an account)
    const homeB = path.join(tmp, 'b');
    const dst = path.join(homeB, 'work', 'shop-copy');
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    git(tmp, 'clone', '-q', origin, dst);
    const cfgB = path.join(homeB, 'accounts', 'x');
    write(TIO.memoryDirOf(dst, homeB) + '/rule.md', 'existing rule wins');
    const target = await TIO.inspectTarget(parsed, dst);
    assert.equal(target.isRepo, true);
    assert.equal(target.remoteMatches, true); // both clones of the same origin
    assert.deepEqual(target.plan, { action: 'branch', branch: 'feature' });
    // a dirty tree is refused
    write(path.join(dst, 'app.txt'), 'local edit\n');
    assert.equal((await TIO.inspectTarget(parsed, dst)).plan.action, 'dirty');
    git(dst, 'checkout', '-q', '--', 'app.txt');
    assert.deepEqual(await TIO.prepareGit(parsed, target.top), { ok: true });
    const applied = await TIO.applyGit(parsed, target.top, target.plan);
    assert.deepEqual(applied, { ok: true, branch: 'feature' });
    assert.equal(fs.readFileSync(path.join(dst, 'app.txt'), 'utf8'), 'one\ntwo\nthree (uncommitted)\n');
    assert.equal(fs.readFileSync(path.join(dst, 'new.txt'), 'utf8'), 'untracked\n');
    assert.ok(fs.readFileSync(path.join(dst, 'bin.dat')).equals(Buffer.from([0, 1, 2, 3, 255])));
    assert.ok(!fs.existsSync(path.join(dst, 'gone.txt')));
    assert.ok(!fs.existsSync(path.join(dst, '.env')));
    assert.equal(git(dst, 'rev-parse', 'HEAD'), parsed.manifest.git.head);
    assert.deepEqual(execFileSync('git', ['status', '--porcelain'], { cwd: dst, encoding: 'utf8' }).split('\n').filter(Boolean).sort(), [' D gone.txt', ' M app.txt', '?? bin.dat', '?? new.txt']);
    assert.equal(git(dst, 'for-each-ref', 'refs/agent-office'), '');

    const placed = TIO.placeSession(parsed, { targetDir: dst, configDir: cfgB, home: homeB, gitTop: target.top });
    assert.equal(placed.sessionId, id);
    assert.equal(placed.historyDir, P.historyDir(fs.realpathSync(dst), cfgB, homeB));
    const lines = fs.readFileSync(placed.transcript, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(lines[0].cwd, fs.realpathSync(dst));
    assert.equal(lines[1].message.content[0].input.file_path, path.join(fs.realpathSync(dst), 'app.txt'));
    assert.equal(JSON.parse(fs.readFileSync(path.join(placed.historyDir, id, 'subagents', 'agent-a1.jsonl'), 'utf8')).cwd, fs.realpathSync(dst));
    assert.equal(fs.readFileSync(path.join(placed.historyDir, id, 'tool-results', 'r1.txt'), 'utf8'), `listing of ${fs.realpathSync(dst)}\n`);
    assert.ok(!fs.existsSync(path.join(placed.historyDir, id, '.credentials.json')));
    assert.equal(fs.readFileSync(path.join(TIO.memoryDirOf(dst, homeB), 'rule.md'), 'utf8'), 'existing rule wins');
    assert.equal(JSON.parse(fs.readFileSync(TIO.officeSessionFile(homeB, id), 'utf8')).project, 'shop-copy');
    // the same id again: refused, never overwritten; under a new id it goes in beside it
    assert.equal(codeOf(() => TIO.placeSession(parsed, { targetDir: dst, configDir: cfgB, home: homeB })), 'sessionExists');
    const id2 = '99999999-1111-4222-8333-444455556666';
    const again = TIO.placeSession(parsed, { targetDir: dst, configDir: cfgB, home: homeB, newId: id2 });
    const l2 = fs.readFileSync(again.transcript, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(l2[0].sessionId, id2);
    assert.ok(fs.existsSync(path.join(again.historyDir, id2, 'subagents', 'agent-a1.jsonl')));
    assert.equal(TIO.findSessionFiles(id, cfgB, homeB).length, 1);
    // a target already at the recorded commit: applied in place, no branch
    const dst2 = path.join(homeB, 'work', 'shop-2');
    git(tmp, 'clone', '-q', origin, dst2);
    assert.deepEqual(await TIO.prepareGit(parsed, dst2), { ok: true });
    git(dst2, 'checkout', '-q', '--detach', parsed.manifest.git.head);
    const t2 = await TIO.inspectTarget(parsed, dst2);
    assert.deepEqual(t2.plan, { action: 'apply' });
    assert.deepEqual(await TIO.applyGit(parsed, t2.top, t2.plan), { ok: true, branch: null });
    assert.equal(fs.readFileSync(path.join(dst2, 'new.txt'), 'utf8'), 'untracked\n');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------- work across projects (contract v3.5) ----------
const SS = require('../src/sessions.js');

test('normPath: mutlak yollar tek biçimde; Windows yolları küçük harf ve / ile; göreli yol boş', () => {
  assert.equal(SS.normPath('/a//b/./c/../d/'), '/a/b/d');
  assert.equal(SS.normPath('C:\\Users\\Me\\Shop\\src'), 'c:/users/me/shop/src');
  assert.equal(SS.normPath('c:/Users/me/../..'), 'c:');
  assert.equal(SS.normPath('\\\\Server\\Share\\Repo'), '//server/share/repo');
  assert.equal(SS.normPath('src/a.ts'), '');
  assert.equal(SS.normPath(''), '');
  assert.equal(SS.normPath(undefined), '');
});

test('placeFinder: yolu tutan projenin adı, iç içe projelerde en derini; dışarıdaki ve göreli yol yok sayılır', () => {
  const placeOf = SS.placeFinder([
    { dir: '/w/mono', name: 'mono' },
    { dir: '/w/mono/apps/web', name: 'web' },
    { dir: '/w/shop', name: 'shop' },
    { dir: '/w/shop-wt-2', name: 'shop' },
    { dir: 'C:\\Code\\Blog', name: 'blog' },
    { dir: '', name: 'empty' },
    null,
  ]);
  assert.equal(placeOf('/w/mono/apps/web/src'), 'web');
  assert.equal(placeOf('/w/mono/apps/api'), 'mono');
  assert.equal(placeOf('/w/mono'), 'mono');
  assert.equal(placeOf('/w/shop-wt-2/src'), 'shop');
  assert.equal(placeOf('/w/shopping'), undefined, 'adı yalnız önek olan klasör projenin değil');
  assert.equal(placeOf('/elsewhere/x'), undefined);
  assert.equal(placeOf('relative/dir'), undefined);
  assert.equal(placeOf('c:/code/blog/posts'), 'blog');
  assert.equal(placeOf('C:\\CODE\\Blog\\posts\\a'), 'blog');
  assert.equal(placeOf('D:\\code\\blog'), undefined);
  assert.equal(SS.placeFinder(null)('/w/shop'), undefined);
});

test('projectPlaces: proje klasörü ve worktree sekmelerinin klasörleri projenin adıyla', () => {
  const wt = (root) => ({ root, repo: '/r/shop', branch: 'agent-office/3' });
  assert.deepEqual(P.projectPlaces([
    { id: 'a', dir: '/r/shop', name: 'shop', tabs: [{ n: 2 }, { n: 3, dir: '/r/shop-wt-3', worktree: wt('/r/shop-wt-3') }] },
    { id: 'b', dir: '/r/blog', name: 'blog' },
  ]), [
    { dir: '/r/shop', name: 'shop' },
    { dir: '/r/shop-wt-3', name: 'shop' },
    { dir: '/r/blog', name: 'blog' },
  ]);
});

test('kenar çubuğu durumu: başka projeden çalışılan proje çalışıyor görünür, nereden olduğu yazar', async () => {
  const { projectStatus, isBossHere } = await import('../src/project-status.mjs');
  const en = await tFor('en');
  const tr = await tFor('tr');
  assert.equal(projectStatus(undefined, tr), 'boşta');
  assert.equal(projectStatus({ working: 0, delivered: 0 }, en), 'idle');
  assert.equal(projectStatus({ working: 2, delivered: 5 }, tr), '2 çalışan · 5 teslim');
  const remote = { working: 0, delivered: 0, remote: { working: 2, isBossBusy: false, from: ['shop'] } };
  assert.equal(projectStatus(remote, tr), '2 çalışan · shop projesinden çalışılıyor');
  assert.equal(projectStatus(remote, en), '2 working · worked on from shop');
  const both = { working: 1, delivered: 3, remote: { working: 1, isBossBusy: true, from: ['shop', 'blog'] } };
  assert.equal(projectStatus(both, en), '2 working · 3 delivered · worked on from shop, blog');
  // only the boss works there: no agents to count, still not idle
  const boss = { working: 0, delivered: 0, isBossBusy: false, remote: { working: 0, isBossBusy: true, from: ['shop'] } };
  assert.equal(projectStatus(boss, en), 'worked on from shop');
  assert.equal(isBossHere(boss), true);
  assert.equal(isBossHere({ isBossBusy: false }), false);
  assert.equal(isBossHere(undefined), false);
});

test('nextAttention: başka projeden çalışılan proje meşgul sayılmaz; bitiş bildirimi sahibinden gelir', () => {
  const projects = [{ id: 'a', name: 'shop' }, { id: 'b', name: 'blog' }];
  const office = (busy) => [
    { name: 'shop', working: busy ? 1 : 0, delivered: 0, isBossBusy: busy, waiting: null },
    { name: 'blog', working: 0, delivered: 0, isBossBusy: false, waiting: null, ...(busy ? { remote: { working: 1, isBossBusy: true, from: ['shop'] } } : {}) },
  ];
  let r = N.nextAttention(N.emptyAttention(), projects, office(true), null);
  r = N.nextAttention(r.state, projects, office(true), null);
  r = N.nextAttention(r.state, projects, office(false), null);
  assert.deepEqual(r.events, [{ kind: 'done', id: 'a' }]);
  assert.equal(r.attention.has('b'), false);
});

const SC = require('../src/shared-config.js');

test('shared config: setting per account, default on, never for Default; kept by normalize', () => {
  assert.equal(SC.shareEnabled({ id: 'default', configDir: null }), false);
  assert.equal(SC.shareEnabled({ id: 'w', configDir: '/a/w' }), true);
  assert.equal(SC.shareEnabled({ id: 'w', configDir: '/a/w', shareDefault: false }), false);
  let s = P.normalizeState({ accounts: [{ id: 'w', label: 'W', configDir: '/a/w' }] });
  assert.equal(A.setAccountShare(s, 'default', false), s);
  assert.equal(A.setAccountShare(s, 'w', true), s);
  s = A.setAccountShare(s, 'w', false);
  assert.equal(s.accounts[1].shareDefault, false);
  assert.equal(P.normalizeState(JSON.parse(JSON.stringify(s))).accounts[1].shareDefault, false);
  s = A.setAccountShare(s, 'w', true);
  assert.equal('shareDefault' in s.accounts[1], false);
});

test('shared config: MCP servers from ~/.claude.json minus the names the account or the project has', () => {
  const defaultConfig = { mcpServers: { a: { type: 'http', url: 'u', headers: { Authorization: 'Bearer t' } }, own: { command: 'x' }, loc: { command: 'y' }, proj: { command: 'z' }, bad: 1 }, oauthAccount: { email: 'e' } };
  const accountConfig = { mcpServers: { own: { command: 'mine' } }, projects: { '/p': { mcpServers: { loc: {} } } } };
  assert.deepEqual(SC.sharedMcpServers({ defaultConfig, accountConfig, cwd: '/p', projectMcp: { mcpServers: { proj: {} } } }),
    { mcpServers: { a: defaultConfig.mcpServers.a } });
  assert.deepEqual(Object.keys(SC.sharedMcpServers({ defaultConfig, accountConfig: null, cwd: '/q', projectMcp: null }).mcpServers), ['a', 'own', 'loc', 'proj']);
  assert.equal(SC.sharedMcpServers({ defaultConfig: {}, accountConfig: null }), null);
  assert.equal(SC.sharedMcpServers({ defaultConfig: { mcpServers: { own: {} } }, accountConfig }), null);
});

test('shared config: enabled user plugins, not Agent Office, not synced, not those the account enabled itself', () => {
  const rec = (p, scope = 'user') => [{ scope, installPath: p }];
  const installed = { plugins: {
    'a@m': rec('/c/a'), 'off@m': rec('/c/off'), 'proj@m': rec('/c/proj', 'project'), 'agent-office@t': rec('/c/ao'),
    'mine@m': rec('/c/mine'), 'syn@s': rec('/h/plugins/synced/syn'), 'v@m': rec('/c/v'),
  } };
  const settings = { enabledPlugins: { 'a@m': true, 'off@m': false, 'proj@m': true, 'agent-office@t': true, 'mine@m': true, 'syn@s': true, 'v@m': ['1.0'] } };
  const accountInstalled = { plugins: { 'mine@other': rec('/acc/mine') } };
  const accountSettings = { enabledPlugins: { 'mine@other': true } };
  assert.deepEqual(SC.sharedPlugins({ installed, settings, accountInstalled, accountSettings, syncedDir: '/h/plugins/synced' }).map((p) => p.key), ['a@m', 'v@m']);
  assert.deepEqual(SC.sharedPlugins({ installed, settings, syncedDir: '/h/plugins/synced' }).map((p) => p.key), ['a@m', 'mine@m', 'v@m']);
  assert.deepEqual(SC.sharedPlugins({ installed, settings, accountInstalled, accountSettings: {} }).find((p) => p.key === 'mine@m'),
    { key: 'mine@m', name: 'mine', marketplace: 'm', installPath: '/c/mine' });
  assert.deepEqual(SC.pluginManifest({ name: 'swift-lsp', version: '1', source: './p', category: 'd', strict: false, tags: [], lspServers: { s: { command: 'x' } } }),
    { name: 'swift-lsp', version: '1', lspServers: { s: { command: 'x' } } });
  assert.equal(SC.stageName('a b/c@m'), 'a-b-c@m');
});

test('shared config: link plan skips skills/synced and dot entries', () => {
  const plan = SC.linkPlan({ skills: ['synced', '.DS_Store', 'tidy'], agents: ['r.md'], commands: [], files: ['CLAUDE.md'] }, '/h/.claude');
  assert.deepEqual(plan.map((p) => p.rel), ['skills/tidy', 'agents/r.md', 'CLAUDE.md']);
  assert.equal(plan[0].target, pathT.join('/h/.claude', 'skills', 'tidy'));
});

test('shared config: a session start links, stages and writes the MCP file; never clobbers; off undoes only its own', (t) => {
  const root = fsT.realpathSync(fsT.mkdtempSync(pathT.join(osT.tmpdir(), 'ao-shared-')));
  t.after(() => fsT.rmSync(root, { recursive: true, force: true }));
  const j = (...p) => pathT.join(root, ...p);
  const w = (p, txt) => { fsT.mkdirSync(pathT.dirname(p), { recursive: true }); fsT.writeFileSync(p, txt); };
  const home = j('home'); const cd = j('home', '.claude'); const acc = j('acc'); const proj = j('proj');
  w(pathT.join(cd, 'skills', 'tidy', 'SKILL.md'), 'tidy');
  w(pathT.join(cd, 'skills', 'mine', 'SKILL.md'), 'default mine');
  w(pathT.join(cd, 'skills', 'synced', 'x', 'SKILL.md'), 'default synced');
  w(pathT.join(cd, 'agents', 'r.md'), 'agent');
  w(pathT.join(cd, 'CLAUDE.md'), 'rules');
  w(pathT.join(cd, '.credentials.json'), 'secret');
  const cache = (n) => pathT.join(cd, 'plugins', 'cache', 'm', n, '1');
  w(pathT.join(cache('fd'), '.claude-plugin', 'plugin.json'), '{"name":"fd"}');
  w(pathT.join(cache('lsp'), 'README.md'), 'readme');
  w(pathT.join(cd, 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: {
    'fd@m': [{ scope: 'user', installPath: cache('fd') }], 'lsp@m': [{ scope: 'user', installPath: cache('lsp') }],
  } }));
  w(pathT.join(cd, 'plugins', 'known_marketplaces.json'), JSON.stringify({ m: { installLocation: j('mkt') } }));
  w(j('mkt', '.claude-plugin', 'marketplace.json'), JSON.stringify({ plugins: [{ name: 'lsp', strict: false, source: './x', lspServers: { s: { command: 'sk' } } }] }));
  w(pathT.join(cd, 'settings.json'), JSON.stringify({ enabledPlugins: { 'fd@m': true, 'lsp@m': true } }));
  w(pathT.join(home, '.claude.json'), JSON.stringify({ oauthAccount: { email: 'e' }, primaryApiKey: 'k', mcpServers: { s1: { type: 'http', url: 'u', headers: { Authorization: 'Bearer t' } }, own: { command: 'd' } } }));
  w(pathT.join(acc, 'skills', 'mine', 'SKILL.md'), 'account mine');
  w(pathT.join(acc, 'skills', 'synced', 'y', 'SKILL.md'), 'account synced');
  w(pathT.join(acc, '.claude.json'), JSON.stringify({ mcpServers: { own: { command: 'a' } } }));
  fsT.mkdirSync(proj);
  const opts = (account) => ({ account, home, cwd: proj, stageRoot: j('ud', 'shared-plugins'), mcpFile: j('ud', 'mcp', 'p1.json') });
  const account = { id: 'w', configDir: acc };

  const r = SC.prepareShared(opts(account));
  const stage = j('ud', 'shared-plugins', 'lsp@m');
  assert.deepEqual(r.pluginDirs, [cache('fd'), stage]);
  assert.deepEqual(SC.sharedArgs(r), ['--plugin-dir', cache('fd'), '--plugin-dir', stage, '--mcp-config', j('ud', 'mcp', 'p1.json')]);
  assert.deepEqual(JSON.parse(fsT.readFileSync(pathT.join(stage, '.claude-plugin', 'plugin.json'), 'utf8')), { name: 'lsp', lspServers: { s: { command: 'sk' } } });
  assert.equal(fsT.readFileSync(pathT.join(stage, 'README.md'), 'utf8'), 'readme');
  const mcp = JSON.parse(fsT.readFileSync(r.mcpConfig, 'utf8'));
  assert.deepEqual(Object.keys(mcp.mcpServers), ['s1']);
  assert.equal(JSON.stringify(mcp).includes('oauthAccount') || JSON.stringify(mcp).includes('primaryApiKey'), false);
  if (process.platform !== 'win32') assert.equal(fsT.statSync(r.mcpConfig).mode & 0o777, 0o600);
  assert.equal(fsT.readFileSync(pathT.join(acc, 'skills', 'tidy', 'SKILL.md'), 'utf8'), 'tidy');
  assert.equal(fsT.readFileSync(pathT.join(acc, 'skills', 'mine', 'SKILL.md'), 'utf8'), 'account mine');
  assert.equal(fsT.readFileSync(pathT.join(acc, 'skills', 'synced', 'y', 'SKILL.md'), 'utf8'), 'account synced');
  assert.equal(fsT.existsSync(pathT.join(acc, 'skills', 'synced', 'x')), false);
  assert.equal(fsT.readFileSync(pathT.join(acc, 'agents', 'r.md'), 'utf8'), 'agent');
  assert.equal(fsT.readFileSync(pathT.join(acc, 'CLAUDE.md'), 'utf8'), 'rules');
  assert.equal(fsT.existsSync(pathT.join(acc, '.credentials.json')), false);
  assert.deepEqual(JSON.parse(fsT.readFileSync(pathT.join(acc, SC.MARKER), 'utf8')), ['CLAUDE.md', 'agents/r.md', 'skills/tidy']);

  // the same start again changes nothing; a skill removed from ~/.claude loses its link
  assert.deepEqual(SC.prepareShared(opts(account)), r);
  fsT.rmSync(pathT.join(cd, 'skills', 'tidy'), { recursive: true });
  SC.prepareShared(opts(account));
  assert.equal(fsT.existsSync(pathT.join(acc, 'skills', 'tidy')), false);
  // a plugin the account enabled itself is not passed (its stage stays for other accounts)
  w(pathT.join(acc, 'plugins', 'installed_plugins.json'), JSON.stringify({ plugins: { 'lsp@m': [{ scope: 'user', installPath: '/x' }] } }));
  w(pathT.join(acc, 'settings.json'), JSON.stringify({ enabledPlugins: { 'lsp@m': true } }));
  assert.deepEqual(SC.prepareShared(opts(account)).pluginDirs, [cache('fd')]);
  assert.equal(fsT.existsSync(stage), true);

  // off: the app's links, marker and MCP file go; the account's own entries and every source stay
  assert.deepEqual(SC.prepareShared(opts({ ...account, shareDefault: false })), { pluginDirs: [], mcpConfig: null });
  assert.equal(fsT.existsSync(pathT.join(acc, 'agents', 'r.md')), false);
  assert.equal(fsT.existsSync(pathT.join(acc, 'CLAUDE.md')), false);
  assert.equal(fsT.existsSync(pathT.join(acc, SC.MARKER)), false);
  assert.equal(fsT.existsSync(j('ud', 'mcp', 'p1.json')), false);
  assert.equal(fsT.readFileSync(pathT.join(acc, 'skills', 'mine', 'SKILL.md'), 'utf8'), 'account mine');
  assert.equal(fsT.readFileSync(pathT.join(cd, 'agents', 'r.md'), 'utf8'), 'agent');
  assert.equal(fsT.readFileSync(pathT.join(cd, 'CLAUDE.md'), 'utf8'), 'rules');
  assert.equal(fsT.readFileSync(pathT.join(cache('lsp'), 'README.md'), 'utf8'), 'readme');
  // Default: nothing at all
  assert.deepEqual(SC.prepareShared(opts({ id: 'default', configDir: null })), { pluginDirs: [], mcpConfig: null });
  // a plugin uninstalled from Default: its stage is removed, its source untouched
  w(pathT.join(cd, 'settings.json'), JSON.stringify({ enabledPlugins: { 'fd@m': true } }));
  SC.prepareShared(opts(account));
  assert.equal(fsT.existsSync(stage), false);
  assert.equal(fsT.readFileSync(pathT.join(cache('lsp'), 'README.md'), 'utf8'), 'readme');
});

test('shared config: MCP files with tokens live only while their tab runs; Default and off leave none', (t) => {
  assert.deepEqual(SC.staleMcpFiles(['p1.json', 'p1-2.json', 'old.json', 'p1.json.123'], ['p1', 'p1-2']), ['old.json', 'p1.json.123']);
  const root = fsT.mkdtempSync(pathT.join(osT.tmpdir(), 'ao-mcp-'));
  t.after(() => fsT.rmSync(root, { recursive: true, force: true }));
  const dir = pathT.join(root, 'mcp');
  fsT.mkdirSync(dir);
  for (const n of ['a.json', 'b-2.json', 'gone.json']) fsT.writeFileSync(pathT.join(dir, n), '{"mcpServers":{}}');
  assert.deepEqual(SC.pruneMcpFiles(dir, ['a', 'b-2']).sort(), ['gone.json']);
  assert.deepEqual(fsT.readdirSync(dir).sort(), ['a.json', 'b-2.json']);
  assert.deepEqual(SC.pruneMcpFiles(dir).sort(), ['a.json', 'b-2.json']); // app start: no tab runs yet
  assert.deepEqual(SC.pruneMcpFiles(pathT.join(root, 'missing')), []);
  // a tab whose project moved to Default: its old file goes at the next start
  const mcpFile = pathT.join(dir, 'p.json');
  fsT.writeFileSync(mcpFile, '{"mcpServers":{"s":{"headers":{"Authorization":"Bearer t"}}}}');
  assert.deepEqual(SC.prepareShared({ account: { id: 'default', configDir: null }, home: root, cwd: null, stageRoot: pathT.join(root, 'st'), mcpFile }), { pluginDirs: [], mcpConfig: null });
  assert.equal(fsT.existsSync(mcpFile), false);
});

// --- interrupted work (src/resume.js)
test('yarım iş: işaretler state.json\'dan okunur, garip olanlar ve olmayan sekmeler atılır', () => {
  const R = require('../src/resume.js');
  assert.deepEqual(R.normalizeInterrupted(undefined), {});
  assert.deepEqual(R.normalizeInterrupted([]), {});
  assert.deepEqual(R.normalizeInterrupted('x'), {});
  assert.deepEqual(R.normalizeInterrupted({ a: 'sid-1', 'a:2': 42, b: '../x' }), { a: 'sid-1', 'a:2': '', b: '' });
  assert.deepEqual(R.normalizeInterrupted({ a: 'sid-1', gone: 's' }, ['a', 'a:2']), { a: 'sid-1' });
});

test('yarım iş: meşgul mü (claude pid dosyası önce, yoksa ofis dosyasının isBossBusy\'si)', () => {
  const { isTurnBusy } = require('../src/resume.js');
  assert.equal(isTurnBusy({ claude: { status: 'busy' } }), true);
  assert.equal(isTurnBusy({ claude: { status: 'waiting' } }), true);
  assert.equal(isTurnBusy({ claude: { status: 'idle' }, office: { stats: { isBossBusy: true } } }), false, 'a killed claude\'s stale office file does not count');
  assert.equal(isTurnBusy({ claude: {}, office: { stats: { isBossBusy: true } } }), true);
  assert.equal(isTurnBusy({ claude: undefined, office: { stats: { isBossBusy: false } } }), false);
  assert.equal(isTurnBusy({ office: { endedAt: 1, stats: { isBossBusy: true } } }), false);
  assert.equal(isTurnBusy({}), false);
});

test('yarım iş: meşgulken işaretlenir, tur bitince silinir; değişiklik yoksa aynı nesne', () => {
  const { nextInterrupted, clearInterrupted } = require('../src/resume.js');
  const none = {};
  assert.equal(nextInterrupted(none, 'p', { busy: false }), none);
  const a = nextInterrupted(none, 'p', { busy: true });
  assert.deepEqual(a, { p: '' });
  assert.deepEqual(none, {}, 'not mutated');
  const b = nextInterrupted(a, 'p', { busy: true, sessionId: 'abc-1' });
  assert.deepEqual(b, { p: 'abc-1' });
  assert.equal(nextInterrupted(b, 'p', { busy: true, sessionId: 'abc-1' }), b);
  assert.equal(nextInterrupted(b, 'p', { busy: true }), b, 'a known session id is kept');
  assert.deepEqual(nextInterrupted(b, 'p', { busy: true, sessionId: '$(rm)' }), { p: 'abc-1' }, 'odd ids are ignored');
  const c = nextInterrupted(b, 'p:2', { busy: true, sessionId: 'def' });
  assert.deepEqual(c, { p: 'abc-1', 'p:2': 'def' });
  assert.deepEqual(nextInterrupted(c, 'p', { busy: false }), { 'p:2': 'def' });
  assert.deepEqual(clearInterrupted(c, ['p', 'p:2', 'x']), {});
  assert.equal(clearInterrupted(c, ['x']), c);
});

test('yarım iş: açılışta yalnız iki ayar da açıkken ve var olan sekmeler devam eder', () => {
  const { resumeTargets } = require('../src/resume.js');
  const m = { a: 's1', 'a:2': '', gone: 's3' };
  assert.deepEqual(resumeTargets(m, ['a', 'a:2', 'b'], { resume: true, resumeWork: true }), ['a', 'a:2']);
  assert.deepEqual(resumeTargets(m, ['a', 'b'], {}), ['a'], 'both default on');
  assert.deepEqual(resumeTargets(m, ['a'], { resume: false, resumeWork: true }), []);
  assert.deepEqual(resumeTargets(m, ['a'], { resume: true, resumeWork: false }), []);
  assert.deepEqual(resumeTargets({}, ['a'], {}), []);
});

test('yarım iş: istem tek satır, cmd.exe özel karakterleri yok, - ile başlamaz', () => {
  const { promptArg, RESUME_PROMPT } = require('../src/resume.js');
  assert.equal(promptArg(RESUME_PROMPT), RESUME_PROMPT, 'the real prompt needs no change');
  assert.ok(RESUME_PROMPT.length > 80 && !/["%!^\n]/.test(RESUME_PROMPT));
  assert.equal(promptArg('a\nb\r\n\tc'), 'a b c');
  assert.equal(promptArg('say "hi" 100% now! ^x'), 'say hi 100 now x');
  assert.equal(promptArg('--help me'), 'help me');
  assert.equal(promptArg(' - x'), 'x');
  assert.equal(promptArg(undefined), '');
});

test('yarım iş: istem yalnız devam ederken, devam argümanlarından sonra en sona eklenir', () => {
  const { claudeArgs, RESUME_PROMPT } = require('../src/resume.js');
  const base = ['--plugin-dir', '/p', '--mcp-config', '/m.json', '--settings', '{"a":1}'];
  assert.deepEqual(claudeArgs(base, [], RESUME_PROMPT), base, 'a fresh start gets no prompt');
  assert.deepEqual(claudeArgs(base, ['--continue']), [...base, '--continue']);
  assert.deepEqual(claudeArgs(base, ['--continue'], RESUME_PROMPT), [...base, '--continue', RESUME_PROMPT]);
  assert.deepEqual(claudeArgs(base, ['--resume', 'abc'], RESUME_PROMPT), [...base, '--resume', 'abc', RESUME_PROMPT]);
  assert.deepEqual(claudeArgs(base, ['--resume', 'abc'], '"%!'), [...base, '--resume', 'abc'], 'nothing left: no empty argument');
});

test('yarım iş: macOS/Linux kabuğu istemi tek argüman olarak aynen geçirir ("$@")', { skip: process.platform === 'win32' }, () => {
  const { execFileSync } = require('child_process');
  const { claudeArgs, RESUME_PROMPT } = require('../src/resume.js');
  const args = claudeArgs(['--settings', '{"statusLine":{"command":"x $HOME `id`"}}'], ['--resume', 'abc-1'], RESUME_PROMPT);
  // the same shape as startPty: $SHELL -c '<cmd>' claude ...args; printf stands in for claude
  const out = execFileSync('/bin/sh', ['-c', 'exec printf "%s\\0" "$@"', 'claude', ...args], { encoding: 'utf8' });
  assert.deepEqual(out.split('\0').slice(0, -1), args);
});

test('yarım iş: Windows — claude.exe argümanları olduğu gibi, claude.cmd satırında istem tırnak içinde tek parça', () => {
  const OSw = require('../src/platform.js');
  const { claudeArgs, RESUME_PROMPT } = require('../src/resume.js');
  const args = claudeArgs(['--settings', 'C:\\u\\s.json'], ['--resume', 'abc-1'], RESUME_PROMPT);
  const exe = OSw.windowsCommand('C:\\bin\\claude.exe', args, {});
  assert.equal(exe.verbatim, false);
  assert.deepEqual(exe.args, args);
  const cmd = OSw.windowsCommand('C:\\npm\\claude.cmd', args, { ComSpec: 'C:\\Windows\\system32\\cmd.exe' });
  assert.equal(cmd.verbatim, true);
  assert.equal(cmd.args[3], `"C:\\npm\\claude.cmd --settings C:\\u\\s.json --resume abc-1 "${RESUME_PROMPT}""`);
  // inside the quotes cmd.exe leaves (), &, | alone; the prompt has no " % ! ^ that it would still act on
  assert.ok(!/["%!^]/.test(RESUME_PROMPT));
});
