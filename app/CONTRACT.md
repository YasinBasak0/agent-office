# Module contract (shell ↔ office), v2: several projects, one boss, several accounts

Three parts are built in parallel; this file fixes the seams between them. Change it only together with every side.

## Owners

| Part | Files |
| --- | --- |
| Main | `main.js`, `preload.js`, `src/projects.js` (new), `src/accounts.js` (new) |
| UI | `renderer/index.html`, `renderer/app.js`, `renderer/terminal.js`, `renderer/style.css`, `renderer/sidebar.js` (new) |
| Office | `src/sessions.js`, `src/office/core.mjs`, `renderer/office-view.js` |

All UI text is Turkish.

## Model

```ts
type Project = { id: string; dir: string; name: string; accountId: string }   // name = basename(dir); id stable (random)
type Account = { id: string; label: string; configDir: string | null; auth: AccountAuth; shareDefault?: false }  // 'default': label 'Varsayılan', configDir null (system ~/.claude); shareDefault: v3.6
type AccountAuth = { state: 'checking' | 'in' | 'out' | 'error'; email?: string; method?: string; error?: string }
// from `claude auth status --json` run with that account's CLAUDE_CONFIG_DIR: loggedIn → 'in' (email, authMethod), else 'out'
type ProjectStatus = { id: string; isRunning: boolean }                       // claude pty alive
```

