import { writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { diagnostic, writeHostDiagnostic } from '../../../shared/diagnostics.ts'

const [variant, marker = ''] = process.argv.slice(2)
const output = (message) => process.stdout.write(JSON.stringify({ schemaVersion: 1, ...message }) + '\n')
const ready = JSON.stringify({ schemaVersion: 1, kind: 'ready', mode: variant === 'bad-mode' ? 'pi' : 'faux' }) + '\n'
const response = (request, result) => output({ kind: 'result', commandId: request.commandId, type: request.type, result })
if (variant === 'diagnostic') {
  const entry = diagnostic('host.model_failed', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
  const privateText = 'fixture-only-private-prompt'
  process.stderr.write(privateText + '\n')
  process.stderr.write(JSON.stringify({ ...entry, summary: privateText }) + '\n')
  process.stderr.write(JSON.stringify({ ...entry, detail: privateText }) + '\n')
  process.stderr.write('x'.repeat(4096) + JSON.stringify(entry) + '\n')
  writeHostDiagnostic(entry.code, entry.correlationId)
}
if (variant !== 'no-ready') {
  process.stdout.write(ready.slice(0, 11))
  setTimeout(() => process.stdout.write(ready.slice(11)), 25)
}
const lines = createInterface({ input: process.stdin })
for await (const line of lines) {
  const request = JSON.parse(line)
  switch (request.type) {
    case 'listConversations':
      setTimeout(() => response(request, ['first']), 25)
      break
    case 'getConversation':
      response(request, { id: request.conversationId })
      break
    case 'subscribeConversation':
      response(request, true)
      output({
        kind: 'conversation.event',
        event: {
          schemaVersion: 1, eventId: 'event-1', seq: request.after + 1, timestamp: Date.now(),
          conversationId: request.conversationId, type: 'message.delta', payload: { delta: '测试' },
        },
      })
      break
    case 'renameConversation':
      output({
        kind: 'error', commandId: request.commandId,
        error: { code: 'CONFLICT', message: 'This fixture rejects renaming.' },
      })
      break
    case 'archiveConversation':
      process.stderr.write('fixture provider credential was withheld\n')
      process.exit(17)
      break
    case 'exit':
      if (marker) writeFileSync(marker, 'clean')
      process.exit(0)
  }
}
