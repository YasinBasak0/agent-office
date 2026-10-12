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
  assert.equal(M.memoryBase('/r/sub', '/r\n/r/.git\n'), '/r');
  assert.equal(M.memoryBase('/r-wt-2', '/r-wt-2\n/r/.git\n'), '/r');
  assert.equal(M.memoryBase('/x', ''), '/x');
  assert.equal(M.memoryBase('/s', '/s\n/r/.git/modules/s\n'), '/s');
  assert.equal(M.sharedMemoryDir({ configDir: null, home: '/h', base: '/r' }), null);
  assert.equal(M.sharedMemoryDir({ configDir: '/acc/w', home: '/h', base: '/r' }), '/h/.claude/projects/-r/memory');
  assert.equal(M.accountMemoryDir({ configDir: '/acc/w', base: '/r' }), '/acc/w/projects/-r/memory');
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
  // idempotent; a missing source or target folder is fine
  assert.deepEqual(M.mergeMemory(from, to), []);
  assert.deepEqual(M.mergeMemory(pathT.join(root, 'none'), to), []);
  const fresh = pathT.join(root, 'fresh', 'memory');
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