- Main keeps `projects`, `accounts` and `activeId` in `userData/state.json`. The old `lastProject` becomes the first project on upgrade.
- Every project has its own `claude` pty, started when the project is added or the app opens, and kept running in the background while another project is shown (v3.3 sleeping changes this when it is on: see the end of this file). Removing a project kills its pty (does not touch the folder).
- An account other than default has `configDir = userData/accounts/<id>`; its ptys start with `CLAUDE_CONFIG_DIR=<configDir>`, so claude keeps that account's login and settings apart. Logging in: the sidebar's "Giriş yap" (see v2.1); `/login` in a project terminal also works. Changing a project's account restarts its pty.
- **Project memory always comes from `~/.claude`** (`src/memory.js`). A session of a non-default account would otherwise read and write its own `<configDir>/projects/<slug>/memory/`, missing the rules the user built up in plain Claude Code. So at every pty start main computes the memory key as Claude Code does, from the disk without running git (the real path with symlinks resolved; the repository's main working copy, shared by all worktrees; else the git root; else the folder; slug = non-alphanumerics of the NFC path → `-`), merges the account's memory into `~/.claude/projects/<slug>/memory/` without overwriting anything (missing files are copied and their `MEMORY.md` index lines appended; the existing memory wins; each file is merged once, recorded in the account folder's `.agent-office-merged.json`, so a memory deleted from `~/.claude` is not copied back), and adds `autoMemoryDirectory: <that folder>` to the session's `--settings` JSON, so new memories land there too and the two never diverge. The default account already uses `~/.claude` and gets nothing extra. A path whose slug would exceed 200 characters (Claude Code adds a hash) keeps the account's own memory.
- The office always shows all projects at once (the boss oversees all of them); the active project only picks the theme and is highlighted.

## `window.agentOffice` (preload)

```ts
agentOffice.projects.list(): Promise<{ projects: Project[]; activeId: string | null; status: ProjectStatus[] }>
agentOffice.projects.add(): Promise<Project | null>                  // folder dialog; starts its claude; makes it active
agentOffice.projects.remove(id: string): Promise<void>
agentOffice.projects.setActive(id: string): Promise<void>
agentOffice.projects.setAccount(id: string, accountId: string): Promise<void>   // restarts that project's claude
agentOffice.projects.onChange(cb: (s: { projects: Project[]; activeId: string | null; status: ProjectStatus[] }) => void): () => void

agentOffice.accounts.list(): Promise<Account[]>
agentOffice.accounts.add(label: string): Promise<Account>
agentOffice.accounts.rename(id: string, label: string): Promise<void>
agentOffice.accounts.setShare(id: string, on: boolean): Promise<void> // v3.6: use Default's plugins, skills and MCP servers (not 'default')
agentOffice.accounts.remove(id: string): Promise<void>                // not 'default'; its projects move to 'default' (restarted)
agentOffice.accounts.onChange(cb: (accounts: Account[]) => void): () => void   // after add / rename / remove and every auth change ('accounts:changed')
agentOffice.accounts.refreshAuth(id?: string): Promise<Account[]>     // re-run auth status (one account, or all)
agentOffice.accounts.login(id: string): Promise<void>                 // starts a login pty with id `login:<accountId>` running `claude auth login`
agentOffice.accounts.logout(id: string): Promise<void>                // runs `claude auth logout` for that account, then refreshes

agentOffice.pty.write(projectId: string, data: string): void
agentOffice.pty.resize(projectId: string, cols: number, rows: number): void
agentOffice.pty.onData(cb: (projectId: string, data: string) => void): () => void
agentOffice.pty.onExit(cb: (projectId: string, code: number) => void): () => void
agentOffice.pty.restart(projectId: string): void

agentOffice.office.onData(cb: (data: OfficeData) => void): () => void
agentOffice.office.themes(): Promise<Record<string, ThemeSpec>>
agentOffice.clipboard.hasImage(): Promise<boolean>
agentOffice.clipboard.read(): Promise<{ hasImage: boolean, text: string, files: string[] }>  // files: copied in Finder (osascript), on Linux a file manager (text/uri-list via Electron, wl-paste or xclip), on Windows Explorer (CF_HDROP / FileNameW via Electron, else PowerShell's Get-Clipboard)
agentOffice.platform: 'darwin' | 'linux' | 'win32'                     // process.platform; renderer/platform.js sets <html class="platform-…"> and picks the shortcuts
agentOffice.pathForFile(file: File): string
```

The sidebar's add button adds projects; ⌘O = add project, ⌘1…9 = switch, ⌘V = paste into the focused terminal. On Linux the same keys are Ctrl+Shift+O, Ctrl+Shift+1…9 and Ctrl+Shift+V (Ctrl+Shift+C / X copy and cut from the menu), because plain Ctrl+… keys belong to Claude Code in the terminal. In the terminal, ⌘Enter (macOS) and Ctrl+Enter are sent to Claude Code as ctrl+enter (`ESC [13;5u`, `src/terminal-keys.mjs`), its send-now key for a queued message; xterm.js alone would send a bare Enter. Linux windows use the system title bar (no traffic-light inset), and the in-app updater runs only in the AppImage. Windows is like Linux (system title bar, Ctrl+Shift keys) except: claude starts directly in a ConPTY (no login shell: found on PATH or in the native installer's folder, npm's `claude.cmd` through `cmd.exe /d /s /c`; the `--settings` JSON goes in a file under `userData/settings/`; if Claude Code is missing the terminal says so and exits with 127), an image paste sends Claude Code's Alt+V (`ESC v`) instead of Ctrl+V, pasted paths get double quotes, the taskbar button gets a dot overlay and flashes instead of a Dock badge, and the NSIS install updates itself (`latest.yml`).

## `src/sessions.js` (main)

```ts
readOffice(projects: string[] | null, now = Date.now()): OfficeData   // project names to include; null = all live sessions
readThemes(): Record<string, ThemeSpec>                                 // also records themesError

type OfficeData = {
  workers: (Worker & { project: string })[]          // every worker carries its project name
  delivered: number                                    // TODAY, all projects: doneAt or stats.today ids on the local day, ended sessions included
  isBossBusy: boolean                                  // any project busy
  projects: { name: string; working: number; delivered: number; isBossBusy: boolean }[]   // per project, same rules
  project: string; sessionId: string                   // newest session (theme fallback)
  themesError?: string                                 // themes.json present but unreadable
}
```

Main polls every 500 ms with the names of all open projects and sends the result on `office:data`.

## `renderer/office-view.js`

```ts
mountOffice(canvas, opts: { onTheme(t: ThemeInfo): void }): {
  setData(d: OfficeData): void
  setThemes(t): void
  setFocus(projectName: string | null): void   // theme comes from this project; its desks are highlighted
  destroy(): void
}
```

## CSS variables (set by app.js from ThemeInfo)

`--frame`, `--accent`, `--status-bg`, `--status-text`; the xterm theme uses the same colors (background = statusBg).

## Account login (v2.1)

- Main checks every account's auth at start (state 'checking' until done), after a login pty exits, after logout, when the window regains focus (at most once a minute) and on `refreshAuth`. Checks run through the user's login shell (`$SHELL -l -c`) so `claude` is on PATH, with the same env rules and shell flags (`$SHELL -l -i -c`) as the project ptys (`ptyEnv`).
- A login pty uses the normal pty channel with projectId `login:<accountId>`: `pty.onData`, `pty.write`, `pty.resize`, `pty.onExit` work as for projects. Only one login pty per account; `login` while one is running replaces it (the old one is killed without an exit event). `logout` is refused for the default account. When it exits, main refreshes that account's auth and sends `accounts:changed`. It is never listed in `projects:changed`.
- UI: every account row shows its auth (email, "giriş yapılmadı", "kontrol ediliyor…", or the error). Non-logged-in accounts get "Giriş yap"; logged-in non-default accounts get "Çıkış yap" (confirm). Adding an account immediately offers "Giriş yap". "Giriş yap" opens an overlay with an xterm attached to `login:<id>` that closes itself shortly after the pty exits. A project whose account is 'out' shows a warning on its row with a "Giriş yap" shortcut.

## Agent details (v2.2)

Clicking a bot in the office opens a panel with what that agent is doing.

Worker (written by the plugin in `sessions/<session>.json`, passed through by `readOffice`) gains optional fields; old files without them keep working:

```ts
type Worker = {
  id: string; type: string; description: string; spawnAt: number; tool?: string; doneAt?: number; isOk?: boolean
  prompt?: string                                     // the task given to the agent, first 600 chars
  detail?: string                                     // the current tool's input in one line, ≤ 160 chars (Bash: command; Read/Edit/Write: file path; Grep/Glob: pattern [in path]; WebFetch: url; WebSearch: query; other: compact JSON)
  history?: { at: number; tool: string; detail: string }[]   // last 20 tool calls, oldest first
  toolCount?: number                                  // all tool calls so far
  result?: string                                     // the agent's final answer, first 4000 chars (v2.6; 600 before), once done
}
```

Office (`renderer/office-view.js`): `mountOffice(canvas, { onTheme, onSelect(id: string | null) })`; clicking a bot calls `onSelect(worker.id)`, clicking empty floor calls `onSelect(null)`; `setSelected(id | null)` draws a marker over the selected bot (at its desk, walking, at the boss or dancing). `core.mjs` exports `hitTest(px, py)` in canvas pixels → worker id or null, using the positions of the last rendered frame; the cursor is a pointer over a bot.

Panel (`renderer/agent-panel.js`, new): `mountAgentPanel(el, { onClose })` → `{ show(id), update(data: OfficeData), hide() }`. Shows project, type, status (working / done ✓ / failed ✗) with elapsed time, description, prompt, current tool + detail, the history list (newest first, relative times), tool count and, when done, the result. It updates live from `update` and says "Ajan ofisten ayrıldı" when the id disappears. Esc closes it. All text Turkish.

Implementation notes (v2.2):

- `core.mjs`: the selection is passed per frame as `render(now, data, { focus, selected })` (no separate core `setSelected`); office-view keeps it and redraws on `setSelected`. The marker is accent-coloured corner brackets around the bot plus a bobbing arrow above it (above its tag when it has one); an id that is not drawn draws nothing.
- `hitTest(px, py)` maps canvas backing-store pixels (the `drawImage` space: the frame is centred in the canvas given to `setGeometry`) to the top-most bot or its tag, with 3 logical px of slack; `hitBoxes()` returns the last frame's boxes (tests). Party dancers keep their worker id, so they stay clickable after the worker has left the data (the panel then says "Ajan ofisten ayrıldı").
- The boss is selectable too: `BOSS_ID = '@boss'` (exported by `core.mjs`). The panel shows a summary for it (busy/idle, today's count, per-project working/delivered, working agents; clicking an agent switches to it).
- Panel options: `mountAgentPanel(el, { onClose, onSelect(id), anchor })`; `onSelect` fires when the panel itself switches agents (boss list), `anchor` (the office canvas) makes the panel cover exactly that box. Extra methods: `shownId()`, `destroy()`. Esc closes it unless focus is in a terminal (Esc there belongs to Claude); the panel takes focus when it opens. Clicking empty floor closes it.
- `dev-mock.js`: `?select=<id|@boss>` clicks that bot through the real click path after a few seconds (mock workers `m-1`…`m-4`; `m-3` is old data without the new fields).

## Background shells (v2.3)

Background shell commands (Bash with `run_in_background`, and similar long-running background tasks Claude starts) are shown in the office's server room.

The plugin adds to the session state file:

```ts
type Shell = {
  id: string            // stable id (the background task id if the engine gives one, else the tool_use_id)
  command: string       // one line, ≤ 160 chars (same rule as Worker.detail)
  description?: string  // the tool call's description, if any
  agentId?: string      // set when a subagent started it
  startAt: number
  endAt?: number        // when it finished (or was killed); omitted while running
  exitCode?: number
  status?: 'running' | 'completed' | 'failed' | 'killed'
}
// session file: { ..., shells?: Shell[] }  — running ones plus those finished in the last forgetMinutes; at most 20
```

`readOffice` passes them through as `OfficeData.shells: (Shell & { project: string })[]`.

Office: each running shell lights one rack slot in the server room (blinking LEDs, the rack's label shows a short command), finished ones show a green (exit 0) or red light until they are forgotten. Clicking a rack slot calls `onSelect('shell:<id>')`; the agent panel shows the command, project, status, elapsed time, exit code and which agent started it. When more shells run than slots exist, the last slot shows "+n".

Implementation notes (v2.3, app):

- `readOffice`: live sessions pass all their shells; a session that is not live passes only shells that finished within the forget window (`settings.json` `forgetMinutes`, 1-60, default 5, same rule as the plugin). A shell still "running" in an ended session is passed as `status: 'killed'`, `endAt = endedAt`; running shells of a stale but not ended session are left out. Sorted by `startAt`; the project filter applies. Old session files without `shells` give `shells: []`.
- `core.mjs`: 3 slots per rack (9 in all), filled across the racks' top row first; running shells first, then finished ones. A lit slot shows 3 LEDs (accent colour, blinking with a per-shell phase; steady green for exit 0 / completed, red for failed / killed / non-zero exit) and the first 3 letters of the command's program (`shellLabel`, exported; `cd …&&`, `VAR=x`, `sudo` are skipped). In multi-project view the slot's left edge has the project colour. With more shells than slots the last slot shows "+n" and selects the first hidden shell. Hit boxes `shell:<id>` are recorded before the bots (bots stay on top); the selection marker's arrow sits above the rack. No shells → the frame is pixel-identical to before.
- Panel: `shell:<id>` shows status with elapsed time, command (copy), exit code, description, the starting agent (clickable if still in the office; no `agentId` → the boss, clickable) and start/end times; "Komut ofisten ayrıldı" when it disappears. The boss summary lists running shells per project (clickable).
- `dev-mock.js`: shells `sh-1`…`sh-4` (two running, one completed, one failed); `?select=shell:sh-2` works; `?noShells` sends old data.

## Plan usage per account (v2.4)

Each account row shows its claude.ai plan usage: the 5-hour and weekly windows with the time each one resets.

```ts
type UsageWindow = { pct: number; resetsAt?: number }   // pct 0-100; resetsAt in ms
type AccountUsage = { updatedAt: number; fiveHour?: UsageWindow; sevenDay?: UsageWindow }
// Account gains `usage?: AccountUsage` (absent until a session of that account has reported it)
```

- Source: the status line input's `rate_limits` (code.claude.com/docs/en/statusline). Claude Code sends it only for Pro/Max subscriptions and only after the session's first API response, so an account's usage is the last value reported by any of its project sessions.
- Main starts each project's claude with `--settings '{"statusLine":…}'` running `userData/usage/statusline.sh <userData/usage/<accountId>/<projectId>.json>` (written at start, `src/usage.js` `SCRIPT`). The script stores its stdin there and, when the user has a command status line of their own (first `statusLine` found in the project's `.claude/settings.local.json`, `.claude/settings.json`, then the account's `settings.json`), runs it with the same input via `AGENT_OFFICE_STATUSLINE`, so the terminal shows the user's status line as before. Its `padding` is carried over.
- Windows: Claude Code runs status line commands through Git Bash, or PowerShell without it, so the command is the bare word `agent-office-statusline.cmd` (the same in both). Main writes it and `statusline.js` (`WIN_SCRIPT`) to `userData/usage/`, appends that folder to claude's `PATH`, and passes the tab's file in `AGENT_OFFICE_USAGE_OUT`; the `.cmd` runs the app's own executable as Node (`ELECTRON_RUN_AS_NODE` set only inside the `.cmd`). The user's own status line runs in the shell Claude Code would use (`AGENT_OFFICE_STATUSLINE_SHELL`: Git Bash's path, empty for PowerShell).
- Main scans those files every 3 s; the newest one with `rate_limits` becomes the account's usage, is kept in `usage/<accountId>/last.json` (loaded at start) and sent with `accounts:changed`. A project's file is removed from other accounts' folders when its pty starts, and when the project is removed; an account's folder goes with the account.
- UI: under a logged-in account, one line per window: label (`5 sa`, `Hafta`), a bar (accent; yellow from 70%, red from 90%), the percentage and the reset time (`14:30` within 24 h, else `Pzt 09:00`; `sıfırlandı` once passed, shown as 0%). The tooltip says how old the value is; values older than 30 minutes are dimmed. Redrawn every minute.

## Language (v2.5; one file per language)

The app speaks English and Turkish; each language is one file, `app/locales/<code>.json`.

```ts
type Language = { code: string; name: string }                        // name: the file's "_name", in its own language
type LanguageInfo = { setting: 'auto' | string; lang: string; languages: Language[] }
// setting: 'auto' or a code with a file; 'auto' → the system language (exact code, then its base language: tr-TR → tr), else 'en'
agentOffice.language.get(): Promise<LanguageInfo>
agentOffice.language.set(setting: 'auto' | string): Promise<LanguageInfo>   // unknown codes are ignored
agentOffice.language.onChange(cb: (info: LanguageInfo) => void): () => void   // 'language:changed'
```

- Locale files: one JSON object per language with namespaces `app`, `sidebar`, `panel`, `login`, `terminal` (renderer), `main` (menus, dialogs, notifications) and `auth` (known login errors). Values are strings with named placeholders (`"{n} working"`), nested objects (`sidebar.days.0`…`6`, `sidebar.authDot.<state>`, `panel.types.<agent type>`) or a plural group (`{ "one": "1 tool call", "other": "{n} tool calls" }`: CLDR categories, `other` required, chosen by `vars.n` with `Intl.PluralRules` for the language). Keys starting with `_` are metadata (`_name`). Every file has the same keys and the same placeholders per key as `en.json` (a plural group counts as one key); a key a file lacks falls back to English, an unknown key shows as the key itself. `app/test/locales.test.mjs` checks this, and that every key used in code exists and every key is used.
- Formatter (`app/src/i18n.mjs`, pure ES module, shared): `translator(dict, fallbackDict, lang)` → `t(key, vars?)` with `t.has(key)`; also `format`, `lookup`, `placeholders`, `isPluralGroup`. Conditionals are composed in code from two keys (e.g. `panel.todaySummary` + `panel.todayFailed`, `main.notifyPermission` / `main.notifyPermissionTool`).
- Main: `src/locales.js` reads `locales/*.json` at start (`loadLocales`, `languagesOf`, `resolveLang`); the picker's list and the valid settings come from the files present. Main keeps the setting as `language` in `state.json`, loads the formatter with `import()` before the window opens, and uses `T('main.key', vars)` for the menu, dialogs and notifications. It sends the default account's label (`main.defaultAccount`) and known auth errors (`errorKey` from `src/accounts.js`, localized by `localizeAuth(auth, T)` from `auth.<errorKey>`) in the current language; it re-sends `accounts:changed` on a change.
- Renderer: `renderer/i18n.js` loads `../locales/<code>.json` with `fetch` (English at start, another language when it is chosen) and exports `t(key, vars)`, `hasText(key)`, `getLang`, `setLang` (async: resolves once the file is loaded), `onLang`, `locale` (the code, for `Intl` dates). Modules read `t('ns.key')` at render time and re-render on `onLang`; the window is not reloaded, terminals keep running. The dev mock lists `?langs=en,tr` (the browser cannot list a folder).
- Office: `core.mjs` `setLanguage('en' | 'tr')` switches the drawn words (boss, waiting/working, today/done, agent types), the uppercase rule (Turkish i→İ only in Turkish) and the default titles (`AGENT OFFICE` / `AGENT OFİS`; a theme's own `title` wins). Default is Turkish. Its words stay in `STRINGS` in `core.mjs`; the app passes `'tr'` for Turkish and `'en'` for every other language.
- Sidebar: a Language picker (Auto, then each locale file's `_name`, sorted by code) next to the bot colour.
- Packaging: `locales/*.json` is in `build.files`.

## Waiting on you (v2.6)

When Claude needs the person, the app says so: a desktop notification, the Dock badge (on Linux `app.setBadgeCount`, where the desktop supports it; on Windows a dot overlay on the taskbar button, which also flashes), a mark on the project's row and the boss's sign.

The plugin adds to the session state file:

```ts
type Waiting = { kind: 'permission'; tool: string; since: number }
// session file stats: { ..., waiting?: Waiting }  — set by classic.PermissionRequest (main session or a subagent),
// removed when a call of that tool returns (allowed or denied), on a typed prompt and when the main turn completes
```

`readOffice` passes it on: each project gets `waiting: { tool, since } | null` (its oldest open dialog) and the data `isBossAsking: boolean`.

- Main (`src/attention.js`, pure): a project needs the person when it has an open dialog (`'permission'`), or when it went from busy to idle while the person was not looking at it (`'done'`; looking = window focused and project active; it clears once looked at or busy again). Busy = its boss is busy **or any of its agents still runs** (`working > 0`): a main turn that ends while background agents run is the boss waiting for its agents, not for the person, so `'done'` comes only once the boss is idle and no agent runs (usually Claude resumes a turn by itself when the last agent finishes, and `'done'` follows that turn). A new dialog or a finished turn in a project not being looked at raises one notification (clicking it focuses the window and activates the project). The first read after start raises none. The Dock badge counts the projects that need the person. `projects:changed` `status[]` items gain `attention: 'permission' | 'done' | null`; the sidebar shows ✋ (blinking) or ● on the row.
- Usage alerts: when an account's 5-hour or weekly window reaches 80% and again 95%, one notification each, per window and reset time; values already past a threshold at start are not announced.
- Office (`core.mjs` and the plugin viewer): with `isBossAsking` the boss's sign reads `NEEDS YOU` / `ONAY BEKLİYOR`, blinking; in a multi-project office it lists the projects asking. Otherwise it reads `WORKING` / `ÇALIŞIYOR` while `isBossBusy`, `WAITING ON AGENTS` / `AJANLARI BEKLİYOR` when the boss is idle but workers with `doneAt == null` remain (multi-project: lists the projects with working agents), else `WAITING` / `BEKLİYOR`. The agent panel's boss status and the title bar stats show the same waiting-on-agents state.
- Agent panel: a `Terminal ›` button next to the project (option `onOpenProject(name)`) activates that project and focuses its terminal.
- Worker `result` is now kept up to 4000 characters (was 600).

## Continue the last session (v2.7)

```ts
agentOffice.prefs.get(): Promise<{ resume: boolean }>
agentOffice.prefs.set(p: { resume?: boolean }): Promise<{ resume: boolean }>
```

- Main keeps `resume` in `state.json` (default true). When the window loads, each project whose claude is not running starts with `--continue` if it has a session to continue: a `.jsonl` in `<account config dir or ~/.claude>/projects/<project dir with every non-alphanumeric character as '-'>` (`projects.js` `historyDir`). Restarts, account changes and new projects start fresh.
- If a `--continue` start exits non-zero within 8 s, main starts it again without `--continue` and sends no `pty:exit`.
- Sidebar: a "Continue last session" checkbox above the language picker.

## Shared renderer (v2.8)

- One drawing implementation: the source is `plugin/viewer/core.mjs` (pure ES module, no Node APIs). The plugin's terminal viewer (`plugin/viewer/office.mjs`) imports it and keeps only the Node parts (settings, `themes.json` → `setThemes`, session files, PNG, terminal, transcript feed).
- `app/src/office/core.mjs` is a byte-identical copy, so the renderer can load it from inside the asar (`../plugin` is outside it). Edit the plugin file, then run `node app/scripts/sync-core.mjs`; `npm start`, `npm run dist` and `npm run dist:release` run it first (`prestart`, `predist`, `predist:release`). `app/test/office.test.mjs` fails when the two differ.
- Additions for the viewer: `setPartyMinutes(minutes)` (how long a bot dances; default 10, the viewer uses `forgetMinutes - 0.5`) and `themeColors()` (the current palette as `0xrrggbb` numbers). The auto theme's wall sign is the full project folder name (`my-app` → `MY-APP`).
- Session file format: the plugin stamps each session file with `format: 2` (`FORMAT` in `register.tsx`); fields are only ever added within a format. `readOffice` skips a file whose `format` is above its own (`sessions.js` `FORMAT`) and sets `newerFormat` on the data; the title bar then shows "⚠ update" / "⚠ güncelle" instead of reading it wrong. Files without `format` are read as format 2. The terminal viewer also passes live sessions' `shells` to the core now, so its server room shows them.

## End-of-day summary (v2.9)

Clicking the whiteboard opens the day's deliveries in the agent panel.

- Plugin: each delivery is also appended to the session file's `stats.today.log` (types: `Delivery = { id, type, description (≤ 200 chars), spawnAt, doneAt, isOk, toolCount }`, at most 300 per session and day). Unlike `workers`, the log outlives FORGET_MS, so the day's list stays complete.
- `sessions.js` `readToday(projects, now, root)` → `{ date, deliveries: (Delivery & { project, sessionId })[], untracked }`: today's logs from the session files changed today, newest first, filtered to the app's projects; `untracked` counts deliveries of today with no log entry (older plugin). Files of a newer `format` are skipped.
- Bridge: `agentOffice.office.today(): Promise<…>` (`office:today`).
- Office: the whiteboard records the hit box `@today` (`core.mjs` `TODAY_ID`), the board's own size in single- and multi-project offices; bots stay on top of it.
- Panel: `mountAgentPanel(el, { …, loadToday })`; `@today` shows the totals (delivered, failed, agent time), per-project counts and time when there are several projects, then each delivery (time, ✓/✗, type, description, duration, tool count, project). It reloads at most every 3 s while open.

## Tabs and worktrees (v3.0)

A project can run several Claude terminals at once. Each extra one can work in the same folder or in a new git worktree.

```ts
type Tab = {
  n: number                                                // ≥ 2; the main terminal is tab 1, implicit and never stored
  dir?: string                                             // worktree tabs only: where claude runs
  worktree?: { root: string; repo: string; branch: string } // worktree tabs only
}
// Project gains `tabs?: Tab[]` (extra tabs only; absent when there are none, so old state.json files keep working)
// ProjectStatus gains `tabs?: { n: number; isRunning: boolean }[]`

agentOffice.tabs.add(projectId: string, mode?: 'same' | 'worktree'): Promise<Tab | null>
  // no mode: in a git repo main pops up a native menu (same folder / new git worktree), otherwise same folder
agentOffice.tabs.close(projectId: string, n: number): Promise<{ closed: boolean; restarted?: boolean }>
```

- **Pty ids.** The main terminal keeps the id `<projectId>`; tab `n` uses `<projectId>:<n>` (`projects.js` `tabPtyId` / `parsePtyId`). The existing channels (`pty:write`, `pty:resize`, `pty:restart`, `pty:data`, `pty:exit`) take either id, so size, restart, exit, paste and focus are per tab. `login:<accountId>` ids are never parsed as tabs. A new tab's number is one above the highest in the project (worktree tabs also skip numbers whose folder or branch already exists).
- **Starting.** Every tab starts with the project's account (`CLAUDE_CONFIG_DIR`), `--plugin-dir` and the usage `--settings` (status line file `usage/<accountId>/<projectId>-<n>.json`; the user's own status line is looked up from the tab's folder). At app start, `--continue` follows the v2.7 rule for the main terminal and for worktree tabs (history of the tab's own folder). Same-folder extra tabs always start fresh, so two claudes never continue the same session. Changing the project's account restarts all its tabs; removing the project kills them and leaves every folder (worktrees included) alone.
- **Worktrees.** Offered only when the project folder is inside a git repository (`git rev-parse --show-toplevel`). Main runs `git -C <repo> worktree add -b agent-office/<n> <repo>-wt-<n>` from `HEAD`: the folder sits next to the repository root (`/x/shop` → `/x/shop-wt-3`, branch `agent-office/3`). If the project is a subfolder of the repository, the tab runs in the same subfolder of the worktree.
- **Closing.** The main terminal has no ×. Closing a same-folder tab asks first. Closing a worktree tab gives three choices: close and remove the worktree, close and keep the folder, or cancel. Removing runs `git worktree remove <root>` (never `--force`) after the tab's claude is stopped. If git refuses (changes or untracked files), the user sees git's message, the tab stays and its claude starts again with `--continue` (`restarted: true`). The branch is always kept.
- **Office and attention.** The plugin names a session after its folder's basename. Same-folder tabs therefore already carry the project's name. A worktree tab's folder (`shop-wt-3`) has its own name. Main maps it back with `projects.js` `sessionAliases(projects)` → `{ "shop-wt-3": "shop" }`, and passes that map to `readOffice(projects, now, root, aliases)` and `readToday(…, aliases)`. A mapped session counts as its project: its workers, shells and deliveries carry the project's name, and its busy state and permission dialogs are the project's. `attention.js` `nextAttention(…, aliases)` merges the same way (busy if any session is busy; the project's dialog is the oldest one). A folder name that equals another project's name is never mapped (that name belongs to that project). Attention stays per project, not per tab.
- **UI.** A project with one terminal looks exactly as before. Its only addition is a "+" at the terminal's top right that shows on hover. With extra tabs, a strip above the terminal shows `1 <folder>` for the main terminal, `n <folder>` for same-folder tabs and `n ⎇ <branch>` for worktree tabs (tooltip: kind and folder), each extra tab with a ×, then "+". The visible tab per project is kept only in the window. Shortcuts: ⌘T new tab (asks in a git repository), ⇧⌘T new worktree tab, ⇧⌘[ and ⇧⌘] previous and next tab; on Linux Ctrl+Shift+T new tab (worktree from the menu it opens) and Ctrl+Shift+PageUp/PageDown previous and next.
- `dev-mock.js`: `?tabs` gives the first project a same-folder tab and a worktree tab and shows the worktree tab.

## Theme picker (v3.1)

The repository's theme gallery (`themes/*.json`) ships with the app, and the sidebar picks one theme for the whole office.

```ts
agentOffice.prefs.get(): Promise<{ resume: boolean; theme: 'auto' | string }>
agentOffice.prefs.set(p: { resume?: boolean; theme?: 'auto' | string }): Promise<{ resume: boolean; theme: string }>
agentOffice.office.themes(): Promise<Record<string, ThemeSpec>>   // now: gallery themes, then the user's themes.json over them
```

- **Packaging.** `package.json` `build.extraResources` copies `../themes/*.json` to `Resources/themes`; under `npm start` main reads `../themes`. The previews are not shipped. Main reads the gallery once (sorted by file name).
- **Merging** (`src/themes.mjs`, pure, shared by main and the renderer). `galleryThemes(files)` turns the parsed files into one map and drops each gallery theme's `match`, so a gallery theme never applies because a project name contains it; it applies only when picked. `mergeThemes(gallery, user)` lays the user's `~/.claude/agent-office/themes.json` over the gallery: on a name clash the user's fields win and colours merge key by key, and a `match` comes only from the user's file. A missing or broken `themes.json` gives the gallery alone (`themesError` is unchanged).
- **Setting.** Main keeps `theme` in `state.json` next to `language` and `resume`: `'auto'` (default) or a theme name (`normalizeThemeSetting`: a non-empty string of at most 100 characters, else `'auto'`). A name that no longer exists is kept but treated as Auto (`effectiveTheme(setting, themes)` → `''`), so the choice comes back with the theme.
- **Office.** `renderer/office-view.js` `setTheme(name | '')` calls `core.mjs` `setTheme`: a name forces that theme in every project, `''` is today's pick by project (a `match` from `themes.json`, else colours from the project name). The frame, accent and terminal colours follow through `onTheme` → `applyTheme` as before. The user's **Bot color** is applied after the theme's colours, so it still wins over a theme's `body`/`bodyHi`/`shade`.
- **Sidebar.** A **Theme** / **Tema** select between Language and Bot color: **Auto (per project)**, then the built-ins `classic` and `forest`, then the other themes in map order (`themeChoices(themes)`), each by its name. Each option's tooltip is the theme's `description` (the built-ins' come from the locale files: `sidebar.themeClassicTitle`, `sidebar.themeForestTitle`); the closed select shows the chosen one's. Choosing switches the office at once (no reload) and saves through `prefs.set({ theme })`.
- `dev-mock.js`: `?theme=<name>` sets the stored choice (e.g. `?theme=sakura`); the mock reads the gallery from `../../themes/*.json`, so it is there under Electron's `loadFile` or a static server at the repository root (`/app/renderer/index.html`).

## Manager mode (v3.2)

In the app the project's Claude session is the boss: a dispatcher that delegates the work to background agents by default and stays available to the person, keeps going until the task list is done, and stops only for what needs the person.

```ts
agentOffice.prefs.get(): Promise<{ resume: boolean; theme: 'auto' | string; manager: boolean }>
agentOffice.prefs.set(p: { resume?: boolean; theme?: 'auto' | string; manager?: boolean }): Promise<{ resume: boolean; theme: string; manager: boolean }>
```

- **Setting.** Main keeps `manager` in `state.json` next to `resume` (default true). The sidebar shows it as a checkbox under **Continue last session**: **Manager mode — delegate to agents** / **Müdür modu — işleri ajanlara dağıt**; its tooltip says it applies to sessions started afterwards. Toggling restarts nothing.
- **Env.** `startPty` builds the pty's env with `accounts.js` `sessionEnv(ptyEnv(…), { manager })`: `AGENT_OFFICE_APP=1` always, `AGENT_OFFICE_MANAGER=1` when the setting is on (off, the variable is removed, even if the app inherited it).
- **Plugin.** A `prompt.compose` hook appends one section, `agent-office:manager` (scope `session`, fixed text: `MANAGER_TEXT` in `plugin/hooks/register.tsx`), to the system prompt of every request when `AGENT_OFFICE_MANAGER=1` and the loop offers the Agent tool (not to a teammate, not to a loop without the Agent tool). Being part of the system prompt, it holds across `--continue`, `/resume`, `/clear` and compaction. Outside the app the plugin adds nothing unless the person sets `AGENT_OFFICE_MANAGER=1` themselves.
- **Nudge (plugin, no app change).** With `AGENT_OFFICE_MANAGER=1`, a `tool.call` hook counts the main loop's own tool calls (no `agentId`) per turn. `turn.start` and an `Agent` / `Task` / `SendMessage` call reset the count; bookkeeping tools (`TodoWrite`, `Task*` list/output/stop, `ToolSearch`, `AskUserQuestion`, plan mode, `ListAgents`) neither count nor reset. On the sixth (`NUDGE_AFTER`) the call's answer gets `context: [NUDGE_TEXT]`, a reminder after the tool result (like PostToolUse `additionalContext`); at most once per turn (a refused call passes it to the next one). Being a message, not system-prompt text, it leaves the prompt cache alone. Subagents and teammates are never nudged.

## Sleeping sessions (v3.3, memory)

Each `claude` holds its whole conversation in memory: about 60–80 MB idle and fresh, 250–350 MB after a long session. Seven projects used to keep seven claudes from launch to quit (≈ 1.1 GB measured). No outside GC can shrink them: that heap is the live conversation. Ending an idle claude and resuming its session later is the process-level equivalent.

```ts
agentOffice.prefs.get(): Promise<{ resume: boolean; theme: string; manager: boolean; sleepMinutes: 0 | 15 | 30 | 60 }>
agentOffice.prefs.set(p: { resume?: boolean; theme?: string; manager?: boolean; sleepMinutes?: 0 | 15 | 30 | 60 }): Promise<…>
agentOffice.pty.wake(id: string): void              // the renderer shows this tab: a sleeping claude starts
agentOffice.pty.onSleep(cb: (id: string) => void)   // main ended this tab's idle claude
type ProjectStatus = { …; isAsleep: boolean; tabs: { n: number; isRunning: boolean; isAsleep: boolean }[] }
```

- **Setting.** `state.json` `sleepMinutes`: `0` (off) or 15 / 30 / 60, default 30 (`src/sleep.js` `normalizeSleep`). Sidebar: **Sleep idle sessions** / **Boştaki oturumları uyut**, a select under Manager mode. Off = the v2 behaviour (every claude starts at load and keeps running); turning it off starts every sleeping tab.
- **Lazy start.** With sleeping on, `startMissing` marks every tab that is not running as asleep (`{ resume: true }`) instead of starting it; when it first starts, the **Continue last session** setting of that moment decides `--continue` (`wakeOptions`). The renderer calls `pty.wake(id)` whenever the visible tab is asleep, so a tab's claude starts the first time it is shown (with the v2.7 `--continue` rule). New projects and tabs, Enter on an exited terminal and account changes still start at once (a sleeping tab whose account changes stays asleep and starts fresh). Any `pty:write` to a sleeping tab wakes it too.
- **Sleeping.** Every 30 s main looks at each running tab that is not in the active project. It sleeps when nothing can be lost (`sleepBlocker`, pure): no input or output for `sleepMinutes` (leaving the active project restarts the clock); no typed but unsent prompt (`draftAfter` over `pty:write`: printable text is a draft, Enter or Ctrl+C clears it); Claude Code's own `<config dir>/sessions/<pid>.json` says `status: 'idle'` and gives the `sessionId` (the pty runs `exec claude`, so its pid is claude's); the office file `~/.claude/agent-office/sessions/<sessionId>.json` exists, has not ended, and shows no busy boss, no open prompt, no running agent and no running background shell; the transcript `<historyDir>/<sessionId>.jsonl` never used `CronCreate` or `ScheduleWakeup` (cached by size and mtime). A missing or odd file keeps the tab awake. Main then kills the pty quietly, keeps `{ sessionId }` and sends `pty:sleep`.
- **Waking.** `pty.wake` starts `claude --resume <sessionId>` (that tab's own session, same id) in the tab's folder with its account. If it fails within 8 s, it starts fresh as with `--continue`. On Windows the arguments go through `windowsClaude` like `--continue`; a `.cmd` claude runs under `cmd.exe`, so the pty's pid is not claude's, no pid file matches and such tabs never sleep (lazy start still applies).
- **Renderer.** `pty:sleep` resets the tab's xterm (dropping its scrollback, the largest part of a terminal's memory; the resumed claude draws the conversation again) and writes one dim line (`terminal.asleep`); the first output of the woken claude clears it. The sidebar dot of a sleeping project is hollow (`sidebar.claudeAsleep`); a sleeping tab's label is dim and italic (`app.asleep`).
- **Office view.** `office-view.js` draws nothing while `document.hidden` (minimized, covered, another space) and draws once when it shows again.

## Moving a session to another computer (v3.4)

One project's Claude session, its code and its memory travel as one `.agentoffice` file. The format and the work are UI-free so a later sync can reuse them: `src/transfer.js` (pure: archive, manifest, path rewriting, plans) and `src/transfer-io.js` (Node only: files and git). `main.js` only asks the questions.

```ts
agentOffice.projects.menu(id: string): Promise<void>   // right click on a project row: a native menu
                                                     // (Move Session to Another Computer… / Open Session File…)
```

- **Entry points.** Sidebar: `contextmenu` on a project row → `projects.menu`. App menu: **File → Open Session File…** / **Move Session to Another Computer…** (the active project); TR **Dosya → Oturum Dosyası Aç…** / **Oturumu Başka Bilgisayara Taşı…**. Opening a file: macOS `open-file` (also at launch), Windows/Linux the `.agentoffice` path in `argv`; the packaged app now takes `requestSingleInstanceLock()`, and a second launch hands its file (or folder) to the running one via `second-instance` (not under `npm start`, so a dev copy can run beside the installed app). Files opened before the window has loaded wait and open after `did-finish-load`; with a file to open, an empty project list does not ask for a folder first. `package.json` `build.fileAssociations` registers `.agentoffice` (macOS document type, Windows NSIS, Linux `.deb` MIME `application/x-agentoffice-session`).
- **Export rules.** The project's main tab. Its session: the running claude's `sessionId` from `<config>/sessions/<pid>.json`, else a slept tab's id, else the folder's newest transcript. A running claude must pass `exportBlocker` (= `sleep.js` `sleepBlocker` without the time and active-project rules): idle per Claude Code, office file present and not ended, no busy boss, no open prompt, no running agent or shell, no unsent prompt text. A blocked export says why (`main.moveBlocker.<reason>`).
- **Archive.** gzip'd tar (ustar, pax `path` for long or non-ASCII names; written and read with `zlib` only):

  | Entry | From |
  | --- | --- |
  | `manifest.json` | `{ format: 'agent-office-session', version: 1, createdAt, app: { version }, claude: { version }, source: { platform, hostname, projectDir, realDir, projectName, gitTop, historyDir, memoryDir }, account: { label }, session: { id }, git: null \| { remote, remotes: [{ name, url }], branch, head, upstream, subdir, unpushed, handoff, bundleRef, changed }, contents }` |
  | `transcript/<id>.jsonl`, `transcript/<id>/…` | `<config>/projects/<slug>/<id>.jsonl` and the `<id>/` folder next to it (`subagents/agent-*.jsonl` + `.meta.json`, `tool-results/*`) |
  | `memory/*.md` | `~/.claude/projects/<memory slug>/memory/` (the folder every account uses, v2 memory rule); left out for hashed (> 200 character) slugs |
  | `office/<id>.json` | `~/.claude/agent-office/sessions/<id>.json` |
  | `git/handoff.bundle` | `git bundle create … refs/agent-office/handoff-<id> --not --remotes`: the handoff commit and every commit not on a remote |
  | `git/changes.patch` | `git diff --binary <head> <handoff>` (readable copy; import uses the bundle) |

  The handoff commit is built without touching the user's index, branches or stash: the index file is copied, `git add -A` runs on the copy (`.gitignore` applies; untracked files matching `isSecretFile` — `.env*` except examples, private keys, `.netrc`, `.npmrc`, `.claude/settings*.json`, Claude login files — are taken out again and listed to the user), `write-tree`, `commit-tree --no-gpg-sign -p HEAD` with a fixed Agent Office identity. The temporary ref exists only while `git bundle` runs. Remote URLs lose passwords and token user names (`redactRemote`). Never packed: `.credentials.json`, `.claude.json`, keychain files, settings.
- **Reading a file** (`readArchive`). Up to 2 GiB unpacked. Only regular-file and pax entries (links and other types are refused); every name relative, `/`-separated, without `.`/`..`/empty parts, backslashes, control characters or drive letters; only the names in the table (memory one level deep, transcript sidecars at most five levels); no duplicates; no Claude login file names. The manifest must have the known `format`, a `version` not above this app's (`newerFormat` otherwise), a plain session id, 40/64-hex commits and a branch name safe as a git argument. Nothing is extracted as-is: import writes each part to a path it computes, and checks that sidecar paths stay inside the session folder.
- **Import steps.** (1) What is inside: project, machine and system, date, branch and commit, how many changed files and unpushed commits. (2) The folder: a sidebar project with a matching git remote (`normalizeRemote`: ssh, scp-like and https forms compare equal), else the same name, is offered; otherwise a folder dialog. An empty non-repository folder can be cloned into from the file's remote URL. (3) Code (`inspectTarget`, `planCheckout`): a different remote asks; uncommitted changes to tracked files refuse (`dirty`, nothing touched); `prepareGit` fetches the bundle into `FETCH_HEAD` (if its prerequisites are missing, `git fetch` of each remote first, fetch only). If `HEAD` is the recorded commit the plan is `apply`; else `branch`: a new branch at the recorded commit (the source branch name if free, else `agent-office/handoff-<id8>`), asked first. `applyGit` then runs `git read-tree -m -u HEAD <handoff>` (refuses to overwrite changed or untracked files) and `git reset -q`, so the work is there as uncommitted changes and untracked files. Nothing is ever pushed and no existing branch moves. (4) Account: the existing project's, else Default. Its main tab must not be busy (same rules). An id that already has a transcript anywhere under `<config>/projects/*/` (claude `--resume <id>` searches them all) is never overwritten: the user may import it under a new random id (every `sessionId`/`session_id` field and the session folder's path follow) or cancel. Claude Code here older than the manifest's: a warning in the last dialog. (5) `placeSession`: the transcript goes to `<config>/projects/<slug of the real path of the folder>/` (Claude Code keys sessions by the real path of the cwd: `/tmp/x` → `-private-tmp-x` on macOS), written with `wx`; folders over 200 characters are refused (`longPath`). Memory is merged with `memory.js` `mergeMemory` (existing files win), the office file gets the new folder's name as `project` and is written only if absent. The project is added to the sidebar if missing, made active, and its main tab starts `claude --resume <id>` (`startPty(id, { sessionId, imported: true })`).
- **Path rewriting** (`makeRewriter`, `moveMaps`, `rewriteJsonl`). Prefix maps, longest first: old session folder `<historyDir>/<old id>` → new one, old `historyDir` → new, old memory folder → new, old project folder (as given and real path) → new real path, old git root → new one. A prefix matches only as a whole folder (`/a/proj` not inside `/a/project` or `/x/a/proj`); a Windows source matches case-insensitively with `\`, `\\` (escaped JSON text) or `/` between parts. In values of `cwd`, `file_path`, `filePath`, `path`, `notebook_path`, `workingDirectory`, `directory`, `dir` the whole rest of the path is converted to the new system's separator; in free text, the path parts up to the next space or quote. Lines that do not change stay byte for byte; lines that are not JSON stay as they are. Sidecar `.jsonl`/`.json` files get the same treatment, `.txt`/`.md`/`.log` the free-text one, others are copied.
- **A failed resume.** For an imported session, `--resume` exiting with an error within 8 s does not fall back to a fresh session (the sleep wake-up still does): a dialog names the kept transcript and the id, and the terminal shows the usual exit line (Enter starts a new session).

## Work across projects (v3.5)

One project's session (A) may work in another project's folder (B): the boss took a job for B, or its agents did. The office and the sidebar show that work under B; A stays its owner.

```ts
// session file (plugin, format 2: fields only added; older apps ignore them)
Worker.dir?: string          // the folder the agent last worked in, absolute; left out = the session's own folder
OfficeStats.bossDir?: string // the folder the main loop works in this turn, same rules; reset at turn.start, dropped at its end
// readOffice(projects, now, root, aliases, places?: { dir: string; name: string }[])  (projects.js projectPlaces)
OfficeData.workers[i].from?: string                                         // A, when the worker is shown under B
OfficeData.projects[i].remote?: { working: number; isBossBusy: boolean; from: string[] }   // on B only
```

- **Plugin** (`register.tsx` `placeOf`). A tool call's folder: Read/Edit/Write/NotebookEdit the file's folder, Glob/Grep their `path` (the loop's folder without one), Bash and Monitor a leading `cd <dir>`, `pushd <dir>` or `git -C <dir>`; relative paths count from the loop's folder (a subagent's spawn `cwd`, else the session's cwd, which `classic.CwdChanged` moves; `~` is the home folder); paths over 1024 characters and calls that name no folder change nothing. A subagent's spawn `cwd` is its first `dir`. Main-loop calls set `stats.bossDir` (only when it changes; equal to the session root it is not written). Writes go through the usual 500 ms throttle.
- **Mapping** (`sessions.js` `placeFinder`, `normPath`). Only absolute paths; `\` and `/` compare alike, `.`/`..` are resolved, Windows drive and UNC paths compare case-insensitively. A path belongs to the project whose folder (or worktree tab folder) holds it, the deepest when folders nest; a path outside every project, or in the session's own project, changes nothing.
- **readOffice.** A worker whose `dir` lies in B is listed with `project: B, from: A` (done ones too, so it does not change desks when it delivers). A running one counts in A's `working` (A's busy state, the title bar's total and the attention rules are unchanged) and in B's `remote.working`; a busy boss whose `bossDir` lies in B sets `remote.isBossBusy`. `remote.from` lists A once. Deliveries, shells and permission prompts stay with A. B's `remote` never makes B busy for `attention.js`, so B gets no "done" notification and approvals keep coming from A, whose terminal answers them.
- **Sidebar** (`src/project-status.mjs`). B's line counts `working + remote.working` and adds `sidebar.workedFrom` (**worked on from A** / **A projesinden çalışılıyor**); its ★ shows while the boss works there.
- **Office** (`core.mjs`). Such agents sit at desks with B's plate and colour; the boss's sign and the board's busy dot name B too while the boss works there. The panel shows **from A** next to the project and its **Terminal ›** opens A.
- **Manager mode.** The manager section asks the boss to work in the other project's folder with absolute paths (and have its agents do so) when a job is for another project, so it shows up there.

## Default's plugins, skills and MCP servers in every account (v3.6)

What the user installed for plain Claude Code (`~/.claude`) is available in every account, so a project has the same tools whichever account it runs on. `src/shared-config.js` (pure functions plus the file work; no Electron).

```ts
agentOffice.accounts.setShare(id: string, on: boolean): Promise<void>
type Account = { …; shareDefault?: false }   // absent = on; stored in state.json only when off; never on 'default'
```

- **Setting.** A checkbox under every non-default account in the sidebar: **Use Default's plugins, skills and MCP servers** / **Varsayılan hesabın eklentilerini, skill'lerini ve MCP sunucularını kullan**, default on; its tooltip says what is shared (MCP tokens included) and that it applies when the account's sessions start next. Toggling restarts nothing (`accounts.js` `setAccountShare`).
- **When.** `startPty` calls `prepareShared` at every start of a tab whose account has a `configDir` (Default: nothing, it already is `~/.claude`). Each item uses the mechanism Claude Code 2.1.296 loads without touching `~/.claude`:

  | Item | Mechanism |
  | --- | --- |
  | User MCP servers (`~/.claude.json` top-level `mcpServers`) | `--mcp-config <userData/mcp/<tab>.json>` (0600; a file, so tokens never appear in argv). No `--strict-mcp-config`: the account's own servers still load. A dynamic server replaces a user/local one of the same name, so names in the account's `.claude.json` (top level and `projects[cwd]`) and in `<cwd>/.mcp.json` are left out (`sharedMcpServers`). |
  | Plugins (`plugins/installed_plugins.json`, scope `user`, enabled in `settings.json` `enabledPlugins`) | `--plugin-dir <installPath>` each, after the app's own plugin: Default's installed copy, no second install, nothing in the account's plugin registry. A `strict: false` marketplace plugin has no `.claude-plugin/plugin.json`; it gets `userData/shared-plugins/<name@marketplace>/` (plugin.json = its marketplace entry without `source`/`category`/`strict`/`tags`, plus links to the installed copy's files), and that folder is passed instead. Skipped: `agent-office` (passed already), plugins under `plugins/synced/`, and plugins the account enabled itself (by name: `--plugin-dir` would override the account's install). Stage folders of plugins Default no longer has are removed. `enabledPlugins` + `extraKnownMarketplaces` in `--settings` were tried: Claude Code does not install them by itself. |
  | Personal skills, agents, commands, output styles (`~/.claude/{skills,agents,commands,output-styles}/<entry>`), `~/.claude/CLAUDE.md` | Links in the account folder: `<config>/<dir>/<entry>` → the entry in `~/.claude` (Windows: directory junctions; a file falls back to a hard link, then a copy). Never `skills/synced` (claude.ai's per-account skills) or dot entries. An existing entry is never replaced; the app's links are listed in `<config>/.agent-office-shared.json`, and only those are updated or removed (source gone, or the setting off). Removal unlinks; it never follows a link. |

- **Never shared.** Logins (`.credentials.json`, keychain, `oauthAccount`/`primaryApiKey` in `.claude.json`), `settings.json` (hooks, permissions, env, status line), claude.ai-synced skills and plugins, history, `projects/` transcripts, policy and remote settings. Project memory follows its own rule (v2: always `~/.claude`).
- **Off.** The account's links made by the app, the marker and the tab's MCP file are removed at the next start; no `--plugin-dir`/`--mcp-config` is added.
- **MCP file lifetime.** `userData/mcp/<tab>.json` holds tokens, so it exists only while its tab's claude runs: removed when the pty exits or is killed (restart, sleep, tab or project removal, quit), when the tab starts under Default or with the setting off, and at app start every file is removed (`pruneMcpFiles(dir, runningTabKeys)`; none runs yet).

## Resume interrupted work (v3.7)

If the app goes away while a tab's claude is mid-turn (in-app update via `quitAndInstall`, a crash, the user quitting, a reboot), `--continue` alone brings the conversation back but leaves it sitting there. `src/resume.js` (pure functions; no Electron).

```ts
agentOffice.prefs.get(): Promise<{ …; resumeWork: boolean }>   // default true
agentOffice.prefs.set(p: { resumeWork?: boolean }): Promise<…>
// state.json
interrupted?: { [ptyId: string]: string }                     // session id, or '' when not known yet
```

- **Mark.** Every 1.5 s main looks at each running tab: busy is Claude Code's pid file `status` (`<config>/sessions/<pid>.json`, anything but `idle`); without a status, the office file's `stats.isBossBusy` (not when `endedAt`). A pid file status wins because an office file left by a killed claude can still say busy. Busy sets `interrupted[ptyId] = sessionId`, not busy clears it; state.json is written at once on each change (no broadcast), so a kill -9 or a power cut still finds it.
- **Cleared** when the turn ends, when the tab's claude exits while the app runs, and when the tab is killed on purpose (restart, removal, sleep, account change). **Kept** on quit: `killAll` (window closed, `before-quit`, `update:install` before `quitAndInstall`) takes one last look, then kills the ptys without clearing.
- **Launch.** On the first `did-finish-load` only (a renderer reload does nothing), with `resume` and `resumeWork` both on, each marked tab that still exists starts at once, even with sleeping on (lazy start): `startPty(id, { sessionId, resume: true, prompt: RESUME_PROMPT })` → `claude … --resume <id> "<prompt>"` (or `--continue "<prompt>"` without a session id). The positional prompt opens the interactive session and submits it. Then every mark is dropped (settings off, or a tab that cannot resume); the resumed turn marks itself again while it runs. If `--resume` fails within 8 s the tab starts fresh without the prompt (v2.7 rule).
- **Prompt** (English, it goes to the model): *Agent Office restarted (app update or restart) while you were working, which interrupted your last turn and any sub-agents you had running. Check what was finished (git status, files, your task list), then continue the unfinished work from where it stopped. Restart sub-agents that were cut off.*
- **Argv.** The prompt is added only when the start resumes, as the last argument after the resume arguments (`claudeArgs`), so a variadic option (`--mcp-config <configs...>`) cannot take it. `promptArg` makes it one line without `"`, `%`, `!`, `^` and never starting with `-`. macOS/Linux: it reaches claude through `$SHELL -l -i -c '… exec claude "$@"' claude …args` untouched; Windows: `claude.exe` gets it as one argv entry from ConPTY, `claude.cmd` gets it quoted in the `cmd.exe /d /s /c "…"` line (`platform.js` `cmdQuote`).
- **Sidebar.** "Resume interrupted work on launch" / "Açılışta yarım işlere devam et" under "Continue last session", indented; disabled and greyed while that one is off. (Renamed in v3.8 so it differs from the button.)

## Resume unfinished work by hand (v3.8)

The marks of v3.7 miss some cases: a restart from a version without them, a claude that died within the 1.5 s poll, a tab killed on purpose, the automatic resume being off. A button checks every tab's last conversation instead. `src/resume.js` (pure functions).

```ts
agentOffice.work.resumeUnfinished(): Promise<{ resumed: { id: string; name: string }[]; skipped: { id: string; name: string }[] }>
agentOffice.work.onResumed(cb: (r: same) => void): () => void   // 'work:resumed': the result after the app menu's item
```

- **Which conversation.** The one the tab would resume: a running tab's session (Claude Code's pid file); a sleeping tab's session (`asleep` `{ sessionId }`); otherwise, for tabs that `--continue` (main tab, worktree tab) and are lazily not started or stopped, the folder's newest transcript (`transfer-io.js` `newestSession`, what `--continue` opens). A marked tab's own session id wins. Transcripts are under the account's config dir (`CLAUDE_CONFIG_DIR`, else `~/.claude`) `projects/<slug>/<id>.jsonl` (`findTranscript`). A sleeping tab that must start fresh (`asleep {}`, account change) and a same-folder extra tab without a session have none.
- **Unfinished** (`transcriptState`, `entryTurn`). The last line that counts decides. Counts: `type: "assistant"` (open when `message.stop_reason` is `tool_use` or missing/null; `end_turn`, `stop_sequence`, … close it) and `type: "user"` (a prompt, an image, a `tool_result`, a `<task-notification>` are open; text starting `[Request interrupted by user` closes it: the user stopped it on purpose). Not counted: `isSidechain` (sub-agents), `isMeta`, `isCompactSummary` / `isVisibleInTranscriptOnly`, user text starting with `<command-name>`, `<command-message>`, `<command-args>`, `<local-command-…>`, `<bash-…>` (slash and `!` commands), and every other `type` (`system` incl. `turn_duration` and `local_command`, `summary`, `attachment`, `last-prompt`, `cost-state`, `file-history-snapshot`, `queue-operation`, …). Unparseable lines are skipped. Only the file's tail is read (`transcriptFileState`): 64 KB, then 1 MB, then 16 MB while no line counts. A tab is unfinished when it is marked (`interrupted`) or its conversation is unfinished with a valid session id.
- **What happens** (`unfinishedActions`, in project/tab order). Busy tabs (`isTurnBusy`) are skipped. A running idle tab with unsent text (`activity.draft`) is skipped and listed under `skipped`. A running idle tab gets the prompt typed: `ESC[200~<prompt>ESC[201~` (bracketed paste, `typedPrompt`: one line, `promptArg` rules), then `\r` 300 ms later, while the same pty still runs. A tab that is not running (lazy, sleeping, stopped) starts like the launch path: `startPty(id, { sessionId, resume: true, prompt: UNFINISHED_PROMPT })` → `claude … --resume <id> "<prompt>"` (`--continue "<prompt>"` for a marked tab without a session id, only main/worktree tabs). The acted-on tabs' marks are cleared.
- **Prompt** (`UNFINISHED_PROMPT`, English): *Your last turn in this session did not finish: it was cut off (an Agent Office restart or update, the session ending, or a crash) before you were done, along with any sub-agents you had running. Check what was finished (git status, files, your task list), then continue the unfinished work from where it stopped. Restart sub-agents that were cut off.*
- **UI.** Sidebar: **↻ Resume unfinished work** / **↻ Yarım kalan işlere devam et** under **+ Add project** (same dashed button style; disabled while it runs). Under it, for 12 s, a note: `sidebar.resumeUnfinishedDone` ("Resumed unfinished work in N projects: A, B" / "N projede yarım iş devam ettirildi: A, B"; a name is the project, plus ` · <branch>` or ` · #<n>` for an extra tab) or `sidebar.resumeUnfinishedNone` ("No unfinished work" / "Yarım kalan iş yok"), plus `sidebar.resumeUnfinishedSkipped` when some were skipped. App menu: **File → Resume Unfinished Work** (`main.resumeUnfinished`), whose result comes as `work:resumed`.

## No stopping on a to-do list; manager mode per project (v3.10)

The boss must not end a turn on "next steps / remaining / Kalanlar / istersen … yapayım" and go idle: it does that work too (through agents in manager mode) and stops only when the work is done or it needs the person (an approval for an outward-facing or destructive step, credentials, a decision that is theirs).

```ts
// state.json, per project (absent = the global `manager` setting)
Project.manager?: boolean                          // true: delegates (manager mode), false: does it itself
agentOffice.projects.setManager(id: string, value: boolean | null): Promise<{ restarted: string[] }>   // null: back to the global setting
```

- **Env** (`accounts.js` `sessionEnv`, `projects.js` `managerOf`). Effective mode = `project.manager` if boolean, else `state.manager !== false`. Manager on: `AGENT_OFFICE_MANAGER=1`, `AGENT_OFFICE_FINISH` removed. Off: `AGENT_OFFICE_MANAGER` removed, `AGENT_OFFICE_FINISH=1`. So every app session has the finish guard; only manager mode gets the manager section, the nudge and the delegation wording.
- **Sidebar.** In each project row, after **Account**: **Boss** [**Global** | **Delegates** | **Does it itself**] / **Müdür** [**Genel ayar** | **Dağıtır** | **Kendisi yapar**], the account select's look (`.sb-acct .sb-mode`). `projects:setManager` writes the field (removed for Global) and, when the effective mode changed, restarts each of the project's running tabs that is idle (`isTurnBusy` false, no unsent text, a session id in the pid file, no worker without `doneAt` and no shell without `endAt` in its office file) with `startPty(id, { sessionId, resume: true })` → `claude --resume <id>`; it returns those pty ids and the renderer resets their terminals. Busy, drafting, sleeping and stopped tabs pick the new mode up at their next start.
- **Decision rule** (`MANAGER_TEXT`): make technical choices (libraries, structure, how to fix something) yourself and give the reason in one line; never end a turn with an offer ("want me to…?", "istersen…"): do it.
- **Finish guard** (plugin, `plugin/hooks/finish.ts`, run from register.tsx's `classic.Stop` hook). On with `AGENT_OFFICE_MANAGER=1` or `AGENT_OFFICE_FINISH=1`. When the main loop is about to stop (Stop; a subagent's stop is SubagentStop and never guarded), `last_assistant_message` is read:
  - *Cues* (heuristic, Turkish + English, code blocks and inline code ignored, "nothing left / kalan iş yok" phrases removed first). Work: a heading or line led by Next steps, Remaining, TODO, Follow-ups, What's left, Kalanlar, Kalan işler, Sonraki adımlar, Yapılacaklar, Eksikler, …; offers and announcements: want me to, would you like me to, shall I, I could also, if you'd like I can, let me know if you want, not implemented yet, yapılacak, yapılabilir, istersen/isterseniz/ister misin, henüz yapılmadı, …-ayım/-eyim mi. Ask: a sentence with a topic only the person can settle (approve, deploy, production, publish, release, delete, password, token, credentials, log in, which one / prefer / your decision; onay, izin, canlı, yayın, sil…, şifre, token, giriş yap, karar, tercih, hangisi, seçenek, ödeme, …) that is also a request (a `?`, please, you need to, for you, lütfen, senden, gerekiyor, …).
  - *Soft cues* (next, later, follow, further, also, could, might, would, improv…, extend, missing, not yet, left, remain; sonra, ileride, ayrıca, eksik, geliştir, iyileştir, kaldı, kalan): phrasings the work cues miss ("that's the first thing to add next"); they only send the message to the judge.
  - *No cue at all*: the stop stands, no model call.
  - *A work or soft cue*: the fast-model judge, `$.model.classify(<last 4000 chars>, JUDGE_LABELS)` (the engine's small fast model), picks *lists or offers more work it could still do itself now* → block, *asks the user for an approval, credentials or a decision only the user can make* or *reports finished work* → stop. Without a usable label (judge off with `AGENT_OFFICE_FINISH_JUDGE=0`, a failed request, no label named, or the 10 s hook budget running out, which hands the hook's `.catch` the same check without the judge) the heuristic decides: work and no ask → block; work and an ask, or soft cues only → stop.
  - *Block*: the Stop answer's `block` (the classic Stop hook's `decision: "block"`, `reason`), so Claude continues with it. Manager mode: *Agent Office: you listed remaining work. Do it now: delegate the independent parts to sub-agents in parallel, then review, integrate and verify. Stop only when the list is done or you need the person for an approval, credential or decision that is theirs; then ask in one short list.* Otherwise the same without the delegation clause (*Do it now, then verify it.*).
  - *The list was asked for*: when the person's last prompt asks for the list itself (list/suggest/recommend … next steps, follow-ups, improvements, ideas; suggestions, roadmap, just a plan, don't implement/change; sonraki adımları/önerileri listele, ne önerirsin, yol haritası, sadece plan, kod yazma, değiştirme, dokunma), the list is the answer: no block until the next prompt.
  - *Never*: more than 2 blocks (`FINISH_BLOCKS_MAX`) per prompt of the person's (`prompt.submit` with an origin other than `task-notification` resets the count; a notification does not); while `background_tasks` holds anything not completed/failed/killed (agents, shells, monitors: their notifications wake the loop and the next stop is read again) or `session_crons` is not empty; after a main turn that ended `error` or `aborted` (until the next `turn.start`); when a hook beneath already blocked; with an empty message.
- **False positives / negatives.** A wrong block costs one extra turn (capped at 2); a wrong stop costs the person one prompt, so ambiguity (a list *and* a request to the person) stops when the judge cannot decide. Mentions in a report ("deploy script added") are no ask: the topic must sit in a question or explicit request. A product question with no work cue ("blue or green?") stops without a model call.

## Projects work together: office directory and shared MCP servers (v3.9)

A project's Claude did not know the other projects in the office (asked about "nodesyai-connect", it searched the disk) and could not use their MCP servers (a local server in `~/.claude.json` `projects[<folder>]` is only loaded in that folder). `src/office-directory.js` and `src/shared-config.js` (pure functions plus the file work; no Electron); plugin `register.tsx` `directoryText`.

```ts
agentOffice.prefs.get(): Promise<{ …; shareMcp: boolean }>   // default true; state.json `shareMcp` (false only when off)
agentOffice.prefs.set(p: { shareMcp?: boolean }): Promise<…>
// userData/directory/<tab>.json (0600), path in the session's AGENT_OFFICE_DIRECTORY
type OfficeDirectory = {
  format: 1
  projects: { name: string; dir: string; account: string; mcp: string[]; current?: true }[]   // current first; ≤ 40, ≤ 20 names each
  more?: number                                                                               // projects left out
}
// shared-config.js
prepareShared({ …, office?: { share: boolean; current: string; projects: { name; dir; configDir: string | null; share: boolean }[] } })
  → { pluginDirs: string[]; mcpConfig: string | null; mcpNames: { [projectDir: string]: string[] } }
```

- **Directory.** At every pty start main writes the tab's directory: every project in sidebar order with the current one first and marked, its folder, its account (`'Default'` for Default, else the account's label) and the MCP server names this session sees for it (`mcpNames`): for the current project its own project-level servers (local, Default's local when shared, approved `.mcp.json`), for another project the names its servers have in this session (an identical one under the name the session already has, a renamed one under the new name; none when sharing is off). Only names, folders and server names, never a config. The file goes with the tab's MCP file (pty exit, kill, app start prune).
- **Plugin section** (`prompt.compose`, id `agent-office:projects`, scope `session`). When `AGENT_OFFICE_APP` is set and `AGENT_OFFICE_DIRECTORY` names a readable file listing at least one project, for every loop (main loop, subagents, teammates; manager mode or not), after the manager section: *# Projects in this Agent Office* — one line per project `- <name>[ (this session's project)]: <dir> (account <A>; MCP: a, b)`, `- … and N more` beyond 40, then: *When the person names one of these projects, they mean that folder: read and work there with absolute paths (in Bash, `cd <folder> && …`) instead of searching the disk for it. The MCP servers listed for a project are connected in this session under those names (tools `mcp__<server>__…`); use them for that project's work.* Fields are made one line and clipped (200 characters, folders 1024); 20 names per project. The file does not change while the session runs, so the text is the same on every request.
- **Shared servers.** With `shareMcp` on and the session's account taking shared servers (Default always; another account only with its v3.6 setting on), the tab's `--mcp-config` file also holds each other project's servers as that project's own session has them (`projectServers`): the local servers in its account's `.claude.json` (`~/.claude.json` for Default, `<accountDir>/.claude.json` otherwise) `projects[<dir>].mcpServers`, Default's local servers for `<dir>` when its account shares Default's (names the account has win), and the servers of `<dir>/.mcp.json` that are approved there (`enabledMcpjsonServers` or `enableAllProjectMcpServers` in `<dir>/.claude/settings.local.json`, the account's `settings.json` or its `.claude.json` `projects[<dir>]`) and not in `disabledMcpjsonServers` — an unapproved project server never runs elsewhere. Local wins over `.mcp.json` on a name. `officeMcpServers`: a server whose config (JSON with sorted keys) equals one the session already gets (its account's user servers, its local and `.mcp.json` servers for cwd, Default's shared set, another project's added one) is not added; a new name is kept; a name the session has with another config becomes `<server>-<project slug>` (slug: runs of characters other than `A-Za-z0-9_-` → `-`; then `-2`, `-3`…; at most 48 characters), since Claude Code allows only letters, digits, `-` and `_` (`claude mcp add 'a@b'` → *Invalid name*, 2.1.296). Projects are taken in sidebar order. The source files are only read.
- **Default's local servers** (v3.6 addition). Default's set for another account now also holds Default's local servers for cwd (`~/.claude.json` `projects[cwd].mcpServers`; local wins over user on a name; names the account or the project has are left out), so a project moved to another account keeps its local servers.
- **Setting.** Sidebar, under Manager mode: **Share MCP servers between projects** / **Projelerin MCP sunucularını paylaş**, default on; tooltip says that the servers' tokens are shared, how a clash is renamed and that it applies to sessions started afterwards. Off: no other project's server is added and the directory lists none for other projects (the directory itself stays).
- **Cost.** Every tab connects to the other projects' servers too (a stdio server is one process per tab). A stdio server whose command or arguments are relative to its project folder runs from the session's folder and may fail there.

## Restart in the same conversation; reload when MCP servers change (v3.11)

Claude Code loads MCP servers only when it starts: after `claude mcp add` it asks to be restarted. `src/mcp-reload.js` (pure functions; no Electron), `shared-config.js` `mcpPlan` / `mcpFingerprint`. (v3.10 is used by another branch.)

```ts
agentOffice.prefs.get(): Promise<{ …; reloadMcp: boolean }>   // default true; state.json `reloadMcp` (false only when off)
agentOffice.prefs.set(p: { reloadMcp?: boolean }): Promise<…>
agentOffice.pty.onReloaded(cb: (id: string) => void): () => void   // 'pty:reloaded', sent just before the restart
```

- **Enter-restart** (`pty:restart`, project tabs; login tabs unchanged). The tab starts in the session it was in: main keeps each tab's last session id (`lastSid`: the session it was started with, every 1.5 s poll of Claude Code's pid file, and one last read of the pid file when the pty exits). `restartOptions`: a valid id → `--resume <id>`; none, for a tab that continues (main tab, worktree tab) → `--continue`; else fresh. A failed `--resume`/`--continue` falls back to a fresh start (v2.7 rule, `RESUME_GRACE_MS`).
- **Fingerprint** (`mcpFingerprint(mcpPlan(…))`, sha256, only the hash is kept). Made of what the tab's claude loads: the `--mcp-config` servers (Default's set, other projects' servers, v3.6/v3.9) and its own servers: the account's `.claude.json` top-level `mcpServers` and `projects[cwd].mcpServers`, `<cwd>/.mcp.json` `mcpServers`, and the `.mcp.json` approvals (`enableAllProjectMcpServers`, `enabledMcpjsonServers`, `disabledMcpjsonServers` from `projects[cwd]`, `<cwd>/.claude/settings.local.json`, the account's `settings.json`). Everything else in those files (startups, tips, costs, history, permissions) leaves it alone. Taken at every pty start (`mcpPrint[id].started`).
- **Watch** (in the 1.5 s turn poll, only while `reloadMcp` is on). `watchFiles`: `~/.claude.json`, `~/.claude/settings.json`, each account's `.claude.json` and `settings.json`, and for every project and worktree tab folder `.mcp.json` and `.claude/settings.local.json`; `statKey` = size and mtime of each, plus the office's projects, their accounts, the accounts' share settings and `shareMcp`. A changed key is acted on once it stayed the same for one more poll (`settle`); then every running tab's fingerprint is recomputed (files read once per pass).
- **Reload** (`reloadAction`). A running tab whose current fingerprint differs from its start one is restarted when idle: the export rule (`transfer.js` `exportBlocker`: not mid-turn, no permission prompt, no running agents or background shells, no unsent text in the prompt, the pid file and office file known). Otherwise it waits and is checked again every poll. Restart: `pty:reloaded` to the renderer (the terminal is cleared and shows `terminal.mcpReloaded`, **— MCP servers reloaded: Claude restarted in the same conversation —** / **— MCP sunucuları yeniden yüklendi: Claude aynı konuşmada yeniden başladı —**), then `startPty(id, { sessionId })` → `--resume <its session>`, which also rewrites the tab's MCP file and office directory (v3.9). Sleeping and not-started tabs need nothing: they take the current set when they start.
- **Setting.** Sidebar, under "Share MCP servers between projects": **Reload sessions when MCP changes** / **MCP değişince oturumları yenile**, default on; tooltip lists what counts as a change and when a session is left alone.
