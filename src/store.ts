import { create } from 'zustand'
import { applyNodeChanges, type Node, type NodeChange } from '@xyflow/react'
import type { AppSettings, DialogueConfig, GNode, Graph } from './types'
import { listModels, streamChat, type ModelInfo } from './lib/ollama'
import { compileFor, contextAudit, contextNodeSet, deletionClosure, descendantsOf } from './lib/context'
import { saveGraph } from './lib/persist'
import { tidyPositions } from './lib/layout'
import { snippet, splitThink, stripSelfPrefix, uid } from './lib/util'

export const NODE_W = 340
export const DEFAULT_TITLE = 'Untitled graph'
export const LAST_KEY = 'arbor:last'
const SETTINGS_KEY = 'arbor:settings'

const DEFAULT_SETTINGS: AppSettings = {
  ollamaUrl: '/ollama',
  temperature: 0.7,
  numCtx: 8192,
  composerModels: [],
  think: 'auto',
}

function loadSettings(): AppSettings {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}') }
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

export function emptyGraph(): Graph {
  const now = Date.now()
  return { id: uid(), title: DEFAULT_TITLE, nodes: {}, systemPrompt: '', createdAt: now, updatedAt: now, version: 1 }
}

// React Flow only knows ids and positions; node content lives in `graph`
// and each ChatNode subscribes to its own entry, so a streaming token
// re-renders one card instead of the whole canvas.
const toRf = (n: GNode, selected = false): Node => ({
  id: n.id,
  type: 'chat',
  position: { ...n.position },
  data: {},
  selected,
})

export type Modal = null | 'library' | 'settings' | 'dialogue' | 'models'
export type Tab = 'thread' | 'receipt' | 'node'
export type View = 'thread' | 'canvas'
type ToastAction = { label: string; run: () => void }
type Toast = { id: number; text: string; kind: 'info' | 'error'; action?: ToastAction }

/** Everything needed to put a deletion back exactly as it was. */
export interface DeletedSnapshot {
  graphId: string
  removed: GNode[] // the deleted nodes, as they were
  rf: Node[] // their canvas entries (positions, measured sizes)
  patched: GNode[] // survivors whose parent list was trimmed, as they were before
}

interface NewNode {
  parents: string[]
  kind?: GNode['kind']
  prompt?: string
  model?: string
  agent?: GNode['agent']
  peers?: string[]
}

export interface State {
  graph: Graph
  rfNodes: Node[]
  selection: string[] // what you are reading (peek); never changes what gets sent
  contextIds: string[] // ordered: what the next message continues from (merge branch letters follow this order)
  pathSet: Set<string>
  view: View
  structVersion: number
  settings: AppSettings
  models: ModelInfo[]
  ollama: 'checking' | 'online' | 'offline'
  draft: string
  modal: Modal
  tab: Tab
  inspectorOpen: boolean
  saveState: 'saved' | 'saving' | 'unsaved'
  dialogue: { turn: number; total: number } | null
  lastDialogue: DialogueConfig | null
  focusReq: { id: string; n: number } | null
  fitReq: number
  composerFocus: number
  toast: Toast | null

  setDraft(t: string): void
  setModal(m: Modal): void
  setTab(t: Tab): void
  toggleInspector(): void
  showToast(text: string, kind?: Toast['kind'], action?: ToastAction): void
  setSettings(p: Partial<AppSettings>): void
  refreshModels(): Promise<void>

  loadGraph(g: Graph): void
  newGraph(): void
  renameGraph(title: string): void
  setSystemPrompt(text: string): void
  saveNow(): Promise<void>

  onNodesChange(changes: NodeChange[]): void
  select(ids: string[]): void
  setView(v: View): void
  /** Make the peeked node(s) the send target. */
  adoptSelection(ids?: string[]): void
  /** Read a node and continue from it in one click (explicit intent). */
  continueFrom(id: string): void
  /** Add an off-path node to the send target so the next message merges it in. */
  mergeIntoContext(id: string): void
  /** Reorder merge branches (they are labelled A, B, … in this order). */
  moveContext(id: string, delta: number): void
  openReceipt(id: string): void
  focus(id: string): void
  focusComposer(): void
  requestFit(): void
  tidy(): void

