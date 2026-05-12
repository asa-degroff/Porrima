import { memo, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { ActivityStyleContext } from '../hooks/useActivityStyle'
import type { InferenceActivityPhase } from '../types'

// ---- Shape type ----
export type ActivityShape = 'octahedron' | 'cube' | 'tetrahedron'

// ---- Shared types & constants ----
interface Props {
  isActive: boolean
  shape?: ActivityShape
  animation?: InferenceActivityPhase
  hue?: number           // base hue 0–360; if omitted, reads from ActivityStyle context
  saturation?: number   // 0–100; if omitted, reads from ActivityStyle context
  className?: string
  count?: number
  size?: number
  gap?: number
  cols?: number
  speed?: number
}

interface Rotation { x: number; y: number }

// Four quadrant resting states: lower-right, lower-left, upper-left, upper-right
const QUADRANT_RESTING: Rotation[] = [
  { x: -20, y: 20 },   // lower-right
  { x: -20, y: -20 },  // lower-left
  { x: 20, y: -20 },   // upper-left
  { x: 20, y: 20 },    // upper-right
]

type Phase = 'idle' | 'spinning' | 'returning'

const SNAP_ORIENTATIONS: Rotation[] = [
  { x: 0, y: 0 }, { x: 0, y: 90 }, { x: 0, y: 180 }, { x: 0, y: -90 },
  { x: 90, y: 0 }, { x: -90, y: 0 },
]

// Per-shape base rotations (applied before animation rotation)
// These orient the shape so the most interesting angle faces the viewer.
const BASE_ROTATION: Record<ActivityShape, Rotation> = {
  octahedron: { x: 0, y: 0 },       // Default view is fine — faces visible from slight angle
  cube: { x: -15, y: 20 },           // Slight downward tilt shows top + two sides
  tetrahedron: { x: -90, y: 15 },    // Vertex facing camera, slight Y offset for depth
}

// Per-shape amplitude scaling for resting offsets.
// Tetrahedron at -90° is sensitive to X rotation — too much makes it flip past the vertex.
const RESTING_AMPLITUDE: Record<ActivityShape, number> = {
  octahedron: 1,
  cube: 1,
  tetrahedron: 0.4,
}

function randomRestingOffsets(count: number): Rotation[] {
  return Array.from({ length: count }, () => ({
    x: (Math.random() - 0.5) * 16,
    y: (Math.random() - 0.5) * 16,
  }))
}

/** Read the default hue from ActivityStyle context. Used when no hue prop is provided. */
function usePolyhedronHue(): number {
  return useContext(ActivityStyleContext).hue
}

/** Read the default saturation from ActivityStyle context. Used when no saturation prop is provided. */
function usePolyhedronSaturation(): number {
  return useContext(ActivityStyleContext).saturation
}

function randomTargets(count: number): Rotation[] {
  return Array.from({ length: count }, () => {
    const o = SNAP_ORIENTATIONS[Math.floor(Math.random() * SNAP_ORIENTATIONS.length)]
    const axis = Math.random() > 0.5 ? 'x' : 'y'
    const dir = Math.random() > 0.5 ? 360 : -360
    return {
      x: o.x + (axis === 'x' ? dir : 0) + (Math.random() - 0.5) * 15,
      y: o.y + (axis === 'y' ? dir : 0) + (Math.random() - 0.5) * 15,
    }
  })
}

// ============================================================
// Octahedron geometry
// ============================================================
const OCT_FACE_TILT = Math.asin(1 / Math.sqrt(3)) * 180 / Math.PI // ~35.26°

const OCT_FACE_CONFIGS = [
  { ry: 45, rx: OCT_FACE_TILT, up: true, lightness: 68 },
  { ry: 135, rx: OCT_FACE_TILT, up: true, lightness: 58 },
  { ry: 225, rx: OCT_FACE_TILT, up: true, lightness: 42 },
  { ry: 315, rx: OCT_FACE_TILT, up: true, lightness: 52 },
  { ry: 45, rx: -OCT_FACE_TILT, up: false, lightness: 52 },
  { ry: 135, rx: -OCT_FACE_TILT, up: false, lightness: 45 },
  { ry: 225, rx: -OCT_FACE_TILT, up: false, lightness: 35 },
  { ry: 315, rx: -OCT_FACE_TILT, up: false, lightness: 42 },
]

const OctahedronShape = memo(function OctahedronShape({ half, colorIndex, baseHue, baseSaturation }: { half: number; colorIndex: number; baseHue: number; baseSaturation: number }) {
  const faceDist = half / Math.sqrt(3)
  const faceW = half * Math.SQRT2
  const faceH = half * Math.sqrt(6) / 2
  const overlap = 0.5
  const adjustedFaceH = faceH + overlap
  const hue = baseHue + (colorIndex - 2) * 3
  return (
    <>
      {OCT_FACE_CONFIGS.map((f, i) => (
        <div
          key={i}
          style={{
            position: 'absolute',
            width: faceW,
            height: adjustedFaceH,
            left: '50%',
            top: '50%',
            marginLeft: -faceW / 2,
            marginTop: f.up ? -adjustedFaceH * 2 / 3 + overlap / 2 : -adjustedFaceH / 3 - overlap / 2,
            transformOrigin: f.up ? '50% 66.67%' : '50% 33.33%',
            backfaceVisibility: 'hidden',
            transform: `rotateY(${f.ry}deg) rotateX(${f.rx}deg) translateZ(${faceDist}px)`,
            clipPath: f.up
              ? 'polygon(50% 0%, 0% 100%, 100% 100%)'
              : 'polygon(0% 0%, 100% 0%, 50% 100%)',
            backgroundColor: `hsl(${hue}, ${baseSaturation}%, ${f.lightness}%)`,
          }}
        />
      ))}
    </>
  )
})

// ============================================================
// Cube geometry
// ============================================================
// 6 square faces — slight downward tilt via BASE_ROTATION shows top + front + side
const CUBE_FACE_CONFIGS = [
  // Front face (facing +Z, toward viewer)
  { ry: 0, rx: 0, lightness: 62 },
  // Back face
  { ry: 180, rx: 0, lightness: 30 },
  // Right face
  { ry: 90, rx: 0, lightness: 52 },
  // Left face
  { ry: -90, rx: 0, lightness: 42 },
  // Top face (rotateX -90° tips it up to face upward)
  { ry: 0, rx: -90, lightness: 68 },
  // Bottom face
  { ry: 0, rx: 90, lightness: 35 },
]

const CubeShape = memo(function CubeShape({ half, colorIndex, baseHue, baseSaturation }: { half: number; colorIndex: number; baseHue: number; baseSaturation: number }) {
  // Scale cube down to ~70% so the 3D projection fits within the container.
  // A cube at 3/4 view projects wider than its edge length.
  const scale = 0.7
  const faceDist = half * scale
  // Slightly oversize faces to prevent sub-pixel seams
  const faceSize = half * 2 * scale + 1
  const hue = baseHue + (colorIndex - 2) * 3
  return (
    <>
      {CUBE_FACE_CONFIGS.map((f, i) => (
        <div
          key={i}
          style={{
            position: 'absolute',
            width: faceSize,
            height: faceSize,
            left: '50%',
            top: '50%',
            marginLeft: -faceSize / 2,
            marginTop: -faceSize / 2,
            backfaceVisibility: 'hidden',
            transform: `rotateY(${f.ry}deg) rotateX(${f.rx}deg) translateZ(${faceDist}px)`,
            backgroundColor: `hsl(${hue}, ${baseSaturation}%, ${f.lightness}%)`,
          }}
        />
      ))}
    </>
  )
})

// ============================================================
// Tetrahedron geometry
// ============================================================
// Regular tetrahedron with vertex pointing at camera.
// Built in "sitting" orientation (apex up) then BASE_ROTATION tips it forward.
//
// Dihedral from base to side face: arccos(1/3) ≈ 70.53°, so side face is 19.47° off
// vertical. Side normals tilt outward+UP (apex-up), so rx is +TET_FACE_TILT. Base face
// normal points straight down → rx: -90. Base-face ry: -90 aligns the clip-path triangle's
// vertices with the side faces' base edges at azimuths 60°/180°/300°.
const TET_FACE_TILT = Math.asin(1 / 3) * 180 / Math.PI // ~19.47°
const TET_SIDE_AZIMUTHS = [90, 210, 330] // rotateY values for 3 side faces

const TET_FACE_CONFIGS = [
  // 3 side faces — apexes converge at the top vertex
  { ry: TET_SIDE_AZIMUTHS[0], rx: TET_FACE_TILT, lightness: 62 },
  { ry: TET_SIDE_AZIMUTHS[1], rx: TET_FACE_TILT, lightness: 45 },
  { ry: TET_SIDE_AZIMUTHS[2], rx: TET_FACE_TILT, lightness: 52 },
  // Base face — points straight down, edges aligned with side base edges
  { ry: -90, rx: -90, lightness: 35 },
]

const TetrahedronShape = memo(function TetrahedronShape({ half, colorIndex, baseHue, baseSaturation }: { half: number; colorIndex: number; baseHue: number; baseSaturation: number }) {
  // Scale tetrahedron to ~75% so the projected vertex-view fits within the container.
  const scale = 0.75
  // Edge length: sized to fit within container when viewed vertex-first
  const edge = half * 2 * scale
  const faceDist = edge / (2 * Math.sqrt(6))
  const faceH = edge * Math.sqrt(3) / 2
  // Slight overlap for seams
  const overlap = 0.5
  const adjustedFaceH = faceH + overlap
  const hue = baseHue + (colorIndex - 2) * 3
  return (
    <>
      {TET_FACE_CONFIGS.map((f, i) => (
        <div
          key={i}
          style={{
            position: 'absolute',
            width: edge,
            height: adjustedFaceH,
            left: '50%',
            top: '50%',
            marginLeft: -edge / 2,
            // Align triangle centroid with tetrahedron center
            // Centroid of equilateral triangle is at 2/3 from apex
            marginTop: -adjustedFaceH * 2 / 3 + overlap / 2,
            // Pivot around the triangle centroid (same as octahedron upper faces)
            transformOrigin: '50% 66.67%',
            backfaceVisibility: 'hidden',
            transform: `rotateY(${f.ry}deg) rotateX(${f.rx}deg) translateZ(${faceDist}px)`,
            clipPath: 'polygon(50% 0%, 0% 100%, 100% 100%)',
            backgroundColor: `hsl(${hue}, ${baseSaturation}%, ${f.lightness}%)`,
          }}
        />
      ))}
    </>
  )
})

// ============================================================
// Main component — animation logic is shape-agnostic
// ============================================================
export const PolyhedronLogo = memo(function PolyhedronLogo({
  isActive,
  shape = 'octahedron',
  animation = 'decode',
  hue: hueProp,
  saturation: saturationProp,
  className = '',
  count = 5,
  size = 20,
  gap = 3,
  cols,
  speed = 1,
}: Props) {
  const half = size / 2
  const ctxHue = usePolyhedronHue()
  const ctxSaturation = usePolyhedronSaturation()
  const baseHue = hueProp ?? ctxHue
  const baseSaturation = saturationProp ?? ctxSaturation
  const [rotations, setRotations] = useState<Rotation[] | null>(null)
  const [phase, setPhase] = useState<Phase>('idle')
  const [quadrantIndex, setQuadrantIndex] = useState(0)
  const fallbackRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pauseRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const activeRef = useRef(isActive)

  const base = BASE_ROTATION[shape]
  const isDecodeAnimation = animation === 'decode'

  const resting = useMemo(
    () => {
      const q = QUADRANT_RESTING[quadrantIndex]
      const amp = RESTING_AMPLITUDE[shape]
      return randomRestingOffsets(count).map(o => ({ x: base.x + q.x * amp + o.x * amp, y: base.y + q.y * amp + o.y * amp }))
    },
    [count, quadrantIndex, base.x, base.y, shape],
  )

  useEffect(() => { activeRef.current = isActive }, [isActive])

  // Start animation when becoming active
  useEffect(() => {
    if (!isDecodeAnimation) return
    if (isActive && phase === 'idle') {
      setPhase('spinning')
      setRotations(randomTargets(count).map(t => ({ x: base.x + t.x, y: base.y + t.y })))
    }
  }, [isActive, phase, count, base.x, base.y, isDecodeAnimation])

  // Cleanup timers on unmount
  useEffect(() => () => {
    if (fallbackRef.current) clearTimeout(fallbackRef.current)
    if (pauseRef.current) clearTimeout(pauseRef.current)
  }, [])

  // Fallback timer in case transitionend doesn't fire
  useEffect(() => {
    if (!isDecodeAnimation) return
    if (phase === 'idle') return
    const ms = (phase === 'returning' ? 1000 : 950) / speed
    fallbackRef.current = setTimeout(() => {
      if (phase === 'spinning') {
        pauseRef.current = setTimeout(() => {
          setPhase('returning')
          setRotations(null)
        }, 80 / speed)
      } else if (phase === 'returning') {
        if (activeRef.current) {
          pauseRef.current = setTimeout(() => {
            setQuadrantIndex((q) => (q + 1) % 4)
            setPhase('spinning')
            setRotations(randomTargets(count).map(t => ({ x: base.x + t.x, y: base.y + t.y })))
          }, 120 / speed)
        } else {
          setPhase('idle')
          setQuadrantIndex(0)
        }
      }
    }, ms)
    return () => { if (fallbackRef.current) clearTimeout(fallbackRef.current) }
  }, [phase, count, speed, base.x, base.y, isDecodeAnimation])

  const handleTransitionEnd = useCallback((e: React.TransitionEvent) => {
    if (!isDecodeAnimation) return
    if (e.propertyName !== 'transform') return
    if (fallbackRef.current) { clearTimeout(fallbackRef.current); fallbackRef.current = null }
    if (phase === 'spinning') {
      pauseRef.current = setTimeout(() => {
        setPhase('returning')
        setRotations(null)
      }, 80 / speed)
    } else if (phase === 'returning') {
      if (activeRef.current) {
        pauseRef.current = setTimeout(() => {
          setQuadrantIndex((q) => (q + 1) % 4)
          setPhase('spinning')
          setRotations(randomTargets(count).map(t => ({ x: base.x + t.x, y: base.y + t.y })))
        }, 120 / speed)
      } else {
        setPhase('idle')
        setQuadrantIndex(0)
      }
    }
  }, [phase, count, speed, base.x, base.y, isDecodeAnimation])

  const containerStyle: React.CSSProperties = cols
    ? {
      display: 'inline-grid',
      gridTemplateColumns: `repeat(${cols}, ${size}px)`,
      gap: `${gap}px`,
      perspective: size * 10,
    }
    : {
      display: 'inline-flex',
      alignItems: 'center',
      perspective: size * 10,
      gap: `${gap}px`,
    }

  const ShapeComponent = shape === 'octahedron' ? OctahedronShape
    : shape === 'cube' ? CubeShape
    : TetrahedronShape

  return (
    <div
      className={`select-none ${className}`}
      style={containerStyle}
    >
      {animation === 'prefill' && (
        <style>{`
          @keyframes polyhedron-prefill-spin {
            from { transform: rotateY(0deg); }
            to { transform: rotateY(360deg); }
          }
          @keyframes polyhedron-prefill-wobble {
            0%, 100% { transform: rotateX(var(--wobble-x-start)) rotateZ(var(--wobble-z-start)); }
            50% { transform: rotateX(var(--wobble-x-end)) rotateZ(var(--wobble-z-end)); }
          }
        `}</style>
      )}
      {Array.from({ length: count }, (_, i) => {
        const r = rotations?.[i] ?? resting[i]
        const dur = (phase === 'spinning' ? 0.6 : phase === 'returning' ? 0.7 : 0.5) / speed
        const del = (phase === 'spinning' ? i * 50 : phase === 'returning' ? i * 35 : 0) / speed
        if (animation === 'prefill') {
          const wobbleX = 2.5 + (i % 3) * 0.75
          const wobbleZ = 1.4 + (i % 2) * 0.7
          const spinDuration = (3.6 + (i % 4) * 0.35) / speed
          const wobbleDuration = (2.2 + (i % 5) * 0.28) / speed
          const prefillStyle = {
            width: size,
            height: size,
            position: 'relative',
            transformStyle: 'preserve-3d',
            transform: `rotateX(${base.x}deg) rotateY(${base.y}deg)`,
          } satisfies React.CSSProperties
          const wobbleStyle = {
            width: size,
            height: size,
            position: 'relative',
            transformStyle: 'preserve-3d',
            animation: isActive ? `polyhedron-prefill-wobble ${wobbleDuration}s ease-in-out infinite` : 'none',
            animationDelay: `${-i * 0.22}s`,
            ['--wobble-x-start' as string]: `${-wobbleX}deg`,
            ['--wobble-x-end' as string]: `${wobbleX}deg`,
            ['--wobble-z-start' as string]: `${wobbleZ}deg`,
            ['--wobble-z-end' as string]: `${-wobbleZ}deg`,
          } as React.CSSProperties
          return (
            <div key={i} style={{ width: size, height: size, perspective: size * 5 }}>
              <div
                style={{
                  width: size,
                  height: size,
                  position: 'relative',
                  transformStyle: 'preserve-3d',
                  animation: isActive ? `polyhedron-prefill-spin ${spinDuration}s linear infinite` : 'none',
                  animationDelay: `${-i * 0.18}s`,
                }}
              >
                <div style={wobbleStyle}>
                  <div style={prefillStyle}>
                    <ShapeComponent half={half} colorIndex={i} baseHue={baseHue} baseSaturation={baseSaturation} />
                  </div>
                </div>
              </div>
            </div>
          )
        }
        return (
          <div key={i} style={{ width: size, height: size, perspective: size * 5 }}>
            <div
              style={{
                width: size,
                height: size,
                position: 'relative',
                transformStyle: 'preserve-3d',
                transform: `rotateX(${r.x}deg) rotateY(${r.y}deg)`,
                transition: `transform ${dur}s cubic-bezier(0.25, 0.46, 0.45, 0.94)`,
                transitionDelay: `${del}ms`,
              }}
              onTransitionEnd={i === count - 1 ? handleTransitionEnd : undefined}
            >
              <ShapeComponent half={half} colorIndex={i} baseHue={baseHue} baseSaturation={baseSaturation} />
            </div>
          </div>
        )
      })}
    </div>
  )
})

// Backward-compatible re-export (always octahedron, default hue)
export const OctahedronLogo = memo(function OctahedronLogo(props: Omit<Props, 'shape' | 'hue' | 'saturation'>) {
  return <PolyhedronLogo {...props} shape="octahedron" />
})
