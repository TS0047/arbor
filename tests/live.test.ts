import assert from 'node:assert/strict'
// Live integration test: real Ollama, real tokens, no mocks.
// Run with: npm run test:live   (needs `ollama serve` and at least one model)
import { listModels, streamChat } from '../src/lib/ollama.ts'
import { compileFor, contextAudit } from '../src/lib/context.ts'

const BASE = process.env.OLLAMA_URL ?? 'http://127.0.0.1:11434'
const TOKEN = 'ALPHA-4417'

const models = await listModels(BASE)
assert.ok(models.length > 0, `no models installed at ${BASE}`)
const preferred = ['qwen2.5:3b', 'llama3.1:8b', 'llama3.2:3b']
const model = preferred.find((m) => models.some((x) => x.name === m)) ?? models[0].name
console.log(`using ${model} at ${BASE}`)

async function ask(messages: { role: 'user' | 'assistant' | 'system'; content: string }[]) {
  let text = ''
  const stats = await streamChat({
    base: BASE,
    model,
    messages,
    temperature: 0,
    numCtx: 2048,
    signal: new AbortController().signal,
    onDelta: (d) => {
      text += d.content ?? ''
    },
  })
  return { text: text.trim(), stats }
}

// 1. Generate a real first turn and keep it as the graph's only node.
const first = await ask([
  { role: 'user', content: `Remember the code ${TOKEN}. Reply with exactly: stored` },
])
assert.ok(first.text.length > 0, 'first reply was empty')
assert.ok((first.stats.promptTokens ?? 0) > 0, 'Ollama did not report prompt tokens')
assert.ok((first.stats.outputTokens ?? 0) > 0, 'Ollama did not report output tokens')
console.log(`turn 1: ${first.text.slice(0, 60)} · ${first.stats.promptTokens} in / ${first.stats.outputTokens} out`)

const graph: any = {
  id: 'live',
  title: 'live test',
  systemPrompt: '',
  createdAt: Date.now(),
  updatedAt: Date.now(),
  version: 1,
  nodes: {
    a: {
      id: 'a',
      parents: [],
      kind: 'chat',
      prompt: `Remember the code ${TOKEN}. Reply with exactly: stored`,
      response: first.text,
      model,
      status: 'done',
      stats: first.stats,
      position: { x: 0, y: 0 },
      createdAt: Date.now(),
    },
    b: {
      id: 'b',
      parents: ['a'],
      kind: 'chat',
      prompt: 'What was the code? Reply with the code only, no other words.',
      model,
      status: 'pending',
      position: { x: 0, y: 200 },
      createdAt: Date.now(),
    },
  },
}

// 2. The compiler must put the real first turn in front of the real request.
const compiled = compileFor(graph, 'b')
assert.deepEqual(compiled.nodeIds, ['a'])
assert.equal(compiled.messages.at(-1)?.content, graph.nodes.b.prompt)
assert.equal(compiled.messages.find((m) => m.role === 'assistant')?.content, first.text)
assert.ok(compiled.messages[0].content.includes(TOKEN), 'the real first prompt is in the compiled request')

// 3. Ask the model through that compiled request: it must recall the code.
const second = await ask(compiled.messages)
assert.ok(second.text.includes(TOKEN), `model lost the code: ${JSON.stringify(second.text)}`)
assert.ok((second.stats.promptTokens ?? 0) > 0)
console.log(`turn 2: ${second.text.slice(0, 60)} · ${second.stats.promptTokens} in / ${second.stats.outputTokens} out`)

// 4. Add a real sibling branch and confirm the audit explains both sides.
graph.nodes.b.response = second.text
graph.nodes.b.status = 'done'
graph.updatedAt = Date.now()
graph.nodes.c = {
  id: 'c',
  parents: ['a'],
  kind: 'chat',
  prompt: 'Name one colour. One word.',
  response: (await ask([{ role: 'user', content: 'Name one colour. One word.' }])).text,
  model,
  status: 'done',
  position: { x: 400, y: 200 },
  createdAt: Date.now(),
}

const audit = contextAudit(graph, ['b'])
assert.deepEqual(audit.included, ['a', 'b'])
assert.deepEqual(
  audit.excluded.map((e) => `${e.id}:${e.reason}`),
  ['c:branch'],
  'the sibling branch must be excluded, with a reason',
)

// 5. Merging both branches reaches the model as labelled blocks, and the model
//    can answer from the sibling it never generated in this call.
graph.nodes.m = {
  id: 'm',
  parents: ['b', 'c'],
  kind: 'chat',
  prompt: 'List the code and the colour from the branches, as "code, colour".',
  model,
  status: 'pending',
  position: { x: 200, y: 400 },
  createdAt: Date.now(),
}
const merged = compileFor(graph, 'm')
assert.deepEqual(merged.nodeIds, ['a', 'b', 'c'])
const mergeTurn = merged.messages.at(-1)!.content
assert.ok(mergeTurn.includes('<branch name="A">') && mergeTurn.includes('<branch name="B">'))
const third = await ask(merged.messages)
assert.ok(third.text.includes(TOKEN), `merged answer lost the code: ${JSON.stringify(third.text)}`)
assert.ok(third.text.toLowerCase().includes(graph.nodes.c.response.toLowerCase().split(/[\s,.;]/)[0] ?? ''), `merged answer lost the colour: ${JSON.stringify(third.text)}`)
console.log(`merge: ${third.text.slice(0, 80)}`)

console.log('all live tests passed (real Ollama, no mocks)')
