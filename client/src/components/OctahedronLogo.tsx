import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'

interface Props {
  isActive: boolean
  className?: string
}

const COUNT = 5
const SIZE = 20
const HALF = SIZE / 2
const GAP = 3
const RESTING_X = -20
const RESTING_Y = 15

// Regular octahedron geometry — tilt angle from CSS +Z axis to face normal
const FACE_TILT = Math.asin(1 / Math.sqrt(3)) * 180 / Math.PI // ~35.26°
const FACE_DIST = HALF / Math.sqrt(3)                    // center-to-face distance
const FACE_W = HALF * Math.SQRT2                         // triangle base
const FACE_H = HALF * Math.sqrt(6) / 2                   // triangle height

interface Rotation { x: number; y: number }
type Phase = 'idle' | 'spinning' | 'returning'

const SNAP_ORIENTATIONS: Rotation[] = [
  { x: 0, y: 0 }, { x: 0, y: 90 }, { x: 0, y: 180 }, { x: 0, y: -90 },
  { x: 90, y: 0 }, { x: -90, y: 0 },
]

function randomRestingOffsets(): Rotation[] {
  return Array.from({ length: COUNT }, () => ({
    x: (Math.random() - 0.5) * 16,
    y: (Math.random() - 0.5) * 16,
  }))
}

function randomTargets(): Rotation[] {
  return Array.from({ length: COUNT }, () => {
    const o = SNAP_ORIENTATIONS[Math.floor(Math.random() * SNAP_ORIENTATIONS.length)]
    const axis = Math.random() > 0.5 ? 'x' : 'y'
    const dir = Math.random() > 0.5 ? 360 : -360
    return {
      x: o.x + (axis === 'x' ? dir : 0) + (Math.random() - 0.5) * 15,
      y: o.y + (axis === 'y' ? dir : 0) + (Math.random() - 0.5) * 15,
    }
  })
}

// 8 triangular faces of a regular octahedron
// Upper faces (apex toward top vertex), lower faces (apex toward bottom)
// Lightness varies to simulate directional lighting
// In CSS coords (Y-down), upper face normals have -Y component → positive rotateX
// Lower face normals have +Y component → negative rotateX
const FACE_CONFIGS = [
  { ry: 45, rx: FACE_TILT, up: true, lightness: 68 },
  { ry: 135, rx: FACE_TILT, up: true, lightness: 58 },
  { ry: 225, rx: FACE_TILT, up: true, lightness: 42 },
  { ry: 315, rx: FACE_TILT, up: true, lightness: 52 },
  { ry: 45, rx: -FACE_TILT, up: false, lightness: 52 },
  { ry: 135, rx: -FACE_TILT, up: false, lightness: 45 },
  { ry: 225, rx: -FACE_TILT, up: false, lightness: 35 },
  { ry: 315, rx: -FACE_TILT, up: false, lightness: 42 },
]

// Memoized faces — geometry and color never change per octahedron
const OctahedronShape = memo(function OctahedronShape({ colorIndex }: { colorIndex: number }) {
  const hue = 38 + (colorIndex - 2) * 3
  return (
    <>
      {FACE_CONFIGS.map((f, i) => (
        <div
          key={i}
          style={{
            position: 'absolute',
            width: FACE_W,
            height: FACE_H,
            left: '50%',
            top: '50%',
            marginLeft: -FACE_W / 2,
            // Align triangle centroid (not bbox center) with octahedron center
            marginTop: f.up ? -FACE_H * 2 / 3 : -FACE_H / 3,
            // Pivot around the triangle centroid
            transformOrigin: f.up ? '50% 66.67%' : '50% 33.33%',
            backfaceVisibility: 'hidden',
            transform: `rotateY(${f.ry}deg) rotateX(${f.rx}deg) translateZ(${FACE_DIST}px)`,
            clipPath: f.up
              ? 'polygon(50% 0%, 0% 100%, 100% 100%)'
              : 'polygon(0% 0%, 100% 0%, 50% 100%)',
            backgroundColor: `hsl(${hue}, 85%, ${f.lightness}%)`,
          }}
        />
      ))}
    </>
  )
})

export const OctahedronLogo = memo(function OctahedronLogo({ isActive, className = '' }: Props) {
  const [rotations, setRotations] = useState<Rotation[] | null>(null)
  const [phase, setPhase] = useState<Phase>('idle')
  const fallbackRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pauseRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const activeRef = useRef(isActive)

  const resting = useMemo(
    () => randomRestingOffsets().map(o => ({ x: RESTING_X + o.x, y: RESTING_Y + o.y })),
    [],
  )

  useEffect(() => { activeRef.current = isActive }, [isActive])

  // Start animation when becoming active
  useEffect(() => {
    if (isActive && phase === 'idle') {
      setPhase('spinning')
      setRotations(randomTargets())
    }
  }, [isActive, phase])

  // Cleanup timers on unmount
  useEffect(() => () => {
    if (fallbackRef.current) clearTimeout(fallbackRef.current)
    if (pauseRef.current) clearTimeout(pauseRef.current)
  }, [])

  // Fallback timer in case transitionend doesn't fire
  useEffect(() => {
    if (phase === 'idle') return
    const ms = phase === 'returning' ? 1000 : 950
    fallbackRef.current = setTimeout(() => {
      if (phase === 'spinning') {
        pauseRef.current = setTimeout(() => {
          setPhase('returning')
          setRotations(null)
        }, 80)
      } else if (phase === 'returning') {
        if (activeRef.current) {
          pauseRef.current = setTimeout(() => {
            setPhase('spinning')
            setRotations(randomTargets())
          }, 120)
        } else {
          setPhase('idle')
        }
      }
    }, ms)
    return () => { if (fallbackRef.current) clearTimeout(fallbackRef.current) }
  }, [phase])

  const handleTransitionEnd = useCallback((e: React.TransitionEvent) => {
    if (e.propertyName !== 'transform') return
    if (fallbackRef.current) { clearTimeout(fallbackRef.current); fallbackRef.current = null }
    if (phase === 'spinning') {
      pauseRef.current = setTimeout(() => {
        setPhase('returning')
        setRotations(null)
      }, 80)
    } else if (phase === 'returning') {
      if (activeRef.current) {
        pauseRef.current = setTimeout(() => {
          setPhase('spinning')
          setRotations(randomTargets())
        }, 120)
      } else {
        setPhase('idle')
      }
    }
  }, [phase])

  return (
    <div
      className={`inline-flex items-center select-none ${className}`}
      style={{ perspective: SIZE * 10, gap: `${GAP}px` }}
    >
      {Array.from({ length: COUNT }, (_, i) => {
        const r = rotations?.[i] ?? resting[i]
        const dur = phase === 'spinning' ? 0.6 : phase === 'returning' ? 0.7 : 0.5
        const del = phase === 'spinning' ? i * 50 : phase === 'returning' ? i * 35 : 0
        return (
          <div key={i} style={{ width: SIZE, height: SIZE, perspective: SIZE * 5 }}>
            <div
              style={{
                width: SIZE,
                height: SIZE,
                position: 'relative',
                transformStyle: 'preserve-3d',
                transform: `rotateX(${r.x}deg) rotateY(${r.y}deg)`,
                transition: `transform ${dur}s cubic-bezier(0.25, 0.46, 0.45, 0.94)`,
                transitionDelay: `${del}ms`,
              }}
              onTransitionEnd={i === COUNT - 1 ? handleTransitionEnd : undefined}
            >
              <OctahedronShape colorIndex={i} />
            </div>
          </div>
        )
      })}
    </div>
  )
})
