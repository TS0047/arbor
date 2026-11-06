import type { Agent, ChatMessage, Exclusion, ExclusionReason, GNode, Graph, Turn } from '../types'

/**
 * Context assembly — the core of the app.
 *
 * 1. `transcriptOf` walks a node's ancestry and flattens it into Turns.
 *    Summary nodes cut the walk (they stand in for everything above them),
 *    muted nodes pass their ancestors through but contribute nothing.
 * 2. `contextFor` handles merges: the parents' transcripts share a common
 *    prefix (the history before the branches split). That prefix is kept as
 *    normal turns; each divergent tail is packed into one labelled block.
 * 3. `toMessages` renders Turns for one speaker: that speaker's own words
 *    become `assistant`, everyone else's become `user` with a name tag.
 *    That is what lets different models, or personas, talk to each other.
 */

type Memo = Map<string, Turn[]>

export const branchLabel = (i: number) =>
  String.fromCharCode(65 + (i % 26)) + (i >= 26 ? String(Math.floor(i / 26)) : '')

export const isCheckpoint = (n: GNode) =>
  n.kind === 'summary' && !n.muted && n.status === 'done' && !!n.response?.trim()

const speakerOf = (t: Turn) =>
  t.role === 'user' ? 'User' : (t.agent ?? (t.model ? `Assistant (${t.model})` : 'Assistant'))

function ownTurns(n: GNode): Turn[] {
  if (n.muted || n.kind === 'summary') return []
  const out: Turn[] = []
  if (n.prompt?.trim()) out.push({ key: `${n.id}:p`, nodeId: n.id, role: 'user', text: n.prompt })
  if (n.response?.trim())
    out.push({
      key: `${n.id}:r`,
      nodeId: n.id,
      role: 'assistant',
      text: n.response,
      model: n.model,
      agent: n.agent?.name,
    })
  return out
}

/** Everything a node "remembers": its context plus its own exchange. */
export function transcriptOf(g: Graph, id: string, memo: Memo = new Map()): Turn[] {
  const cached = memo.get(id)
  if (cached) return cached
  const n = g.nodes[id]
  if (!n) return []
  const out = isCheckpoint(n)
    ? [
        {
          key: `${n.id}:s`,
          nodeId: n.id,
          role: 'user' as const,
          kind: 'summary' as const,
          text: `Summary of the earlier conversation:\n\n${n.response}`,
        },
      ]
    : [...contextFor(g, n.parents, memo, n.id), ...ownTurns(n)]
  memo.set(id, out)
  return out
}

/** The context a new child of `parentIds` would see (before its own prompt). */
export function contextFor(g: Graph, parentIds: string[], memo: Memo = new Map(), ownerId = ''): Turn[] {
  const parents = parentIds.filter((p) => g.nodes[p])
  if (parents.length === 0) return []
  if (parents.length === 1) return transcriptOf(g, parents[0], memo)

  const lists = parents.map((p) => transcriptOf(g, p, memo))
  const shortest = Math.min(...lists.map((l) => l.length))
  let k = 0
  while (k < shortest && lists.every((l) => l[k].key === lists[0][k].key)) k++

  const blocks = lists
    .map((l, i) => {
      const tail = l.slice(k)
      if (!tail.length) return ''
      const body = tail.map((t) => (t.kind ? t.text : `${speakerOf(t)}: ${t.text}`)).join('\n\n')
      return `<branch name="${branchLabel(i)}">\n${body}\n</branch>`
    })
    .filter(Boolean)

  const prefix = lists[0].slice(0, k)
  if (!blocks.length) return prefix
  const sources = [
    ...new Set(
      lists.flatMap((l) => l.slice(k).flatMap((t) => [t.nodeId, ...(t.sources ?? [])])).filter(Boolean),
    ),
  ]
  return [
    ...prefix,
    {
      key: `merge:${ownerId || parents.join('+')}`,
      nodeId: ownerId,
      role: 'user',
      kind: 'merge',
      text:
        `From here the conversation split into ${blocks.length} parallel branches. ` +
        `Treat them as separate explorations of the same starting point, not as one sequence.\n\n` +
        blocks.join('\n\n'),
      sources,
    },
  ]
}

