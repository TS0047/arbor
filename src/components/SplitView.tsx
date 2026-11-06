import { useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react'
import { ReactFlowProvider } from '@xyflow/react'
import { ArrowLeftRight, MessagesSquare, Network, X } from 'lucide-react'
import { useStore } from '../store'
import { cx } from '../lib/util'
import { Canvas } from './Canvas'
import { ThreadPane } from './ThreadPane'
import { Composer } from './Composer'

const st = useStore.getState

/** Never squeeze a pane below this, whatever the ratio says. */
const MIN_PANE_PX = 300

type PaneId = 'map' | 'thread'

function PaneTabs(props: {
  icon: ReactNode
  label: string
  active: boolean
  closeTitle: string
  onClose: () => void
  actions?: ReactNode
}) {
  return (
    <div className="pane-tabs">
      <div className={cx('pane-tab', props.active && 'active')}>
        {props.icon}
        <span>{props.label}</span>
        <button className="pane-tab-close" onClick={props.onClose} title={props.closeTitle} aria-label={props.closeTitle}>
          <X size={13} />
        </button>
      </div>
      <span className="grow" />
      {props.actions}
    </div>
  )
}

/**
 * Map and Thread side by side, like two VS Code editor groups: each pane has
 * its own tab (× closes that pane), and the divider between them drags.
 * Clicking a node on the map shows its thread on the other side.
 */
export function SplitView() {
  const ratio = useStore((s) => s.splitRatio)
  const swapped = useStore((s) => s.splitSwapped)
  const ref = useRef<HTMLDivElement>(null)
  const [dragging, setDragging] = useState(false)
  const [active, setActive] = useState<PaneId>('thread')

  // The store clamps to 20–80 %; this also keeps each pane at least MIN_PANE_PX wide.
  const fit = (r: number) => {
    const w = ref.current?.clientWidth || 1
    const min = Math.min(0.5, MIN_PANE_PX / w)
    return Math.min(1 - min, Math.max(min, r))
  }

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    setDragging(true)
  }
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!dragging || !ref.current) return
    const r = ref.current.getBoundingClientRect()
    st().setSplitRatio(fit((e.clientX - r.left) / r.width))
  }
  const endDrag = () => {
    if (!dragging) return
    setDragging(false)
    st().setSplitRatio(st().splitRatio, true)
  }
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 0.1 : 0.02
    if (e.key === 'ArrowLeft') st().setSplitRatio(fit(ratio - step), true)
    else if (e.key === 'ArrowRight') st().setSplitRatio(fit(ratio + step), true)
    else if (e.key === 'Home' || e.key === 'Enter') st().setSplitRatio(0.5, true)
    else return
    e.preventDefault()
  }

  const swap = (
    <button className="icon-btn pane-action" onClick={() => st().swapSplit()} title="Swap sides">
      <ArrowLeftRight size={14} />
    </button>
  )

  const map = (
    <section key="map" className="split-pane" onPointerDownCapture={() => setActive('map')}>
      <PaneTabs
        icon={<Network size={13} />}
        label="Map"
        active={active === 'map'}
        closeTitle="Close the map (show the thread only)"
        onClose={() => st().setView('thread')}
        actions={swapped ? undefined : swap}
      />
      <div className="pane-body">
        <ReactFlowProvider>
          <Canvas />
        </ReactFlowProvider>
      </div>
    </section>
  )

  const thread = (
    <section key="thread" className="split-pane" onPointerDownCapture={() => setActive('thread')}>
      <PaneTabs
        icon={<MessagesSquare size={13} />}
        label="Thread"
        active={active === 'thread'}
        closeTitle="Close the thread (show the map only)"
        onClose={() => st().setView('canvas')}
        actions={swapped ? swap : undefined}
      />
      <div className="pane-body">
        <ThreadPane />
        <Composer />
      </div>
    </section>
  )

  const [left, right] = swapped ? [thread, map] : [map, thread]

  return (
    <div
      ref={ref}
      className={cx('split', dragging && 'dragging')}
      style={{ gridTemplateColumns: `minmax(0, ${ratio}fr) 1px minmax(0, ${1 - ratio}fr)` }}
    >
      {[
        left,
        <div
          key="divider"
          className="split-divider"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize the panes"
          aria-valuenow={Math.round(ratio * 100)}
          aria-valuemin={20}
          aria-valuemax={80}
          tabIndex={0}
          title="Drag to resize · double-click to reset"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onLostPointerCapture={endDrag}
          onDoubleClick={() => st().setSplitRatio(0.5, true)}
          onKeyDown={onKeyDown}
        />,
        right,
      ]}
    </div>
  )
}
