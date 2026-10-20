// Engine capabilities (contract v3.36): node --test app/test/engine-caps.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { ENGINES, FEATURES, caps, cap, BOSS_MODEL_CHOICES, bossModelChoices } from '../src/engine-caps.mjs'

const require = createRequire(import.meta.url)
const P = require('../src/projects.js')
const EN = require('../src/engine.js')
const en = JSON.parse(readFileSync(new URL('../locales/en.json', import.meta.url), 'utf8'))

test('every engine has every feature; Claude Code can do all of them', () => {
  for (const e of ENGINES) assert.deepEqual(Object.keys(caps(e)), FEATURES)
  for (const f of FEATURES) assert.equal(cap('claude', f).ok, true, f)
  assert.deepEqual(caps('nope'), caps('claude')) // unknown engine = Claude Code
  assert.deepEqual(caps(undefined), caps('claude'))
})

test('a feature an engine cannot honour has a reason with a locale string', () => {
  for (const e of ENGINES) {
    for (const [f, c] of Object.entries(caps(e))) {
      if (c.ok) { assert.equal(c.reason, undefined); continue }
      assert.equal(typeof en.sidebar.na[c.reason], 'string', `${e}.${f}: sidebar.na.${c.reason} missing`)
    }
  }
})

test('account, login and boss model work on every engine; backup on none but Claude Code', () => {
  for (const e of ENGINES) for (const f of ['account', 'login', 'bossModel', 'approvals']) assert.equal(cap(e, f).ok, true, `${e}.${f}`)
  assert.equal(cap('agy', 'backup').ok, false)
  assert.equal(cap('commandcode', 'backup').ok, false)
})

test('Command Code: manager, context cap, savings, workers, approvals and cost on; Antigravity: off', () => {
  for (const f of ['manager', 'contextCap', 'savings', 'workers', 'approvals', 'cost']) assert.equal(cap('commandcode', f).ok, true, f)
  for (const f of ['manager', 'agentModel', 'contextCap', 'savings', 'workers', 'cost']) assert.equal(cap('agy', f).ok, false, f)
  assert.equal(cap('commandcode', 'agentModel').ok, false)
})

test('boss model choices match projects.js per engine; launch arguments per engine', () => {
  for (const e of ENGINES) assert.deepEqual(bossModelChoices(e).map((c) => c.value), P.BOSS_MODELS_BY_ENGINE[e], e)
  assert.deepEqual(BOSS_MODEL_CHOICES.claude.map((c) => c.value), P.BOSS_MODELS)
  assert.deepEqual(P.bossModelArgs({ engine: 'agy', bossModel: 'pro' }), ['--model', 'pro'])
  assert.deepEqual(P.bossModelArgs({ engine: 'agy', bossModel: 'opus' }), []) // not an agy model: Auto
  assert.deepEqual(P.bossModelArgs({ engine: 'commandcode', bossModel: 'claude-opus-5-5' }), ['-m', 'claude-opus-5-5'])
  assert.deepEqual(P.bossModelArgs({ engine: 'commandcode', bossModel: 'haiku' }), [])
  assert.deepEqual(P.bossModelArgs({ bossModel: 'flash' }), []) // not a Claude alias
  // the model goes first, before --continue and the prompt
  assert.deepEqual(EN.agyArgs({ model: 'flash', resume: true, prompt: 'go' }), ['--model', 'flash', '--continue', '-i', 'go'])
  assert.deepEqual(EN.cmdArgs({ model: 'claude-haiku-5-5', resume: true, prompt: 'go' }), ['-m', 'claude-haiku-5-5', '--continue', 'go'])
  assert.deepEqual(EN.agyArgs({ model: null }), [])
  assert.deepEqual(EN.cmdArgs({}), [])
})

test('setProjectBossModel validates against the project engine; normalizeState drops a misfit', () => {
  const s = { projects: [{ id: 'a', dir: '/a', engine: 'agy' }, { id: 'c', dir: '/c', engine: 'commandcode' }, { id: 'k', dir: '/k' }] }
  assert.equal(P.setProjectBossModel(s, 'a', 'opus'), s)
  assert.equal(P.findProject(P.setProjectBossModel(s, 'a', 'pro'), 'a').bossModel, 'pro')
  assert.equal(P.findProject(P.setProjectBossModel(s, 'c', 'deepseek/deepseek-v4-flash'), 'c').bossModel, 'deepseek/deepseek-v4-flash')
  assert.equal(P.setProjectBossModel(s, 'k', 'claude-opus-5-5'), s)
  const n = P.normalizeState({ projects: [{ dir: '/x', engine: 'agy', bossModel: 'opus' }, { dir: '/y', engine: 'agy', bossModel: 'flash' }] })
  assert.deepEqual(n.projects.map((p) => p.bossModel ?? null), [null, 'flash'])
})

test('no leak: the model is the only thing added to the agy / Command Code launch line', () => {
  const a = EN.agyArgs({ model: 'pro' }); const c = EN.cmdArgs({ model: 'claude-opus-5-5' })
  assert.deepEqual([a, c], [['--model', 'pro'], ['-m', 'claude-opus-5-5']])
  for (const x of [...a, ...c]) assert.doesNotMatch(x, /plugin|settings|mcp|office|AGENT_OFFICE/i)
})
