import { useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import {
  ArrowDown,
  ArrowUp,
  CornerDownRight,
  Download,
  GitMerge,
  Layers,
  MessagesSquare,
  Sparkles,
  Square,
  X,
} from 'lucide-react'
import { useStore } from '../store'
import { branchLabel, estimateTokens, previewFor } from '../lib/context'
import { cx, fmtTokens, snippet } from '../lib/util'
import { ModelPicker } from './ModelPicker'

const st = useStore.getState

function nodeLabel(nodes: ReturnType<typeof useStore.getState>['graph']['nodes'], id: string) {
  const n = nodes[id]
  return snippet(n?.prompt || n?.response || (n?.kind === 'summary' ? 'checkpoint' : 'node'), 34)
}

/** What the next message will continue from — never what you merely clicked to read. */
function ContextChips() {
  const contextIds = useStore((s) => s.contextIds)
  const nodes = useStore((s) => s.graph.nodes)
  if (!contextIds.length)
    return (
      <span className="ctx-chip root">
        <Sparkles size={13} /> New conversation
      </span>
    )
  if (contextIds.length === 1)
    return (
      <>
        <button className="ctx-chip" onClick={() => st().focus(contextIds[0])} title="Show on the map">
          <CornerDownRight size={13} /> Continue from “{nodeLabel(nodes, contextIds[0])}”
        </button>
        <button className="chip-x" title="Clear the target and start a new root" onClick={() => st().adoptSelection([])}>
          <X size={13} />
        </button>
      </>
    )
  return (
    <>
      <span className="ctx-merge">
        <GitMerge size={13} /> Merge
        {contextIds.map((id, i) => (
          <button key={id} className="ctx-chip merge" onClick={() => st().focus(id)}>
            <b>{branchLabel(i)}</b> {nodeLabel(nodes, id)}
          </button>
        ))}
      </span>
      <button className="chip-x" title="Clear the target and start a new root" onClick={() => st().adoptSelection([])}>
        <X size={13} />
      </button>
    </>
  )
}

/** Explicit merge: peeked nodes become the send target only when you say so. */
function MergeBar() {
  const selection = useStore((s) => s.selection)
  const contextIds = useStore((s) => s.contextIds)
  const nodes = useStore((s) => s.graph.nodes)
  if (selection.length < 2) return null
  if (selection.length === contextIds.length && selection.every((id, i) => contextIds[i] === id)) return null
  return (
    <div className="merge-bar">
      <span className="merge-title">
        <GitMerge size={14} /> Combine {selection.length} branches
      </span>
      {selection.map((id, i) => (
        <span key={id} className="merge-chip">
          <b>{branchLabel(i)}</b>
          <span className="merge-chip-label">{nodeLabel(nodes, id)}</span>
          <button className="icon-btn" title="Move earlier" disabled={i === 0} onClick={() => st().moveContext(id, -1)}>
            <ArrowUp size={12} />
          </button>
          <button
            className="icon-btn"
            title="Move later"
            disabled={i === selection.length - 1}
            onClick={() => st().moveContext(id, 1)}
          >
            <ArrowDown size={12} />
          </button>
          <button
            className="icon-btn"
            title="Remove from the combine"
            onClick={() => st().select(selection.filter((x) => x !== id))}
          >
            <X size={12} />
          </button>
        </span>
      ))}
      <span className="grow" />
      <button
        className="btn primary small"
        onClick={() => {
          st().adoptSelection([...selection])
          st().select([])
        }}
      >
        Use these
      </button>
    </div>
  )
}

export function Composer() {
  const draft = useStore((s) => s.draft)
  const selection = useStore((s) => s.selection)
  const contextIds = useStore((s) => s.contextIds)
  const graph = useStore((s) => s.graph)
  const numCtx = useStore((s) => s.settings.numCtx)
  const chosen = useStore((s) => s.settings.composerModels)
  const models = useStore((s) => s.models)
  const ollama = useStore((s) => s.ollama)
  const ollamaUrl = useStore((s) => s.settings.ollamaUrl)
  const dialogue = useStore((s) => s.dialogue)
  const composerFocus = useStore((s) => s.composerFocus)
  const anyBusy = useStore((s) => Object.values(s.graph.nodes).some((n) => n.status === 'streaming'))
  const ref = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (composerFocus) ref.current?.focus()
  }, [composerFocus])

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 220) + 'px'
  }, [draft])

  const tokens = useMemo(() => estimateTokens(previewFor(graph, contextIds, draft)), [graph, contextIds, draft])
  const live = chosen.filter((m) => models.some((x) => x.name === m))
  // Reading a node doesn't arm a send: if you are looking at something, you must
  // either continue from it or press Esc to start a new root.
  const needsTarget = contextIds.length === 0 && selection.length > 0
  const canSend = !!draft.trim() && live.length > 0 && !needsTarget
  const pct = Math.min(100, (tokens / numCtx) * 100)
  const peek = selection.length === 1 && !contextIds.includes(selection[0]) ? graph.nodes[selection[0]] : undefined

  const placeholder = needsTarget
    ? 'Choose where to continue, or press Esc to start a new root…'
    : !contextIds.length
      ? 'Start a new conversation…'
      : contextIds.length === 1
        ? `Continue from “${nodeLabel(graph.nodes, contextIds[0])}”…`
        : `Ask about branches ${contextIds.map((_, i) => branchLabel(i)).join(' + ')} together…`

  return (
    <div className="composer-dock">
      {ollama === 'offline' && (
        <div className="banner error">
          Can't reach Ollama at <code>{ollamaUrl}</code>. Is it running?
          <button className="btn small" onClick={() => void st().refreshModels()}>
            Retry
          </button>
        </div>
      )}
      {ollama === 'online' && models.length === 0 && (
        <div className="banner">
          Ollama is running but has no models yet.
          <button className="btn small primary" onClick={() => st().setModal('models')}>
            <Download size={13} /> Pull a model
          </button>
        </div>
      )}
      {dialogue && (
        <div className="banner talk">
          <MessagesSquare size={14} /> Models are talking · turn {dialogue.turn} of {dialogue.total}
          <button className="btn small" onClick={() => st().stopAll()}>
            <Square size={12} /> Stop
          </button>
        </div>
      )}

      <MergeBar />

      {needsTarget && (
        <div className="banner target">
          <CornerDownRight size={14} />
          <span className="banner-text">
            Reading “{snippet(peek?.prompt || peek?.response || 'a node', 40)}”. This is read-only until you continue
            from it — <kbd>Esc</kbd> starts a new root.
          </span>
          <button className="btn small primary" onClick={() => st().continueFrom(selection[0])}>
            <CornerDownRight size={13} /> Continue from here
          </button>
        </div>
      )}

      <div className={cx('composer', contextIds.length > 1 && 'is-merge')}>
        <div className="composer-top">
          <ContextChips />
          {peek && contextIds.length > 0 && (
            <button className="peek-chip" onClick={() => st().continueFrom(peek.id)} title="Continue from the node you are reading">
              Reading “{snippet(peek.prompt || peek.response || 'node', 24)}” · continue from this
            </button>
          )}
          <span className="grow" />
          <span
            className={cx('ctx-meter', pct > 100 * 0.85 && 'warn', tokens > numCtx && 'over')}
            title="Estimated tokens the model will read (about 4 characters per token — Ollama reports the measured count after the reply, in the receipt). The bar fills toward the context window set in Settings."
          >
            <span className="bar">
              <span style={{ width: `${pct}%` }} />
            </span>
            est. ≈{fmtTokens(tokens)} / {fmtTokens(numCtx)}
          </span>
        </div>

        <textarea
          ref={ref}
          value={draft}
          rows={1}
          placeholder={placeholder}
          onChange={(e) => st().setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              if (canSend) st().send()
            }
          }}
        />

        <div className="composer-bottom">
          <ModelPicker />
          <button className="btn ghost" onClick={() => st().setModal('dialogue')} disabled={!!dialogue}>
            <MessagesSquare size={14} /> Make them talk
          </button>
          {contextIds.length === 1 && (
            <button className="btn ghost" onClick={() => st().summarize(contextIds[0])} title="Condense this thread into a checkpoint node">
              <Layers size={14} /> Checkpoint
            </button>
          )}
          <span className="grow" />
          {anyBusy && (
            <button className="btn" onClick={() => st().stopAll()} title="Stop all generation">
              <Square size={12} /> Stop
            </button>
          )}
          <button className="btn primary send" disabled={!canSend} onClick={() => st().send()} title="Send (Enter)">
            <ArrowUp size={15} />
            {live.length > 1 ? `Send to ${live.length}` : 'Send'}
          </button>
        </div>
      </div>
    </div>
  )
}