function push(msgs: ChatMessage[], role: 'user' | 'assistant', content: string) {
  const last = msgs[msgs.length - 1]
  if (last && last.role === role) last.content += '\n\n' + content
  else msgs.push({ role, content })
}

/** Render turns for one speaker. `agent` undefined = the plain assistant. */
export function toMessages(turns: Turn[], self: { agent?: string }, system?: string): ChatMessage[] {
  const msgs: ChatMessage[] = []
  if (system?.trim()) msgs.push({ role: 'system', content: system.trim() })
  const multiVoice = !!self.agent || turns.some((t) => t.agent)
  for (const t of turns) {
    const mine = t.role === 'assistant' && (self.agent ? t.agent === self.agent : !t.agent)
    if (mine) {
      push(msgs, 'assistant', t.text)
      continue
    }
    const tagged = !t.kind && (t.role === 'assistant' || multiVoice)
    push(msgs, 'user', tagged ? `[${speakerOf(t)}]: ${t.text}` : t.text)
  }
  return msgs
}

export function agentSystem(agent: Agent, peers: string[], base?: string) {
  return [
    base?.trim(),
    `You are ${agent.name}, one participant in a live multi-party conversation` +
      (peers.length ? ` with ${peers.join(', ')}.` : '.'),
    agent.persona.trim(),
    `Other participants' messages arrive prefixed like "[Name]: …". Reply only as ${agent.name}, ` +
      `in first person, with no name prefix. Engage directly with what was just said. ` +
      `Keep it conversational and under about 150 words unless asked for more.`,
  ]
    .filter(Boolean)
    .join('\n\n')
}

export const SUMMARY_INSTRUCTION =
  'Summarize the conversation above so the summary can replace it as context for future turns. ' +
  'Keep every decision, fact, number, name, code identifier and open question. ' +
  'Use compact bullet points grouped by topic. No preamble, no commentary.'

/** Nodes whose own words reach the model, in reading order. Synthetic turns list their sources. */
export function turnNodeIds(turns: Turn[], self = ''): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const t of turns) {
    for (const id of [t.nodeId, ...(t.sources ?? [])]) {
      if (!id || id === self || seen.has(id)) continue
      seen.add(id)
      out.push(id)
    }
  }
  return out
}

export interface Compiled {
  messages: ChatMessage[]
  turns: Turn[]
  nodeIds: string[]
}

/** Everything the app needs to know about one request: what is sent, and which nodes made it. */
export function compileFor(g: Graph, id: string): Compiled {
  const n = g.nodes[id]
  if (!n) return { messages: [], turns: [], nodeIds: [] }
  const ctx = contextFor(g, n.parents, new Map(), id)

  if (n.kind === 'summary') {
    const msgs = toMessages(ctx, {}, g.systemPrompt)
    push(msgs, 'user', SUMMARY_INSTRUCTION)
    return { messages: msgs, turns: ctx, nodeIds: turnNodeIds(ctx, id) }
  }

  const turns: Turn[] = n.prompt?.trim()
    ? [...ctx, { key: `${id}:p`, nodeId: id, role: 'user', text: n.prompt }]
    : ctx
  const system = n.agent ? agentSystem(n.agent, n.peers ?? [], g.systemPrompt) : g.systemPrompt
  const msgs = toMessages(turns, { agent: n.agent?.name }, system)
  const last = msgs[msgs.length - 1]
  if (!last || last.role !== 'user')
    push(msgs, 'user', n.agent ? `[Moderator]: Your turn, ${n.agent.name}.` : 'Continue.')
  return { messages: msgs, turns, nodeIds: turnNodeIds(turns, id) }
}

/** The exact request for generating node `id`. */
export function requestFor(g: Graph, id: string): ChatMessage[] {
  return compileFor(g, id).messages
}

export const EXCLUSION_LABEL: Record<ExclusionReason, string> = {
  muted: 'Muted',
  checkpointed: 'Replaced by checkpoint',
  later: 'Comes later',
  empty: 'Empty',
  branch: 'Different branch',
}

