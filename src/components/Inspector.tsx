import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import {
  CornerDownRight,
  Copy,
  Eye,
  EyeOff,
  GitMerge,
  Layers,
  MessagesSquare,
  Pencil,
  Plus,
  ReceiptText,
  RotateCcw,
  Search,
  Trash,
} from 'lucide-react'
import { deleteWithUndo, useStore, type Tab } from '../store'
import {
  EXCLUSION_HINT,
  EXCLUSION_LABEL,
  childrenMap,
  compileFor,
  contextAudit,
  contextFor,
  estimateTokens,
  previewFor,
  transcriptOf,
} from '../lib/context'
import { cx, fmtTokens, modelColor, shortModel, snippet, timeAgo } from '../lib/util'
import type { ExclusionReason } from '../types'
import { TurnView } from './TurnView'

const st = useStore.getState

function ThreadTab() {
  const graph = useStore((s) => s.graph)
  const selection = useStore((s) => s.selection)
  const contextIds = useStore((s) => s.contextIds)
  const endRef = useRef<HTMLDivElement>(null)
  const target = selection[0] ?? contextIds[contextIds.length - 1]
  const turns = useMemo(() => {
    if (!target) return []
    return selection.length > 1 ? contextFor(graph, selection) : transcriptOf(graph, target)
  }, [graph, selection, target])
  const sel = selection.length === 1 ? graph.nodes[selection[0]] : undefined

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' })
  }, [selection])

  if (!target)
    return (
      <div className="panel-empty">
        <p>Nothing selected yet.</p>
        <p className="muted-text">
          Click a node to read its thread. The highlighted path is only what you continue from — reading never changes
          the context.
        </p>
      </div>
    )

  return (
    <div className="thread">
      {selection.length > 1 && (
        <div className="hint-box">
          <GitMerge size={14} /> Preview of a merge. These branches are only sent if you press “Use these” in the
          composer.
        </div>
      )}
      {turns.length === 0 && <div className="panel-empty muted-text">Nothing in context yet.</div>}
      {turns.map((t) => (
        <TurnView key={t.key} t={t} />
      ))}
      {sel?.muted && (
        <div className="hint-box">This node is muted: it stays on the canvas but is skipped in every context.</div>
      )}
      {sel?.status === 'streaming' && !sel.response && (
        <div className="typing">
          <i />
          <i />
          <i />
        </div>
      )}
      <div ref={endRef} />
    </div>
  )
}

const REASON_CLASS: Record<ExclusionReason, string> = {
  muted: 'muted',
  checkpointed: 'checkpointed',
  later: 'later',
  empty: 'empty',
  branch: 'branch',
}

/**
 * The receipt: a truthful account of one request. "This answer" is a stored
 * snapshot (what the model actually saw); "Next request" is a live preview.
 */
