import { useState, type CSSProperties } from 'react'
import { Brain, GitMerge, Layers, ReceiptText } from 'lucide-react'
import { useStore } from '../store'
import { fmtTokens, modelColor, shortModel } from '../lib/util'
import type { Turn } from '../types'
import { Markdown } from './Markdown'

const st = useStore.getState

/** One turn of a thread, shared by the reading pane and the side panel. */
export function TurnView({ t }: { t: Turn }) {
  const node = useStore((s) => (t.nodeId ? s.graph.nodes[t.nodeId] : undefined))
  const [open, setOpen] = useState(false)
  const go = () => {
    if (node) {
      st().select([node.id])
      st().focus(node.id)
    }
  }

  if (t.kind === 'merge')
    return (
      <div className="turn card merge-card">
        <button className="card-head" onClick={() => setOpen((o) => !o)}>
          <GitMerge size={13} /> Merged branches{' '}
          <span className="muted-text">{open ? 'hide' : 'show what the model reads'}</span>
        </button>
        {open && <pre className="raw">{t.text}</pre>}
      </div>
    )

  if (t.kind === 'summary')
    return (
      <div className="turn card summary-card" onClick={go}>
        <div className="card-head">
          <Layers size={13} /> Checkpoint: everything above it is replaced by this summary
        </div>
        <Markdown text={t.text.replace(/^Summary of the earlier conversation:\s*/, '')} />
      </div>
    )

  if (t.role === 'user')
    return (
      <div className="turn user" onClick={go}>
        <div className="bubble">{t.text}</div>
      </div>
    )

  const receipt = node?.receipt
  const measured = node?.stats?.promptTokens

  return (
    <div className="turn bot" onClick={go}>
      <div className="who">
        {node?.agent && (
          <span className="agent-pill" style={{ '--c': node.agent.color } as CSSProperties}>
            {node.agent.name}
          </span>
        )}
        <span className="model-chip" style={{ '--model': modelColor(t.model) } as CSSProperties}>
          <span className="dot" />
          {shortModel(t.model)}
        </span>
        {node?.stale && <span className="tag tag-stale">stale</span>}
      </div>
      {node?.thinking && (
        <details className="think" onClick={(e) => e.stopPropagation()}>
          <summary>
            <Brain size={12} /> Reasoning
          </summary>
          <pre>{node.thinking}</pre>
        </details>
      )}
      <div className="bubble">
        <Markdown text={t.text} />
      </div>
      {receipt && node && (
        <button
          className="receipt-line"
          onClick={(e) => {
            e.stopPropagation()
            st().openReceipt(node.id)
          }}
          title="Open the receipt: the exact messages and nodes this answer was generated from"
        >
          <ReceiptText size={12} />
          {receipt.nodeIds.length === 0
            ? 'Receipt: no earlier nodes'
            : `Receipt: ${receipt.nodeIds.length} node${receipt.nodeIds.length === 1 ? '' : 's'}`}
          {measured ? <> · {fmtTokens(measured)} tokens read</> : null}
          {node.stats?.cachedTokens ? <> · {fmtTokens(node.stats.cachedTokens)} cached</> : null}
        </button>
      )}
    </div>
  )
}