  addNode(p: NewNode): string
  send(): void
  generate(id: string): Promise<void>
  stop(id: string): void
  stopAll(): void
  regenerate(id: string): void
  toggleMute(id: string): void
  summarize(id: string): void
  editAndBranch(id: string): void
  deleteNodes(ids: string[]): DeletedSnapshot | null
  restoreDeleted(snap: DeletedSnapshot): boolean
  runDialogue(cfg: DialogueConfig): Promise<void>
}

const controllers = new Map<string, AbortController>()
let dialogueCancelled = false
let toastSeq = 0

/** The "why not" half of a new node's receipt, frozen at generation time. The node itself is never "excluded" from its own answer. */
const auditExcluded = (g: Graph, id: string) => {
  const n = g.nodes[id]
  return n ? contextAudit(g, n.parents).excluded.filter((e) => e.id !== id) : []
}

export const useStore = create<State>()((set, get) => {
  const patch = (id: string, p: Partial<GNode>) =>
    set((s) => {
      const n = s.graph.nodes[id]
      if (!n) return {}
      return { graph: { ...s.graph, nodes: { ...s.graph.nodes, [id]: { ...n, ...p } }, updatedAt: Date.now() } }
    })

  const markStale = (ids: string[]) =>
    set((s) => {
      const nodes = { ...s.graph.nodes }
      for (const d of ids) if (nodes[d]?.response) nodes[d] = { ...nodes[d], stale: true }
      return { graph: { ...s.graph, nodes } }
    })

  const refreshPath = () => set((s) => ({ pathSet: contextNodeSet(s.graph, s.contextIds) }))

  /** Below its parents, nudged right until it doesn't overlap anything. */
  const placeNode = (parents: string[]) => {
    const { rfNodes } = get()
    const byId = new Map(rfNodes.map((n) => [n.id, n]))
    const h = (n: Node) => n.measured?.height ?? 180
    const ps = parents.map((p) => byId.get(p)).filter((n): n is Node => !!n)
    let x: number
    let y: number
    if (ps.length) {
      x = ps.reduce((a, p) => a + p.position.x, 0) / ps.length
      y = Math.max(...ps.map((p) => p.position.y + h(p))) + 70
    } else {
      x = rfNodes.length ? Math.max(...rfNodes.map((n) => n.position.x)) + NODE_W + 120 : 0
      y = 0
    }
    for (let guard = 0; guard < 300; guard++) {
      const hit = rfNodes.some(
        (n) => Math.abs(n.position.x - x) < NODE_W + 30 && y < n.position.y + h(n) + 30 && n.position.y < y + 200,
      )
      if (!hit) break
      x += NODE_W + 40
    }
    return { x: Math.round(x), y: Math.round(y) }
  }

  return {
    graph: emptyGraph(),
    rfNodes: [],
    selection: [],
    contextIds: [],
    pathSet: new Set(),
    view: 'thread',
    structVersion: 0,
    settings: loadSettings(),
    models: [],
    ollama: 'checking',
    draft: '',
    modal: null,
    tab: 'thread',
    inspectorOpen: typeof window === 'undefined' || window.innerWidth > 1000,
    saveState: 'saved',
    dialogue: null,
    lastDialogue: null,
    focusReq: null,
    fitReq: 0,
    composerFocus: 0,
    toast: null,

    setDraft: (draft) => set({ draft }),
    setModal: (modal) => set({ modal }),
    setTab: (tab) => set({ tab, inspectorOpen: true }),
    toggleInspector: () => set((s) => ({ inspectorOpen: !s.inspectorOpen })),

    showToast(text, kind = 'info', action) {
      const id = ++toastSeq
      set({ toast: { id, text, kind, action } })
      // Toasts with an action (Undo) stay up long enough to reach for the button.
      const ms = action ? 8000 : kind === 'error' ? 6000 : 3000
      setTimeout(() => get().toast?.id === id && set({ toast: null }), ms)
    },

    setSettings(p) {
      const prevUrl = get().settings.ollamaUrl
      const settings = { ...get().settings, ...p }
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings))
      set({ settings })
      if (p.ollamaUrl !== undefined && p.ollamaUrl !== prevUrl) void get().refreshModels()
    },

    async refreshModels() {
      try {
        const models = await listModels(get().settings.ollamaUrl)
        const s = get()
        if (JSON.stringify(models) !== JSON.stringify(s.models) || s.ollama !== 'online') set({ models, ollama: 'online' })
        let chosen = s.settings.composerModels.filter((m) => models.some((x) => x.name === m))
        if (!chosen.length && models.length) chosen = [models[0].name]
        if (models.length && chosen.join('|') !== s.settings.composerModels.join('|'))
          get().setSettings({ composerModels: chosen })
      } catch {
        if (get().ollama !== 'offline') set({ ollama: 'offline' })
      }
    },

    loadGraph(g) {
      dialogueCancelled = true
      for (const c of controllers.values()) c.abort()
      controllers.clear()
      set((s) => ({
        graph: g,
        rfNodes: Object.values(g.nodes).map((n) => toRf(n)),
        selection: [],
        contextIds: [],
        pathSet: new Set(),
        structVersion: s.structVersion + 1,
        fitReq: s.fitReq + 1,
        saveState: 'saved',
        dialogue: null,
        draft: '',
      }))
      localStorage.setItem(LAST_KEY, g.id)
    },

    newGraph: () => get().loadGraph(emptyGraph()),
    renameGraph: (title) => set((s) => ({ graph: { ...s.graph, title, updatedAt: Date.now() } })),
    setSystemPrompt: (systemPrompt) => set((s) => ({ graph: { ...s.graph, systemPrompt, updatedAt: Date.now() } })),

    async saveNow() {
      const g = get().graph
      // Only write real changes: a second tab holding an older copy must never overwrite newer work.
      if (get().saveState === 'saved') return
      if (!Object.keys(g.nodes).length && g.title === DEFAULT_TITLE) return
      set({ saveState: 'saving' })
      try {
        await saveGraph(g)
        localStorage.setItem(LAST_KEY, g.id)
        // Only mark clean if nothing changed while we were writing.
        set({ saveState: get().graph === g ? 'saved' : 'unsaved' })
      } catch (e) {
        set({ saveState: 'unsaved' })
        get().showToast(`Could not save: ${e instanceof Error ? e.message : e}`, 'error')
      }
    },

    onNodesChange(changes) {
      const s = get()
      let selection = s.selection
      let selChanged = false
      const dropped: string[] = []
      for (const c of changes) {
        if (c.type === 'select') {
          if (c.selected && !selection.includes(c.id)) {
            selection = [...selection, c.id]
            selChanged = true
          } else if (!c.selected && selection.includes(c.id)) {
            selection = selection.filter((x) => x !== c.id)
            selChanged = true
          }
        } else if (c.type === 'position' && c.dragging === false) dropped.push(c.id)
      }
      // Deletion goes through deleteNodes(), never through React Flow.
      const rfNodes = applyNodeChanges(
        changes.filter((c) => c.type !== 'remove'),
        s.rfNodes,
      )
      const next: Partial<State> = { rfNodes }
      if (selChanged) next.selection = selection
      if (dropped.length) {
        const nodes = { ...s.graph.nodes }
        for (const id of dropped) {
          const rf = rfNodes.find((n) => n.id === id)
          if (rf && nodes[id]) nodes[id] = { ...nodes[id], position: { x: Math.round(rf.position.x), y: Math.round(rf.position.y) } }
        }
        next.graph = { ...s.graph, nodes, updatedAt: Date.now() }
      }
      set(next)
    },

    select(ids) {
      const s = get()
      const want = new Set(ids)
      set({
        selection: ids,
        rfNodes: s.rfNodes.map((n) => (!!n.selected === want.has(n.id) ? n : { ...n, selected: want.has(n.id) })),
      })
    },

    setView: (view) => set({ view }),

    adoptSelection(ids) {
      const next = ids ?? get().selection
      set((s) => ({ contextIds: next, pathSet: contextNodeSet(s.graph, next) }))
    },

    continueFrom(id) {
      get().select([id])
      get().adoptSelection([id])
      get().focusComposer()
    },

    mergeIntoContext(id) {
      const s = get()
      if (!s.graph.nodes[id] || s.contextIds.includes(id)) return
      const next = [...s.contextIds, id]
      set({ contextIds: next, pathSet: contextNodeSet(s.graph, next) })
      get().showToast('Added to context — the next message merges both branches.')
    },

    moveContext(id, delta) {
      const s = get()
      const i = s.contextIds.indexOf(id)
      const j = i + delta
      if (i < 0 || j < 0 || j >= s.contextIds.length) return
      const next = [...s.contextIds]
      ;[next[i], next[j]] = [next[j], next[i]]
      set({ contextIds: next, pathSet: contextNodeSet(s.graph, next) })
    },

    openReceipt(id) {
      get().select([id])
      set({ tab: 'receipt', inspectorOpen: true })
    },

    focus: (id) => set((s) => ({ focusReq: { id, n: (s.focusReq?.n ?? 0) + 1 } })),
    focusComposer: () => set((s) => ({ composerFocus: s.composerFocus + 1 })),
    requestFit: () => set((s) => ({ fitReq: s.fitReq + 1 })),

    tidy() {
      const s = get()
      const pos = tidyPositions(s.graph, s.rfNodes, NODE_W)
      const nodes = { ...s.graph.nodes }
      for (const [id, p] of Object.entries(pos)) if (nodes[id]) nodes[id] = { ...nodes[id], position: p }
      set({
        graph: { ...s.graph, nodes, updatedAt: Date.now() },
        rfNodes: s.rfNodes.map((n) => (pos[n.id] ? { ...n, position: pos[n.id] } : n)),
        fitReq: s.fitReq + 1,
      })
    },

    addNode(p) {
      const id = uid()
      const node: GNode = {
        id,
        parents: p.parents,
        kind: p.kind ?? 'chat',
        status: 'pending',
        position: placeNode(p.parents),
        createdAt: Date.now(),
      }
      if (p.prompt !== undefined) node.prompt = p.prompt
      if (p.model !== undefined) node.model = p.model
      if (p.agent !== undefined) node.agent = p.agent
      if (p.peers !== undefined) node.peers = p.peers
      set((s) => {
        const first = !Object.keys(s.graph.nodes).length
        const title = first && s.graph.title === DEFAULT_TITLE && p.prompt ? snippet(p.prompt, 48) : s.graph.title
        return {
          graph: { ...s.graph, title, nodes: { ...s.graph.nodes, [id]: node }, updatedAt: Date.now() },
          rfNodes: [...s.rfNodes, toRf(node)],
          structVersion: s.structVersion + 1,
        }
      })
      return id
    },

    send() {
      const s = get()
      const text = s.draft.trim()
      if (!text) return
      const models = s.settings.composerModels.filter((m) => s.models.some((x) => x.name === m))
      if (!models.length) {
        get().showToast('Pick at least one installed model first.', 'error')
        return
      }
      const parents = [...s.contextIds]
      // Several models selected = fan-out: one sibling branch per model.
      const ids = models.map((model) => get().addNode({ parents, prompt: text, model }))
      set({ draft: '' })
      get().select([ids[0]])
      get().adoptSelection([ids[0]])
      get().focus(ids[0])
      for (const id of ids) void get().generate(id)
    },

    async generate(id) {
      const s = get()
      const n = s.graph.nodes[id]
      if (!n) return
      if (!n.model) {
        patch(id, { status: 'error', error: 'No model chosen for this node.' })
        return
      }
      controllers.get(id)?.abort()
      const ctrl = new AbortController()
      controllers.set(id, ctrl)
      const compiled = compileFor(s.graph, id)
      const messages = compiled.messages
      patch(id, {
        status: 'streaming',
        response: '',
        thinking: undefined,
        error: undefined,
        stats: undefined,
        stale: false,
        receipt: {
          messages,
          nodeIds: compiled.nodeIds,
          excluded: auditExcluded(s.graph, id),
          at: Date.now(),
        },
      })

      let raw = ''
      let thinking = ''
      let timer: ReturnType<typeof setTimeout> | null = null
      // Batch tokens into ~20 updates/s; per-token state updates would thrash React.
      const flush = () => {
        timer = null
        const sp = splitThink(raw)
        const think = [thinking.trim(), sp.thinking].filter(Boolean).join('\n\n')
        patch(id, { response: stripSelfPrefix(sp.answer, n.agent?.name), thinking: think || undefined })
      }
      const t0 = performance.now()
      try {
        const stats = await streamChat({
          base: s.settings.ollamaUrl,
          model: n.model,
          messages,
          temperature: s.settings.temperature,
          numCtx: s.settings.numCtx,
          think: s.settings.think === 'off' ? false : undefined,
          signal: ctrl.signal,
          onDelta: (d) => {
            raw += d.content ?? ''
            thinking += d.thinking ?? ''
            if (!timer) timer = setTimeout(flush, 50)
          },
        })
        if (timer) clearTimeout(timer)
        flush()
        patch(id, { status: 'done', stats: { ...stats, ms: stats.ms ?? performance.now() - t0 } })
      } catch (e) {
        if (timer) clearTimeout(timer)
        flush()
        if (ctrl.signal.aborted) patch(id, { status: 'done', error: 'Stopped early' })
        else patch(id, { status: 'error', error: e instanceof Error ? e.message : String(e) })
      } finally {
        if (controllers.get(id) === ctrl) controllers.delete(id)
        if (get().graph.nodes[id]?.kind === 'summary') refreshPath()
      }
    },

    stop: (id) => controllers.get(id)?.abort(),
    stopAll() {
      dialogueCancelled = true
      for (const c of controllers.values()) c.abort()
    },

    regenerate(id) {
      markStale(descendantsOf(get().graph, id))
      void get().generate(id)
    },

    toggleMute(id) {
      const n = get().graph.nodes[id]
      if (!n) return
      patch(id, { muted: !n.muted })
      markStale(descendantsOf(get().graph, id))
      set((s) => ({ structVersion: s.structVersion + 1 }))
      refreshPath()
    },

    summarize(id) {
      const s = get()
      const src = s.graph.nodes[id]
      if (!src) return
      const model = s.settings.composerModels.find((m) => s.models.some((x) => x.name === m)) ?? src.model
      const nid = get().addNode({ parents: [id], kind: 'summary', model })
      get().select([nid])
      get().adoptSelection([nid])
      get().focus(nid)
      void get().generate(nid)
    },

    editAndBranch(id) {
      const n = get().graph.nodes[id]
      if (!n) return
      get().select(n.parents)
      get().adoptSelection(n.parents)
      set({ draft: n.prompt ?? '' })
      get().focusComposer()
      get().showToast('Edit the prompt: sending creates a sibling branch, the original stays.')
    },

    deleteNodes(ids) {
      const s = get()
      const kill = deletionClosure(s.graph, ids.filter((id) => s.graph.nodes[id]))
      if (!kill.size) return null
      for (const id of kill) controllers.get(id)?.abort()
      const nodes: Record<string, GNode> = {}
      const patched: GNode[] = []
      for (const [id, n] of Object.entries(s.graph.nodes)) {
        if (kill.has(id)) continue
        if (n.parents.some((p) => kill.has(p))) {
          // A merge that lost one parent survives, but its context changed.
          patched.push(n)
          nodes[id] = { ...n, parents: n.parents.filter((p) => !kill.has(p)), stale: !!n.response }
        } else nodes[id] = n
      }
      const graph = { ...s.graph, nodes, updatedAt: Date.now() }
      const selection = s.selection.filter((x) => !kill.has(x))
      const contextIds = s.contextIds.filter((x) => !kill.has(x))
      set({
        graph,
        rfNodes: s.rfNodes.filter((n) => !kill.has(n.id)),
        selection,
        contextIds,
        pathSet: contextNodeSet(graph, contextIds),
        structVersion: s.structVersion + 1,
      })
      return {
        graphId: s.graph.id,
        removed: [...kill].map((id) => s.graph.nodes[id]),
        rf: s.rfNodes.filter((n) => kill.has(n.id)),
        patched,
      }
    },

    restoreDeleted(snap) {
      const s = get()
      if (s.graph.id !== snap.graphId) return false // a different graph is open now
      const nodes = { ...s.graph.nodes }
      for (const n of snap.removed) {
        // A reply that was streaming when deleted was aborted; don't bring it back "spinning".
        const busy = n.status === 'streaming' || n.status === 'pending'
        nodes[n.id] = busy ? { ...n, status: n.response ? 'done' : 'error', error: 'Stopped: deleted mid-reply' } : n
      }
      for (const orig of snap.patched) {
        const cur = nodes[orig.id]
        if (cur) nodes[orig.id] = { ...cur, parents: orig.parents, stale: orig.stale }
      }
      const graph = { ...s.graph, nodes, updatedAt: Date.now() }
      const present = new Set(s.rfNodes.map((n) => n.id))
      set({
        graph,
        rfNodes: [...s.rfNodes, ...snap.rf.filter((n) => !present.has(n.id)).map((n) => ({ ...n, selected: false }))],
        pathSet: contextNodeSet(graph, s.contextIds),
        structVersion: s.structVersion + 1,
      })
      return true
    },

    async runDialogue(cfg) {
      if (get().dialogue) return
      dialogueCancelled = false
      set({ dialogue: { turn: 0, total: cfg.turns }, lastDialogue: cfg, modal: null })
      const s = get()
      let parents = [...s.contextIds]
      const names = cfg.agents.map((a) => a.name)
      // Continuing an existing dialogue: whoever spoke last doesn't go first.
      const last = parents.length === 1 ? s.graph.nodes[parents[0]]?.agent?.name : undefined
      const start = last ? (names.indexOf(last) + 1) % names.length : 0
      try {
        for (let i = 0; i < cfg.turns && !dialogueCancelled; i++) {
          const agent = cfg.agents[(start + i) % cfg.agents.length]
          const prompt = i === 0 && cfg.topic.trim() ? cfg.topic.trim() : undefined
          const id = get().addNode({
            parents,
            prompt,
            model: agent.model,
            agent,
            peers: names.filter((x) => x !== agent.name),
          })
          set({ dialogue: { turn: i + 1, total: cfg.turns } })
          get().select([id])
          get().adoptSelection([id])
          get().focus(id)
          await get().generate(id)
          const after = get().graph.nodes[id]
          if (!after || after.status === 'error') break
          parents = [id]
        }
      } finally {
        set({ dialogue: null })
      }
    },
  }
})

