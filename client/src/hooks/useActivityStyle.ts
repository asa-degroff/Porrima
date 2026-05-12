import { createContext, useContext } from 'react'
import type { ActivityShape } from '../types'

export interface ActivityStyle {
  shape: ActivityShape
  hue: number // 0–360, default 38 (amber)
  saturation: number // 0–100, default 85
}

const DEFAULT_STYLE: ActivityStyle = { shape: 'octahedron', hue: 38, saturation: 85 }

export const ActivityStyleContext = createContext<ActivityStyle>(DEFAULT_STYLE)

export const ActivityStyleProvider = ActivityStyleContext.Provider

export function useActivityShape(): ActivityShape {
  return useContext(ActivityStyleContext).shape
}

export function useActivityHue(): number {
  return useContext(ActivityStyleContext).hue
}

export function useActivitySaturation(): number {
  return useContext(ActivityStyleContext).saturation
}