function ReceiptTab() {
  const graph = useStore((s) => s.graph)
  const selection = useStore((s) => s.selection)
  const contextIds = useStore((s) => s.contextIds)
  const draft = useStore((s) => s.draft)
  const numCtx = useStore((s) => s.settings.numCtx)
  const node = selection.length === 1 ? graph.nodes[selection[0]] : undefined
  const [mode, setMode] = useState<'sent' | 'next'>(node?.receipt ? 'sent' : 'next')
  const [q, setQ] = useState('')
  const [showMessages, setShowMessages] = useState(false)

  useEffect(() => {
    setMode(node?.receipt ? 'sent' : 'next')
    setQ('')
    setShowMessages(false)
  }, [node?.id, node?.receipt])

  const nextAudit = useMemo(() => contextAudit(graph, contextIds), [graph, contextIds])
  const nextMessages = useMemo(() => previewFor(graph, contextIds, draft), [graph, contextIds, draft])
  const currentIds = useMemo(() => (node ? compileFor(graph, node.id).nodeIds : []), [graph, node])

  const sent = mode === 'sent' && node?.receipt ? node.receipt : null
  const messages = sent ? sent.messages : nextMessages
  const nodeIds = sent ? sent.nodeIds : nextAudit.included
  const excluded = sent ? sent.excluded : nextAudit.excluded
  const measured = sent ? node?.stats?.promptTokens : undefined
  const tokens = measured ?? estimateTokens(messages)
  const changed = sent ? currentIds.join('|') !== sent.nodeIds.join('|') : false

  const needle = q.trim().toLowerCase()
  const shown = needle
    ? excluded.filter((e) => {
        const n = graph.nodes[e.id]
        return `${n?.prompt ?? ''} ${n?.response ?? ''} ${n?.model ?? ''} ${n?.kind ?? ''}`.toLowerCase().includes(needle)
      })
    : excluded

  return (
    <div className="receipt-tab">
      <div className="seg receipt-seg">
        <button
          className={cx(mode === 'sent' && 'on')}
          disabled={!node?.receipt}
          onClick={() => setMode('sent')}
          title={node?.receipt ? 'The stored snapshot of this answer' : 'This node has no receipt yet'}
        >
          This answer
        </button>
        <button className={cx(mode === 'next' && 'on')} onClick={() => setMode('next')}>
          Next request
        </button>
      </div>

      <div className="receipt-summary">
        <div className="receipt-summary-head">
          <ReceiptText size={14} />
          <b>{sent ? 'What this answer saw' : 'What the next message will see'}</b>
        </div>
        <div className="receipt-numbers">
          <span>{nodeIds.length} nodes</span>
          <span>
            {measured !== undefined ? `${fmtTokens(measured)} tokens read` : `≈${fmtTokens(tokens)} tokens`}
            <em>{measured !== undefined ? ' measured by Ollama' : ' estimated'}</em>
          </span>
          <span>{messages.length} messages</span>
          {sent && <span>{timeAgo(sent.at)}</span>}
        </div>
        <div className="bar big">
          <span style={{ width: `${Math.min(100, (tokens / numCtx) * 100)}%` }} className={cx(tokens > numCtx && 'over')} />
        </div>
        {tokens > numCtx && (
          <p className="warn-text">
            Larger than the context window ({fmtTokens(numCtx)}), so Ollama will silently drop the oldest messages. Add
            a checkpoint or raise the window in Settings.
          </p>
        )}
        {sent && changed && (
          <p className="warn-text">
            The graph changed after this answer. The list below is still the stored snapshot — switch to “Next request”
            to see what would be sent now.
          </p>
        )}
        {!sent && (
          <p className="muted-text">
            Exactly what pressing Send would send{draft.trim() ? ' (including your draft)' : ''}. Node counts are
            read from the same compiler the composer uses.
          </p>
        )}
      </div>

      <div className="receipt-section">
        <h4>In context ({nodeIds.length})</h4>
        {nodeIds.length === 0 && <p className="muted-text">Nothing yet — this is a new root.</p>}
        {nodeIds.map((id) => {
          const n = graph.nodes[id]
          if (!n) return null
          return (
            <button key={id} className="receipt-row" onClick={() => st().focus(id)}>
              <span className={cx('kind-dot', n.kind)} />
              <span className="receipt-row-text">
                <b>{n.kind === 'summary' ? 'Checkpoint' : n.parents.length > 1 ? 'Merge' : 'Turn'}</b>{' '}
                {snippet(n.prompt || n.response || 'empty', 58)}
              </span>
              <span className="receipt-row-meta">{n.model ? shortModel(n.model) : ''}</span>
            </button>
          )
        })}
      </div>

      <div className="receipt-section">
        <h4>
          Not in context ({excluded.length})
          <label className="receipt-search">
            <Search size={12} />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Why wasn’t X included?" />
          </label>
        </h4>
        {excluded.length === 0 && <p className="muted-text">Everything in this graph is in the request.</p>}
        {shown.length === 0 && excluded.length > 0 && <p className="muted-text">No node matches “{q}”.</p>}
        {shown.map((e) => {
          const n = graph.nodes[e.id]
          if (!n) return null
          return (
            <div key={e.id} className={cx('excl-row', REASON_CLASS[e.reason])}>
              <button className="excl-main" onClick={() => st().focus(e.id)} title={EXCLUSION_HINT[e.reason]}>
                <span className="excl-reason">{EXCLUSION_LABEL[e.reason]}</span>
                <span className="excl-text">{snippet(n.prompt || n.response || 'empty node', 52)}</span>
              </button>
              <span className="excl-hint">{EXCLUSION_HINT[e.reason]}</span>
              {e.reason === 'branch' && (
                <button
                  className="icon-btn"
                  title="Add to the send target so the next message merges it in"
                  onClick={() => st().mergeIntoContext(e.id)}
                >
                  <Plus size={13} />
                </button>
              )}
            </div>
          )
        })}
      </div>

      <div className="receipt-section">
        <button className="receipt-messages-toggle" onClick={() => setShowMessages((v) => !v)}>
          {showMessages ? 'Hide' : 'Show'} the exact messages ({messages.length})
        </button>
        {showMessages &&
          messages.map((m, i) => (
            <div key={i} className={cx('msg', m.role)}>
              <div className="msg-role">
                {m.role}
                <span>≈{fmtTokens(Math.ceil(m.content.length / 4))} tok</span>
              </div>
              <pre>{m.content}</pre>
            </div>
          ))}
      </div>
    </div>
  )
}