// Dev only: hot-swapping this module would orphan the autosave subscription and
// polling timers that captured the old store, so flush a save and fully reload
// instead (the reload reopens the last graph from IndexedDB).
if (import.meta.env.DEV) Object.assign(window, { arbor: useStore }) // console debugging: arbor.getState()

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    void useStore.getState().saveNow()
  })
  import.meta.hot.accept(() => setTimeout(() => window.location.reload(), 150))
}

/**
 * Delete now, offer Undo — shared by the node button, the inspector and the Delete key.
 * No window.confirm(): embedded browsers (such as the Claude app's pane) suppress native
 * dialogs and silently answer "Cancel", which made delete look broken.
 */
export function deleteWithUndo(ids: string[]) {
  const s = useStore.getState()
  const snap = s.deleteNodes(ids)
  if (!snap) return
  const n = snap.removed.length
  const extra = n - ids.length
  s.showToast(
    `Deleted ${n} node${n === 1 ? '' : 's'}` +
      (extra > 0 ? ` (${extra} descendant${extra === 1 ? '' : 's'} with no other parent)` : ''),
    'info',
    {
      label: 'Undo',
      run: () => {
        if (useStore.getState().restoreDeleted(snap)) useStore.getState().showToast('Restored')
      },
    },
  )
}