export const EXCLUSION_HINT: Record<ExclusionReason, string> = {
  muted: 'On this path, but muted — it stays on the canvas and is skipped here.',
  checkpointed: 'A checkpoint above it stands in for this part of the thread.',
  later: 'Downstream of where you are continuing from — not history yet.',
  empty: 'No prompt or reply yet.',
  branch: 'Not an ancestor of where you are continuing from.',
}

/**
 * Split every node into "reaches the model" and "does not, and why".
 * The reasons are derived from the graph, so the panel can answer
 * "why didn't it know about X?" without guessing.
 */
export function contextAudit(g: Graph, ids: string[]): { included: string[]; excluded: Exclusion[] } {
  const turns = contextFor(g, ids)
  const included = turnNodeIds(turns)
  const inSet = new Set(included)
  const onPath = contextNodeSet(g, ids)

  const checkpointed = new Set<string>()
  for (const id of included) {
    const n = g.nodes[id]
    if (n && isCheckpoint(n)) for (const a of contextNodeSet(g, n.parents)) if (!inSet.has(a)) checkpointed.add(a)
  }

  const downstream = new Set<string>()
  for (const id of ids) for (const d of descendantsOf(g, id)) downstream.add(d)

  const rank: Record<ExclusionReason, number> = { muted: 0, checkpointed: 1, later: 2, empty: 3, branch: 4 }
  const excluded: Exclusion[] = []
  for (const n of Object.values(g.nodes)) {
    if (inSet.has(n.id)) continue
    let reason: ExclusionReason
    if (onPath.has(n.id) && n.muted) reason = 'muted'
    else if (checkpointed.has(n.id)) reason = 'checkpointed'
    else if (!n.prompt?.trim() && !n.response?.trim()) reason = 'empty'
    else if (onPath.has(n.id)) reason = 'empty'
    else if (downstream.has(n.id)) reason = 'later'
    else reason = 'branch'
    excluded.push({ id: n.id, reason })
  }
  excluded.sort((a, b) => rank[a.reason] - rank[b.reason] || a.id.localeCompare(b.id))
  return { included, excluded }
}

/** What the composer's next message would send, for the token meter and Context tab. */
export function previewFor(g: Graph, parents: string[], draft: string): ChatMessage[] {
  const ctx = contextFor(g, parents)
  const turns: Turn[] = draft.trim()
    ? [...ctx, { key: 'draft', nodeId: '', role: 'user', text: draft }]
    : ctx
  return toMessages(turns, {}, g.systemPrompt)
}

/** ~4 characters per token is a decent rule of thumb for English with BPE tokenizers. */
export const estimateTokens = (msgs: ChatMessage[]) =>
  msgs.reduce((sum, m) => sum + Math.ceil(m.content.length / 4) + 4, 0)

/** Nodes whose content reaches the model if you continue from `ids` — drives the canvas highlight. */
export function contextNodeSet(g: Graph, ids: string[]): Set<string> {
  const seen = new Set<string>()
  const stack = [...ids]
  while (stack.length) {
    const id = stack.pop()!
    const n = g.nodes[id]
    if (!n || seen.has(id)) continue
    seen.add(id)
    if (!isCheckpoint(n)) stack.push(...n.parents)
  }
  return seen
}

export function childrenMap(g: Graph) {
  const kids = new Map<string, string[]>()
  for (const n of Object.values(g.nodes))
    for (const p of n.parents) kids.set(p, [...(kids.get(p) ?? []), n.id])
  return kids
}

export function descendantsOf(g: Graph, id: string): string[] {
  const kids = childrenMap(g)
  const seen = new Set<string>()
  const stack = [...(kids.get(id) ?? [])]
  while (stack.length) {
    const c = stack.pop()!
    if (seen.has(c)) continue
    seen.add(c)
    stack.push(...(kids.get(c) ?? []))
  }
  return [...seen]
}

/** Deleting nodes also deletes descendants that would be left with no parent at all. */
export function deletionClosure(g: Graph, ids: string[]): Set<string> {
  const kill = new Set(ids)
  let changed = true
  while (changed) {
    changed = false
    for (const n of Object.values(g.nodes)) {
      if (kill.has(n.id) || !n.parents.length) continue
      if (n.parents.every((p) => kill.has(p))) {
        kill.add(n.id)
        changed = true
      }
    }
  }
  return kill
}
