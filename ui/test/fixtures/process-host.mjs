import { writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const [variant, marker = ''] = process.argv.slice(2)
const output = (message) => process.stdout.write(JSON.stringify({ schemaVersion: 1, ...message }) + '\n')
const ready = JSON.stringify({ schemaVersion: 1, kind: 'ready', mode: variant === 'bad-mode' ? 'pi' : 'faux' }) + '\n'
const response = (request, result) => output({ kind: 'result', commandId: request.commandId, type: request.type, result })
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
