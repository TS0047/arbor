import { memo, type CSSProperties, type MouseEvent, type ReactNode } from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import { Brain, Eye, EyeOff, GitBranch, GitMerge, Layers, LoaderCircle, RotateCcw, Square, Trash } from 'lucide-react'
import { deleteWithUndo, useStore } from '../store'
import { branchLabel } from '../lib/context'
import { cx, fmtTokens, modelColor, shortModel } from '../lib/util'
import { Markdown } from './Markdown'

const st = useStore.getState

function IconBtn(props: { title: string; onClick: () => void; children: ReactNode; danger?: boolean }) {
  const click = (e: MouseEvent) => {
    e.stopPropagation()
    props.onClick()
  }
  return (
    <button className={cx('icon-btn', props.danger && 'danger')} title={props.title} onClick={click}>
      {props.children}
    </button>
  )
}

function ChatNodeImpl({ id, selected }: NodeProps) {
  const n = useStore((s) => s.graph.nodes[id])
  const inPath = useStore((s) => s.pathSet.has(id))
  const dim = useStore((s) => s.contextIds.length > 0 && !s.pathSet.has(id))
  const inContext = useStore((s) => s.contextIds.includes(id))
  const mergeIdx = useStore((s) => (s.selection.length > 1 ? s.selection.indexOf(id) : -1))
  if (!n) return null

  const busy = n.status === 'streaming' || n.status === 'pending'
  const isSummary = n.kind === 'summary'
  const isMerge = n.parents.length > 1
  const long = (n.response?.length ?? 0) > 650
  const thinkingOnly = busy && !n.response && !!n.thinking

  return (
    <div
      className={cx(
        'gnode',
        selected && 'is-selected',
        inPath && 'in-path',
        dim && 'is-dim',
        n.muted && 'is-muted',
        busy && 'is-busy',
        isSummary && 'is-summary',
        n.status === 'error' && 'is-error',
      )}
      style={{ '--model': modelColor(n.model), '--agent': n.agent?.color ?? 'transparent' } as CSSProperties}
    >
      <Handle type="target" position={Position.Top} isConnectable={false} />
      {mergeIdx >= 0 && <div className="merge-letter">{branchLabel(mergeIdx)}</div>}

      <header className="gnode-head">
        {n.agent && (
          <span className="agent-pill" style={{ '--c': n.agent.color } as CSSProperties}>
            {n.agent.name}
          </span>
        )}
        <span className="model-chip" title={n.model}>
          <span className="dot" />
          {shortModel(n.model)}
        </span>
        {isSummary && (
          <span className="tag tag-summary">
            <Layers size={11} /> checkpoint
          </span>
        )}
        {isMerge && (
          <span className="tag tag-merge">
            <GitMerge size={11} /> merge ×{n.parents.length}
          </span>
        )}
        {n.muted && <span className="tag">muted</span>}
        {inContext && (
          <span className="tag tag-target" title="The next message continues from here">
            target
          </span>
        )}
        {n.stale && (
          <span className="tag tag-stale" title="Something upstream changed after this reply was generated">
            stale
          </span>
        )}
        <span className="grow" />
        {busy ? (
          <LoaderCircle className="spin" size={14} />
        ) : n.stats?.outputTokens ? (
          <span
            className="tok"
            title={
              `${n.stats.promptTokens ?? '?'} tokens read` +
              (n.stats.cachedTokens ? ` (${n.stats.cachedTokens} reused from Ollama's cache: shared prefix)` : '') +
              ` · ${n.stats.outputTokens} written` +
              (n.stats.ms ? ` · ${(n.stats.ms / 1000).toFixed(1)}s` : '')
            }
          >
            {!!n.stats.cachedTokens && <span className="cached">⚡{fmtTokens(n.stats.cachedTokens)}/</span>}
            {fmtTokens(n.stats.promptTokens ?? 0)} → {fmtTokens(n.stats.outputTokens)}
          </span>
        ) : null}
      </header>

      {n.prompt && <div className="gnode-prompt">{n.prompt}</div>}

      <div className={cx('gnode-body', long && 'is-long')}>
        {thinkingOnly ? (
          <div className="thinking-live">
            <Brain size={12} /> thinking… <span>{n.thinking!.slice(-160)}</span>
          </div>
        ) : n.response ? (
          <Markdown text={n.response} />
        ) : busy ? (
          isSummary ? (
            <span className="muted-text">Condensing the thread above…</span>
          ) : (
            <span className="typing">
              <i />
              <i />
              <i />
            </span>
          )
        ) : null}
        {n.thinking && !thinkingOnly && (
          <div className="think-chip">
            <Brain size={11} /> reasoned first
          </div>
        )}
        {n.error && <div className={cx('gnode-error', n.status !== 'error' && 'soft')}>{n.error}</div>}
      </div>

      <footer className="gnode-actions nodrag">
        <IconBtn title="Read this node and continue from it" onClick={() => st().continueFrom(id)}>
          <GitBranch size={14} />
        </IconBtn>
        {busy ? (
          <IconBtn title="Stop generating" onClick={() => st().stop(id)}>
            <Square size={13} />
          </IconBtn>
        ) : (
          <IconBtn title="Regenerate this reply" onClick={() => st().regenerate(id)}>
            <RotateCcw size={14} />
          </IconBtn>
        )}
        <IconBtn title={n.muted ? 'Unmute (include in context again)' : 'Mute (keep it, but skip it in context)'} onClick={() => st().toggleMute(id)}>
          {n.muted ? <Eye size={14} /> : <EyeOff size={14} />}
        </IconBtn>
        {!isSummary && (
          <IconBtn title="Summarize everything up to here into a checkpoint" onClick={() => st().summarize(id)}>
            <Layers size={14} />
          </IconBtn>
        )}
        <span className="grow" />
        <IconBtn title="Delete (Undo available)" danger onClick={() => deleteWithUndo([id])}>
          <Trash size={14} />
        </IconBtn>
      </footer>
      <Handle type="source" position={Position.Bottom} isConnectable={false} />
    </div>
  )
}

export const ChatNode = memo(ChatNodeImpl)
