export type NodeKind = 'chat' | 'summary'
export type NodeStatus = 'pending' | 'streaming' | 'done' | 'error'

/** A dialogue participant: a named persona bound to one local model. */
export interface Agent {
  name: string
  model: string
  persona: string
  color: string
}

export interface NodeStats {
  promptTokens?: number
  cachedTokens?: number // prompt tokens Ollama reused from its KV cache (shared prefix)
  outputTokens?: number
  ms?: number
}

export type ExclusionReason = 'muted' | 'checkpointed' | 'later' | 'empty' | 'branch'

export interface Exclusion {
  id: string
  reason: ExclusionReason
}

/**
 * A snapshot of the exact request a node was generated from. Stored so the
 * receipt stays honest after the graph is edited: it is what the model saw,
 * not what the current graph would compile to.
 */
export interface Receipt {
  messages: ChatMessage[]
  nodeIds: string[]
  excluded: Exclusion[]
  at: number
}

/**
 * One node = one exchange. `prompt` is the human's words (absent for pure
 * agent turns), `response` is the model's. Making the exchange the unit keeps
 * user/assistant alternation intact when a node is muted or merged.
 */
export interface GNode {
  id: string
  parents: string[] // 0 = root, 1 = continuation, 2+ = merge
  kind: NodeKind // 'summary' = a context checkpoint that replaces its ancestors
  prompt?: string
  response?: string
  thinking?: string
  model?: string
  agent?: Agent
  peers?: string[] // other participants' names, for agent turns
  muted?: boolean // kept on the canvas, skipped in context
  stale?: boolean // something upstream changed after this was generated
  status: NodeStatus
  error?: string
  stats?: NodeStats
  receipt?: Receipt // what this answer was actually generated from
  position: { x: number; y: number }
  createdAt: number
}

export interface Graph {
  id: string
  title: string
  nodes: Record<string, GNode>
  systemPrompt: string
  createdAt: number
  updatedAt: number
  version: 1
}

export interface GraphMeta {
  id: string
  title: string
  updatedAt: number
  nodeCount: number
}

export interface AppSettings {
  ollamaUrl: string
  temperature: number
  numCtx: number
  composerModels: string[]
  think: 'auto' | 'off' // 'off' asks reasoning models (qwen3, deepseek-r1…) to skip their chain of thought
}

/** A flattened piece of context, before it is rendered for a specific speaker. */
export interface Turn {
  key: string // identity used to find the shared prefix of merged branches
  nodeId: string
  role: 'user' | 'assistant'
  text: string
  model?: string
  agent?: string
  kind?: 'merge' | 'summary'
  sources?: string[] // nodes packed into a synthetic turn (merge tails)
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface DialogueConfig {
  agents: Agent[]
  topic: string
  turns: number
}
