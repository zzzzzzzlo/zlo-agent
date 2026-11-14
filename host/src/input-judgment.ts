import type { EventDraft } from './contracts/domain.ts'
import type { ExecutionConfig } from './execution.ts'
import type { LocalJudgment } from './judgment.ts'

const taskKinds = ['default', 'question', 'routine', 'investigation', 'complex'] as const
const frameChanges = ['unchanged', 'new_goal', 'constraint', 'correction', 'subgoal'] as const

const preflightAdvice: Record<Exclude<typeof taskKinds[number], 'default'>, {
  hint: string
  reasoningEffort: NonNullable<ExecutionConfig['reasoningEffort']>
}> = {
  question: { hint: 'This appears to ask for an answer or explanation. Read any explicit action requests before deciding how to proceed.', reasoningEffort: 'low' },
  routine: { hint: 'This appears to be a straightforward task. Use the simplest approach that satisfies the request.', reasoningEffort: 'low' },
  investigation: { hint: 'This appears to need investigation. Gather evidence before reaching a conclusion.', reasoningEffort: 'medium' },
  complex: { hint: 'This appears to require several steps or careful reasoning. Identify dependencies and verify the important changes.', reasoningEffort: 'high' },
}

const frameAdvice = {
  new_goal: 'This message appears to introduce a new objective. Interpret it in light of the exact user wording and the current authorization.',
  constraint: 'This message appears to add a constraint. Follow the user’s exact wording.',
  correction: 'This message appears to correct the current approach. Reconsider it using the exact user wording.',
  subgoal: 'This message appears to specify the next part of the current task. Keep its existing constraints.',
} as const

export async function preflight(judgment: LocalJudgment, event: EventDraft, goal: string, signal?: AbortSignal):
Promise<{ hint?: string; reasoningEffort?: ExecutionConfig['reasoningEffort'] }> {
  const kind = await judgment.decide(event, 'input.preflight', { length: goal.length }, 'default', taskKinds, [], {
    signal, scopedEvidence: () => ({ goal }),
  })
  return kind === 'default' ? {} : preflightAdvice[kind]
}

export async function frameInstruction(judgment: LocalJudgment, event: EventDraft, goal: string, instruction: string,
  signal?: AbortSignal, initial = false): Promise<string> {
  const change = await judgment.decide(event, 'task.frame', { length: instruction.length, initial }, 'unchanged', frameChanges, [], {
    signal, scopedEvidence: () => ({ utterance: instruction, parentGoal: initial && goal === instruction ? undefined : goal }),
  })
  if (change === 'unchanged') return instruction
  return instruction + '\n\nTask frame advisory: ' + frameAdvice[change]
}

export function skillDisclosure(judgment: LocalJudgment, event: EventDraft, goal: string, signal?: AbortSignal):
NonNullable<ExecutionConfig['selectSkills']> {
  return async (skills) => {
    signal?.throwIfAborted()
    // The validated catalog has at most 24 entries. Keep every uncertain skill visible.
    const pages: Promise<string[]>[] = []
    for (let start = 0; start < skills.length; start += 8) {
      const batch = skills.slice(start, start + 8)
      pages.push(judgment.decideBatch(event, 'skills.disclosure', { goal },
        batch.map(({ name, description }) => ({ baseline: true, label: name, excerpt: description.slice(0, 220) })), [], { signal })
        .then(results => batch.filter((_, index) => results[index] !== false).map(({ name }) => name)))
    }
    const visible = new Set((await Promise.all(pages)).flat())
    signal?.throwIfAborted()
    return visible
  }
}
