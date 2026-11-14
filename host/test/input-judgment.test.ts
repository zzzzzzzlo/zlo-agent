import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { codingResources } from '../src/coding-resources.ts'
import { frameInstruction, preflight, skillDisclosure } from '../src/input-judgment.ts'
import { LocalJudgment } from '../src/judgment.ts'
import { LocalStore } from '../src/store.ts'

const event = { type: 'agent.started', taskId: 'input-helper-test', payload: {} }
const goal = 'Refactor the rendering pipeline'
const change = 'Please keep the old Node adapter.\r\nPreserve its module boundaries.'

test('input classification changes only the Active prompt and keeps the original user wording', async () => {
  const store = new LocalStore(':memory:')
  try {
    for (const mode of ['off', 'shadow', 'active'] as const) {
      const judged: string[] = []
      const kernel = new LocalJudgment(store, {
        modes: { 'input.preflight': mode, 'task.frame': mode },
        judge: {
          async evaluate({ id }) {
            judged.push(id)
            return { output: id === 'input.preflight' ? 'complex' : 'constraint' }
          },
        },
      })
      const effort = await preflight(kernel, event, goal)
      const text = await frameInstruction(kernel, event, goal, change)
      assert.deepEqual(judged, mode === 'off' ? [] : ['input.preflight', 'task.frame'])
      if (mode === 'active') {
        assert.equal(effort.reasoningEffort, 'high')
        assert.ok(effort.hint?.includes('several steps'))
        assert.equal(text.slice(0, change.length), change)
        assert.match(text, /Task frame advisory: This message appears to add a constraint/)
      } else {
        assert.deepEqual(effort, {})
        assert.equal(text, change)
      }
    }
    const invalid = new LocalJudgment(store, {
      modes: { 'input.preflight': 'active', 'task.frame': 'active' },
      judge: { async evaluate() { return { output: 'Rewrite the user message' } } },
    })
    assert.deepEqual(await preflight(invalid, event, goal), {})
    assert.equal(await frameInstruction(invalid, event, goal, change), change)
    assert.doesNotMatch(JSON.stringify(store.events(event.taskId)), /old Node adapter|rendering pipeline/)
  } finally { store.close() }
})

test('skill disclosure sends authorized skill metadata and keeps omitted skills readable by name', async () => {
  const path = await realpath(await mkdtemp(join(tmpdir(), 'zlo-skill-disclosure-')))
  const store = new LocalStore(':memory:')
  try {
    for (const [name, description, extra] of [
      ['frontend', 'Frontend guide for buttons', ''],
      ['database', 'Postgres schema guide', ''],
      ['private', 'Private skill description', '\ndisable-model-invocation: true'],
    ]) {
      const folder = join(path, '.agents', 'skills', name)
      await mkdir(folder, { recursive: true })
      await writeFile(join(folder, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}${extra}\n---\nFULL_SKILL_${name}\n`)
    }
    for (const mode of ['shadow', 'active'] as const) {
      const kernel = new LocalJudgment(store, {
        policy: () => ({ mode, allowScopedEvidence: true, judge: {
          async evaluate() { throw new Error('Skills use one batched call') },
          async evaluateBatch(request) {
            assert.deepEqual(request.items.map(item => item.label), ['database', 'frontend'])
            assert.doesNotMatch(JSON.stringify(request), /FULL_SKILL|Private skill description|SKILL\.md/)
            return { items: [{ output: false }, { output: true }] }
          },
        } }),
      })
      const resources = await codingResources('Base prompt', { project: path }, () => true, skillDisclosure(kernel, event, goal))
      const prompt = resources.loader.getAppendSystemPrompt().join('\n')
      assert.match(prompt, /Frontend guide for buttons/)
      assert.equal(prompt.includes('Postgres schema guide'), mode === 'shadow')
      assert.doesNotMatch(prompt, /Private skill description|FULL_SKILL/)
      assert.match(JSON.stringify(await resources.skillTool?.execute('skill', { name: 'database' })), /FULL_SKILL_database/)
      assert.match(JSON.stringify(await resources.skillTool?.execute('hidden', { name: 'private' })), /Skill is unavailable/)
    }
  } finally {
    store.close()
    await rm(path, { recursive: true, force: true })
  }
})
