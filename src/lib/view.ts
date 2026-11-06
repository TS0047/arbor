import { useSyncExternalStore } from 'react'
import { useStore, type View } from '../store'

/** Below this width two panes are too cramped to be useful, so Split falls back to the Thread. */
const NARROW = '(max-width: 900px)'

const subscribe = (cb: () => void) => {
  const m = window.matchMedia(NARROW)
  m.addEventListener('change', cb)
  return () => m.removeEventListener('change', cb)
}
const isNarrow = () => window.matchMedia(NARROW).matches

/**
 * The view actually on screen. The stored choice is kept as-is, so widening
 * the window again brings the split back without the user re-picking it.
 */
export function useShownView(): View {
  const view = useStore((s) => s.view)
  const narrow = useSyncExternalStore(subscribe, isNarrow, () => false)
  return view === 'split' && narrow ? 'thread' : view
}
