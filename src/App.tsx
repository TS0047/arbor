import { useEffect, useState, type DragEvent } from 'react'
import { ReactFlowProvider } from '@xyflow/react'
import { deleteWithUndo, LAST_KEY, useStore } from './store'
import { loadGraphById, parseGraphFile, sanitizeGraph, saveGraph } from './lib/persist'
import { cx } from './lib/util'
import { TopBar } from './components/TopBar'
import { Canvas } from './components/Canvas'
import { ThreadPane } from './components/ThreadPane'
import { Composer } from './components/Composer'
import { Inspector } from './components/Inspector'
import { DialogueModal } from './components/modals/DialogueModal'
import { LibraryModal } from './components/modals/LibraryModal'
import { SettingsModal } from './components/modals/SettingsModal'
import { ModelsModal } from './components/modals/ModelsModal'

const st = useStore.getState

/** Reopen the last graph, and keep the model list fresh (pulls from a terminal show up too). */
function useBoot() {
  useEffect(() => {
    void (async () => {
      const last = localStorage.getItem(LAST_KEY)
      const g = last ? await loadGraphById(last) : undefined
      if (g) st().loadGraph(sanitizeGraph(g))
    })()
    void st().refreshModels()
    const t = setInterval(() => void st().refreshModels(), 8000)
    return () => clearInterval(t)
  }, [])
}

/** Debounced autosave (0.8 s quiet, but at most every 4 s while a reply streams). */
function useAutosave() {
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    let firstDirty = 0
    const unsub = useStore.subscribe((s, prev) => {
      if (s.graph === prev.graph || s.graph.id !== prev.graph.id) return
      if (s.saveState !== 'unsaved') useStore.setState({ saveState: 'unsaved' })
      const now = Date.now()
      if (!firstDirty) firstDirty = now
      clearTimeout(timer)
      timer = setTimeout(
        () => {
          firstDirty = 0
          void st().saveNow()
        },
        Math.max(0, Math.min(800, 4000 - (now - firstDirty))),
      )
    })
    const onUnload = () => {
      if (st().saveState !== 'saved') void st().saveNow()
    }
    window.addEventListener('beforeunload', onUnload)
    return () => {
      unsub()
      clearTimeout(timer)
      window.removeEventListener('beforeunload', onUnload)
    }
  }, [])
}

function useShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement
      const typing = !!target.closest?.('input, textarea, select, [contenteditable="true"]')
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault()
        void st().saveNow().then(() => st().showToast('Saved to library'))
        return
      }
      if (st().modal) return
      if (typing) {
        if (e.key === 'Escape') target.blur()
        return
      }
      const undo = st().toast?.action
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && undo) {
        e.preventDefault()
        st().toast && useStore.setState({ toast: null })
        undo.run()
      } else if (e.key === 'Escape') st().select([])
      else if (e.key === '/') {
        e.preventDefault()
        st().focusComposer()
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && st().selection.length) {
        e.preventDefault()
        deleteWithUndo(st().selection)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}

function Toast() {
  const toast = useStore((s) => s.toast)
  if (!toast) return null
  const action = toast.action
  return (
    <div key={toast.id} className={cx('toast', toast.kind)} role="status">
      <span>{toast.text}</span>
      {action && (
        <button
          className="toast-action"
          title={`${action.label} (Ctrl+Z)`}
          onClick={() => {
            useStore.setState({ toast: null })
            action.run()
          }}
        >
          {action.label}
        </button>
      )}
    </div>
  )
}

/** Drag an .arbor.json anywhere onto the app. No picker required. */
function useGraphDrop() {
  const [over, setOver] = useState(false)
  const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer.types).includes('Files')
  const onDrop = async (e: DragEvent) => {
    e.preventDefault()
    setOver(false)
    const file = e.dataTransfer.files?.[0]
    if (!file) return
    try {
      const g = parseGraphFile(await file.text())
      await st().saveNow()
      await saveGraph(g)
      st().loadGraph(g)
      st().showToast(`Imported “${g.title}” (${Object.keys(g.nodes).length} nodes)`)
    } catch (err) {
      st().showToast(`Could not import: ${err instanceof Error ? err.message : err}`, 'error')
    }
  }
  return {
    over,
    bind: {
      onDragOver: (e: DragEvent) => {
        if (!hasFiles(e)) return
        e.preventDefault()
        setOver(true)
      },
      onDragLeave: (e: DragEvent) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver(false)
      },
      onDrop: (e: DragEvent) => void onDrop(e),
    },
  }
}

export default function App() {
  const modal = useStore((s) => s.modal)
  const inspectorOpen = useStore((s) => s.inspectorOpen)
  const view = useStore((s) => s.view)
  const nodeCount = useStore((s) => s.rfNodes.length)
  const drop = useGraphDrop()
  useBoot()
  useAutosave()
  useShortcuts()

  return (
    <div className="app">
      <TopBar />
      <div className={cx('main', drop.over && 'dropping')} {...drop.bind}>
        {drop.over && <div className="drop-overlay">Drop an .arbor.json to import it</div>}
        <div className="stage">
          {view === 'canvas' ? (
            <ReactFlowProvider>
              <Canvas />
            </ReactFlowProvider>
          ) : (
            <ThreadPane />
          )}
          <Composer />
        </div>
        {inspectorOpen && nodeCount > 0 && <Inspector />}
      </div>
      {modal === 'dialogue' && <DialogueModal />}
      {modal === 'library' && <LibraryModal />}
      {modal === 'settings' && <SettingsModal />}
      {modal === 'models' && <ModelsModal />}
      <Toast />
    </div>
  )
}
