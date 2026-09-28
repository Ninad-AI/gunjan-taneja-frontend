"use client"

import { cn } from "@/lib/utils"

interface RippleProps {
  className?: string
  children?: React.ReactNode
  /** Size of the innermost circle in pixels */
  mainCircleSize?: number
  /** Opacity of the innermost circle */
  mainCircleOpacity?: number
  /** Number of concentric circles */
  numCircles?: number
  /** Color of the ripple circles */
  color?: string
}

const Ripple = ({
  className,
  children,
  mainCircleSize = 210,
  mainCircleOpacity = 0.24,
  numCircles = 8,
  color = "rgba(255, 255, 255, 0.8)",
}: RippleProps) => {
  return (
    <div className={cn("fixed inset-0 overflow-hidden bg-transparent", className)}>
      {/* Keyframe animation */}
      <style>{`
        @keyframes ripple-pulse {
          0%, 100% {
            transform: translate(-50%, -50%) scale(1);
          }
          50% {
            transform: translate(-50%, -50%) scale(0.9);
          }
        }
      `}</style>

      {/* Ripple container with radial fade mask */}
      <div
        className="pointer-events-none absolute inset-0 select-none"
        style={{
          maskImage: "radial-gradient(ellipse at center, white 0%, white 30%, transparent 70%)",
          WebkitMaskImage:
            "radial-gradient(ellipse at center, white 0%, white 30%, transparent 70%)",
        }}
      >
        {Array.from({ length: numCircles }, (_, i) => {
          const size = mainCircleSize + i * 70
          const opacity = mainCircleOpacity - i * 0.03

          return (
            <div
              key={i}
              className="absolute rounded-full"
              style={{
                width: size,
                height: size,
                opacity,
                top: "50%",
                left: "50%",
                transform: "translate(-50%, -50%) scale(1)",
                border: `1px solid ${color}`,
                backgroundColor: `${color.replace(/[\d.]+\)$/, "0.1)")}`,
                boxShadow: `0 0 20px ${color.replace(/[\d.]+\)$/, "0.1)")}`,
                animation: "ripple-pulse 4s ease-in-out infinite",
                animationDelay: `${i * 0.12}s`,
                willChange: "transform",
              }}
            />
          )
        })}
      </div>

      {/* Content layer */}
      {children && <div className="relative z-10 h-full w-full">{children}</div>}
    </div>
  )
}

export default Ripple;
