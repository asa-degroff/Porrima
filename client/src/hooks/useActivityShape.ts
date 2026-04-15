import { createContext, useContext } from 'react'
import type { ActivityShape } from '../types'

const ActivityShapeContext = createContext<ActivityShape>('octahedron')

export const ActivityShapeProvider = ActivityShapeContext.Provider

export function useActivityShape(): ActivityShape {
  return useContext(ActivityShapeContext)
}