function NodeTab() {
  const selection = useStore((s) => s.selection)
  const graph = useStore((s) => s.graph)
  const lastDialogue = useStore((s) => s.lastDialogue)
  const n = selection.length === 1 ? graph.nodes[selection[0]] : undefined
  const inContext = useStore((s) => (s.selection.length === 1 ? s.contextIds.includes(s.selection[0]) : false))
  const kids = useMemo(() => (n ? (childrenMap(graph).get(n.id) ?? []).length : 0), [graph, n])
  if (!n) return <div className="panel-empty muted-text">Select a single node to see its details and actions.</div>

  const busy = n.status === 'streaming' || n.status === 'pending'
  const tps = n.stats?.outputTokens && n.stats.ms ? (n.stats.outputTokens / (n.stats.ms / 1000)).toFixed(1) : null
  const row = (k: string, v: ReactNode) => (
    <div className="kv">
      <span>{k}</span>
      <span>{v}</span>
    </div>
  )

  return (
    <div className="node-tab">
      <div className="kv-list">
        {row(
          'Kind',
          n.kind === 'summary'
            ? 'Checkpoint (summary)'
            : n.parents.length > 1
              ? `Merge of ${n.parents.length} branches`
              : n.parents.length
                ? 'Continuation'
                : 'Root',
        )}
        {row(
          'Model',
          <span className="model-chip" style={{ '--model': modelColor(n.model) } as CSSProperties}>
            <span className="dot" />
            {shortModel(n.model)}
          </span>,
        )}
        {n.agent && row('Speaker', <span className="agent-pill" style={{ '--c': n.agent.color } as CSSProperties}>{n.agent.name}</span>)}
        {row('Status', n.status + (n.stale ? ' · stale' : '') + (n.muted ? ' · muted' : ''))}
        {row('In next request', inContext ? 'yes — continue/merge target' : 'no')}
        {n.stats?.promptTokens !== undefined &&
          row('Tokens read', fmtTokens(n.stats.promptTokens) + (n.stats.cachedTokens ? ` (${fmtTokens(n.stats.cachedTokens)} from cache)` : ''))}
        {n.stats?.outputTokens !== undefined && row('Tokens written', fmtTokens(n.stats.outputTokens))}
        {n.stats?.ms !== undefined && row('Time', `${(n.stats.ms / 1000).toFixed(1)} s${tps ? ` · ${tps} tok/s` : ''}`)}
        {n.receipt && row('Receipt', `${n.receipt.nodeIds.length} nodes · ${timeAgo(n.receipt.at)}`)}
        {row('Children', kids)}
        {row('Created', timeAgo(n.createdAt))}
      </div>
      {n.agent?.persona && (
        <div className="persona">
          <b>{n.agent.name}'s brief</b>
          <p>{n.agent.persona}</p>
        </div>
      )}
      {n.error && <div className="gnode-error">{n.error}</div>}

      <div className="action-grid">
        <button className="btn primary" onClick={() => st().continueFrom(n.id)}>
          <CornerDownRight size={14} /> Continue from this node
        </button>
        <button className="btn" disabled={busy} onClick={() => st().regenerate(n.id)}>
          <RotateCcw size={14} /> Regenerate
        </button>
        {n.prompt !== undefined && (
          <button className="btn" onClick={() => st().editAndBranch(n.id)}>
            <Pencil size={14} /> Edit as new branch
          </button>
        )}
        <button className="btn" onClick={() => st().toggleMute(n.id)}>
          {n.muted ? <Eye size={14} /> : <EyeOff size={14} />} {n.muted ? 'Unmute' : 'Mute in context'}
        </button>
        {n.kind !== 'summary' && (
          <button className="btn" onClick={() => st().summarize(n.id)}>
            <Layers size={14} /> Checkpoint here
          </button>
        )}
        {(n.agent || lastDialogue) && (
          <button className="btn" onClick={() => st().setModal('dialogue')}>
            <MessagesSquare size={14} /> Continue dialogue
          </button>
        )}
        <button
          className="btn"
          disabled={!n.response}
          onClick={() => {
            void navigator.clipboard.writeText(n.response ?? '')
            st().showToast('Reply copied')
          }}
        >
          <Copy size={14} /> Copy reply
        </button>
        <button className="btn danger" onClick={() => deleteWithUndo([n.id])}>
          <Trash size={14} /> Delete
        </button>
      </div>
    </div>
  )
}

const TABS: { id: Tab; label: string }[] = [
  { id: 'thread', label: 'Thread' },
  { id: 'receipt', label: 'Receipt' },
  { id: 'node', label: 'Node' },
]

export function Inspector() {
  const tab = useStore((s) => s.tab)
  const setTab = useStore((s) => s.setTab)
  return (
    <aside className="inspector">
      <nav className="tabs">
        {TABS.map((t) => (
          <button key={t.id} className={cx('tab', tab === t.id && 'on')} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </nav>
      <div className="inspector-body">
        {tab === 'thread' && <ThreadTab />}
        {tab === 'receipt' && <ReceiptTab />}
        {tab === 'node' && <NodeTab />}
      </div>
    </aside>
  )
}
