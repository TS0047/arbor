import { useEffect, useMemo, useRef } from 'react'
import { FileUp, GitBranch, Network, ReceiptText } from 'lucide-react'
import { useStore } from '../store'
import { contextFor, transcriptOf } from '../lib/context'
import { snippet } from '../lib/util'
import { importGraphFlow } from './TopBar'
import { TurnView } from './TurnView'

const st = useStore.getState

/**
 * The reading surface. Thread first, graph second: this is where a user
 * actually reads and continues a conversation.
 */
export function ThreadPane() {
  const graph = useStore((s) => s.graph)
  const selection = useStore((s) => s.selection)
  const contextIds = useStore((s) => s.contextIds)
  const draft = useStore((s) => s.draft)
  const endRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  const target = selection[0] ?? contextIds[contextIds.length - 1]
  const turns = useMemo(() => {
    if (!target) return []
    return selection.length > 1 ? contextFor(graph, selection) : transcriptOf(graph, target)
  }, [graph, selection, target])

  const node = target ? graph.nodes[target] : undefined
  const nodeCount = Object.keys(graph.nodes).length

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' })
  }, [target, selection.length])

  // Keep the view pinned only when the user is already at the bottom.
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 160
    if (nearBottom) endRef.current?.scrollIntoView({ block: 'end' })
  }, [node?.response, node?.thinking])

  if (!nodeCount)
    return (
      <div className="thread-pane">
        <div className="thread-empty">
          <h2>Conversations are a graph. Reading them is a thread.</h2>
          <p>
            Type below to start. Every exchange becomes a node, and the highlighted path is exactly what the model
            reads. Click any node to read it — reading never changes what you send.
          </p>
          <ul>
            <li>
              <GitBranch size={15} />
              <span>
                <b>Continue from here</b>: one click sets the send target. Nothing is sent from a click alone.
              </span>
            </li>
            <li>
              <ReceiptText size={15} />
              <span>
                <b>Receipts</b>: every answer records the exact nodes and messages it was generated from.
              </span>
            </li>
            <li>
              <Network size={15} />
              <span>
                <b>Map</b>: the canvas shows the whole graph. Switch any time; it is never the only way to work.
              </span>
            </li>
          </ul>
          <div className="thread-empty-actions">
            <button className="btn" onClick={() => void importGraphFlow()}>
              <FileUp size={14} /> Import a graph
            </button>
            <span className="muted-text">or drop an .arbor.json file anywhere</span>
          </div>
        </div>
      </div>
    )

  return (
    <div className="thread-pane">
      <div className="thread-head">
        <span className="thread-head-label">
          Reading{node ? <> “{snippet(node.prompt || node.response || (node.kind === 'summary' ? 'checkpoint' : 'node'), 44)}”</> : ' the conversation'}
        </span>
        <span className="grow" />
        {selection.length > 1 && <span className="hint-chip">merge preview · {selection.length} branches</span>}
        {node?.status === 'streaming' && <span className="hint-chip live">generating…</span>}
        <button className="btn ghost small" onClick={() => st().setView('canvas')} title="Open the graph map">
          <Network size={14} /> Map
        </button>
      </div>
      <div className="thread-scroll" ref={scrollRef}>
        <div className="thread-inner">
          {turns.map((t) => (
            <TurnView key={t.key} t={t} />
          ))}
          {node?.status === 'streaming' && (
            <div className="turn bot">
              <div className="who">
                <span className="model-chip">
                  <span className="dot" />
                  {node.model ?? 'model'}
                </span>
              </div>
              <div className="bubble typing-line">
                <span className="typing">
                  <i />
                  <i />
                  <i />
                </span>
              </div>
            </div>
          )}
          {!turns.length && !draft && (
            <p className="muted-text empty-thread-hint">
              Nothing here yet. Type below to continue from this point.
            </p>
          )}
          <div ref={endRef} />
        </div>
      </div>
    </div>
  )
}
