import { Download, FilePlus, FolderOpen, MessagesSquare, Network, PanelRight, Settings, Upload } from 'lucide-react'
import { useStore } from '../store'
import { downloadGraph, pickGraphFile, saveGraph } from '../lib/persist'
import { cx } from '../lib/util'

const st = useStore.getState

export function Logo() {
  return (
    <svg width="22" height="22" viewBox="0 0 32 32" fill="none" aria-hidden>
      <path d="M16 7v6M16 13l-6 6M16 13l6 6M10 19l6 6M22 19l-6 6" stroke="#7c9cff" strokeWidth="2.2" strokeLinecap="round" />
      <circle cx="16" cy="7" r="3" fill="#a5b8ff" />
      <circle cx="10" cy="19" r="3" fill="#ff8fa3" />
      <circle cx="22" cy="19" r="3" fill="#5fd3a6" />
      <circle cx="16" cy="25" r="3" fill="#ffc66d" />
    </svg>
  )
}

export async function importGraphFlow() {
  try {
    const g = await pickGraphFile()
    if (!g) return
    await st().saveNow()
    await saveGraph(g)
    st().loadGraph(g)
    st().showToast(`Imported “${g.title}” (${Object.keys(g.nodes).length} nodes)`)
  } catch (e) {
    st().showToast(`Import failed: ${e instanceof Error ? e.message : e}`, 'error')
  }
}

export function TopBar() {
  const title = useStore((s) => s.graph.title)
  const saveState = useStore((s) => s.saveState)
  const ollama = useStore((s) => s.ollama)
  const modelCount = useStore((s) => s.models.length)
  const inspectorOpen = useStore((s) => s.inspectorOpen)
  const nodeCount = useStore((s) => s.rfNodes.length)
  const view = useStore((s) => s.view)

  return (
    <header className="topbar">
      <div className="brand">
        <Logo />
        <span>Arbor</span>
      </div>
      <input
        className="title-input"
        value={title}
        spellCheck={false}
        onChange={(e) => st().renameGraph(e.target.value)}
        title="Rename this graph"
      />
      <span className={cx('save-state', saveState)} title="Graphs autosave to this browser's IndexedDB. Ctrl+S saves now.">
        {nodeCount === 0 ? 'Empty' : saveState === 'saved' ? 'Saved' : saveState === 'saving' ? 'Saving…' : 'Unsaved'}
      </span>
      <span className="grow" />
      <div className="seg view-seg" role="tablist" aria-label="View">
        <button
          className={cx(view === 'thread' && 'on')}
          onClick={() => st().setView('thread')}
          title="Thread: read the conversation (default)"
          role="tab"
          aria-selected={view === 'thread'}
        >
          <MessagesSquare size={14} /> Thread
        </button>
        <button
          className={cx(view === 'canvas' && 'on')}
          onClick={() => st().setView('canvas')}
          title="Map: see and rearrange the whole graph"
          role="tab"
          aria-selected={view === 'canvas'}
        >
          <Network size={14} /> Map
        </button>
      </div>
      <button className={cx('status-pill', ollama)} onClick={() => st().setModal('models')} title="Local models">
        <span className="dot" />
        <span className="label">
          {ollama === 'online'
            ? `Ollama · ${modelCount} model${modelCount === 1 ? '' : 's'}`
            : ollama === 'checking'
              ? 'Connecting…'
              : 'Ollama offline'}
        </span>
      </button>
      <div className="tb-group">
        <button
          className="icon-btn big"
          title="New graph"
          onClick={async () => {
            await st().saveNow()
            st().newGraph()
          }}
        >
          <FilePlus size={17} />
        </button>
        <button className="icon-btn big" title="Library: saved graphs" onClick={() => st().setModal('library')}>
          <FolderOpen size={17} />
        </button>
        <button className="icon-btn big" title="Export this graph as a .json file" onClick={() => downloadGraph(st().graph)}>
          <Download size={17} />
        </button>
        <button className="icon-btn big" title="Import a graph .json file" onClick={() => void importGraphFlow()}>
          <Upload size={17} />
        </button>
        <button className="icon-btn big" title="Settings" onClick={() => st().setModal('settings')}>
          <Settings size={17} />
        </button>
        <button
          className={cx('icon-btn big', inspectorOpen && 'on')}
          title="Toggle side panel"
          onClick={() => st().toggleInspector()}
        >
          <PanelRight size={17} />
        </button>
      </div>
    </header>
  )
}
