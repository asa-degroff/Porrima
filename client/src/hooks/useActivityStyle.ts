import { createContext, useContext } from 'react'
import type { ActivityShape } from '../types'

export interface ActivityStyle {
  shape: ActivityShape
  hue: number // 0–360, default 38 (amber)
}

const DEFAULT_STYLE: ActivityStyle = { shape: 'octahedron', hue: 38 }

export const ActivityStyleContext = createContext<ActivityStyle>(DEFAULT_STYLE)

export const ActivityStyleProvider = ActivityStyleContext.Provider

export function useActivityShape(): ActivityShape {
  return useContext(ActivityStyleContext).shape
}

export function useActivityHue(): number {
  return useContext(ActivityStyleContext).hue
}