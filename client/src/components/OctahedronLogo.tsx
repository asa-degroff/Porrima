import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'

interface Props {
  isActive: boolean
  className?: string
  count?: number
  size?: number
  gap?: number
  cols?: number // if set, renders as a grid with this many columns
  speed?: number // animation speed multiplier (default 1, use 0.5 for half speed)
}

const RESTING_X = -20
const RESTING_Y = 15

// Regular octahedron geometry — tilt angle from CSS +Z axis to face normal
const FACE_TILT = Math.asin(1 / Math.sqrt(3)) * 180 / Math.PI // ~35.26°

interface Rotation { x: number; y: number }
type Phase = 'idle' | 'spinning' | 'returning'

const SNAP_ORIENTATIONS: Rotation[] = [
  { x: 0, y: 0 }, { x: 0, y: 90 }, { x: 0, y: 180 }, { x: 0, y: -90 },
  { x: 90, y: 0 }, { x: -90, y: 0 },
]

function randomRestingOffsets(count: number): Rotation[] {
  return Array.from({ length: count }, () => ({
    x: (Math.random() - 0.5) * 16,
    y: (Math.random() - 0.5) * 16,
  }))
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
const OctahedronShape = memo(function OctahedronShape({ half, colorIndex }: { half: number; colorIndex: number }) {
  const faceDist = half / Math.sqrt(3)
  const faceW = half * Math.SQRT2
  const faceH = half * Math.sqrt(6) / 2
  // Center hue range around amber baseline
  const hue = 38 + (colorIndex - 2) * 3
  return (
    <>
      {FACE_CONFIGS.map((f, i) => (
        <div
          key={i}
          style={{
            position: 'absolute',
            width: faceW,
            height: faceH,
            left: '50%',
            top: '50%',
            marginLeft: -faceW / 2,
            // Align triangle centroid (not bbox center) with octahedron center
            marginTop: f.up ? -faceH * 2 / 3 : -faceH / 3,
            // Pivot around the triangle centroid
            transformOrigin: f.up ? '50% 66.67%' : '50% 33.33%',
            backfaceVisibility: 'hidden',
            transform: `rotateY(${f.ry}deg) rotateX(${f.rx}deg) translateZ(${faceDist}px)`,
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

export const OctahedronLogo = memo(function OctahedronLogo({
  isActive,
  className = '',
  count = 5,
  size = 20,
  gap = 3,
  cols,
  speed = 1,
}: Props) {
  const half = size / 2
  const [rotations, setRotations] = useState<Rotation[] | null>(null)
  const [phase, setPhase] = useState<Phase>('idle')
  const fallbackRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pauseRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const activeRef = useRef(isActive)

  const resting = useMemo(
    () => randomRestingOffsets(count).map(o => ({ x: RESTING_X + o.x, y: RESTING_Y + o.y })),
    [count],
  )

  useEffect(() => { activeRef.current = isActive }, [isActive])

  // Start animation when becoming active
  useEffect(() => {
    if (isActive && phase === 'idle') {
      setPhase('spinning')
      setRotations(randomTargets(count))
    }
  }, [isActive, phase, count])

  // Cleanup timers on unmount
  useEffect(() => () => {
    if (fallbackRef.current) clearTimeout(fallbackRef.current)
    if (pauseRef.current) clearTimeout(pauseRef.current)
  }, [])

  // Fallback timer in case transitionend doesn't fire
  useEffect(() => {
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
            setPhase('spinning')
            setRotations(randomTargets(count))
          }, 120 / speed)
        } else {
          setPhase('idle')
        }
      }
    }, ms)
    return () => { if (fallbackRef.current) clearTimeout(fallbackRef.current) }
  }, [phase, count, speed])

  const handleTransitionEnd = useCallback((e: React.TransitionEvent) => {
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
          setPhase('spinning')
          setRotations(randomTargets(count))
        }, 120 / speed)
      } else {
        setPhase('idle')
      }
    }
  }, [phase, count, speed])

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

  return (
    <div
      className={`select-none ${className}`}
      style={containerStyle}
    >
      {Array.from({ length: count }, (_, i) => {
        const r = rotations?.[i] ?? resting[i]
        const dur = (phase === 'spinning' ? 0.6 : phase === 'returning' ? 0.7 : 0.5) / speed
        const del = (phase === 'spinning' ? i * 50 : phase === 'returning' ? i * 35 : 0) / speed
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
              <OctahedronShape half={half} colorIndex={i} />
            </div>
          </div>
        )
      })}
    </div>
  )
})
