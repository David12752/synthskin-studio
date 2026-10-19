import { Circle, Rect, Line, Group, Text } from 'react-konva'
import { useExtractionStore } from '../../stores/extractionStore'

/**
 * Renders the extraction preview overlay on the Konva canvas.
 * Shows circle/rect/lasso/polygon shapes and SAM points while the user is drawing.
 */
export default function ExtractionOverlay({
  zoom,
  panX,
  panY,
}: {
  zoom: number
  panX: number
  panY: number
}) {
  const isDrawing = useExtractionStore((s) => s.isDrawing)
  const circleDraw = useExtractionStore((s) => s.circleDraw)
  const rectDraw = useExtractionStore((s) => s.rectDraw)
  const lassoDraw = useExtractionStore((s) => s.lassoDraw)
  const polyLassoDraw = useExtractionStore((s) => s.polyLassoDraw)
  const samMultiPoint = useExtractionStore((s) => s.samMultiPoint)
  const isExtracting = useExtractionStore((s) => s.isExtracting)

  const hasContent = isDrawing || isExtracting || !!polyLassoDraw || !!samMultiPoint
  if (!hasContent) return null

  return (
    <Group listening={false}>
      {/* Circle draw preview */}
      {circleDraw && circleDraw.radius > 0 && (
        <>
          {/* Outer circle */}
          <Circle
            x={circleDraw.cx * zoom + panX}
            y={circleDraw.cy * zoom + panY}
            radius={circleDraw.radius * zoom}
            stroke="#ffaa33"
            strokeWidth={1.5}
            dash={[6, 3]}
            listening={false}
          />
          {/* Center crosshair */}
          <Line
            points={[
              circleDraw.cx * zoom + panX - 8, circleDraw.cy * zoom + panY,
              circleDraw.cx * zoom + panX + 8, circleDraw.cy * zoom + panY,
            ]}
            stroke="#ffaa33"
            strokeWidth={1}
            listening={false}
          />
          <Line
            points={[
              circleDraw.cx * zoom + panX, circleDraw.cy * zoom + panY - 8,
              circleDraw.cx * zoom + panX, circleDraw.cy * zoom + panY + 8,
            ]}
            stroke="#ffaa33"
            strokeWidth={1}
            listening={false}
          />
          {/* Radius dimension label */}
          <Text
            x={circleDraw.cx * zoom + panX + 6}
            y={circleDraw.cy * zoom + panY - circleDraw.radius * zoom / 2 - 8}
            text={`r: ${Math.round(circleDraw.radius)}px`}
            fontSize={11}
            fontFamily="JetBrains Mono, monospace"
            fill="#ffaa33"
            listening={false}
          />
        </>
      )}

      {/* Rect draw preview */}
      {rectDraw && rectDraw.width > 0 && rectDraw.height > 0 && (
        <>
          <Rect
            x={rectDraw.x * zoom + panX}
            y={rectDraw.y * zoom + panY}
            width={rectDraw.width * zoom}
            height={rectDraw.height * zoom}
            stroke="#ffaa33"
            strokeWidth={1.5}
            dash={[6, 3]}
            listening={false}
          />
          {/* Corner handles */}
          {[
            [rectDraw.x, rectDraw.y],
            [rectDraw.x + rectDraw.width, rectDraw.y],
            [rectDraw.x + rectDraw.width, rectDraw.y + rectDraw.height],
            [rectDraw.x, rectDraw.y + rectDraw.height],
          ].map(([hx, hy], i) => (
            <Rect
              key={i}
              x={hx * zoom + panX - 3}
              y={hy * zoom + panY - 3}
              width={6}
              height={6}
              fill="#ffaa33"
              listening={false}
            />
          ))}
          {/* Dimension label */}
          <Text
            x={rectDraw.x * zoom + panX}
            y={(rectDraw.y + rectDraw.height) * zoom + panY + 6}
            text={`${Math.round(rectDraw.width)} × ${Math.round(rectDraw.height)}px`}
            fontSize={11}
            fontFamily="JetBrains Mono, monospace"
            fill="#ffaa33"
            listening={false}
          />
        </>
      )}

      {/* Freehand Lasso draw preview */}
      {lassoDraw && lassoDraw.points.length > 1 && (
        <>
          <Line
            points={lassoDraw.points.flatMap((p) => [p.x * zoom + panX, p.y * zoom + panY])}
            stroke="#33ccff"
            strokeWidth={1.5}
            dash={[5, 3]}
            lineCap="round"
            lineJoin="round"
            listening={false}
          />
          {/* Start point indicator */}
          <Circle
            x={lassoDraw.points[0].x * zoom + panX}
            y={lassoDraw.points[0].y * zoom + panY}
            radius={4}
            fill="#33ccff"
            opacity={0.9}
            listening={false}
          />
        </>
      )}

      {/* Polygonal Lasso — segments + vertex dots */}
      {polyLassoDraw && polyLassoDraw.points.length > 0 && (
        <>
          {/* Path segments */}
          {polyLassoDraw.points.length > 1 && (
            <Line
              points={[
                ...polyLassoDraw.points.flatMap((p) => [p.x * zoom + panX, p.y * zoom + panY]),
                // Close the path visually when ≥ 3 points
                ...(polyLassoDraw.closed && polyLassoDraw.points.length >= 3
                  ? [polyLassoDraw.points[0].x * zoom + panX, polyLassoDraw.points[0].y * zoom + panY]
                  : []),
              ]}
              stroke="#9933ff"
              strokeWidth={1.5}
              dash={polyLassoDraw.closed ? [] : [5, 3]}
              lineCap="round"
              lineJoin="round"
              closed={polyLassoDraw.closed}
              listening={false}
            />
          )}
          {/* Vertex dots */}
          {polyLassoDraw.points.map((p, i) => (
            <Circle
              key={i}
              x={p.x * zoom + panX}
              y={p.y * zoom + panY}
              radius={i === 0 ? 5 : 3}
              fill={i === 0 ? '#9933ff' : '#cc88ff'}
              stroke="#ffffff"
              strokeWidth={0.8}
              listening={false}
            />
          ))}
          {/* Point count label */}
          {polyLassoDraw.points.length > 0 && (
            <Text
              x={polyLassoDraw.points[polyLassoDraw.points.length - 1].x * zoom + panX + 8}
              y={polyLassoDraw.points[polyLassoDraw.points.length - 1].y * zoom + panY - 8}
              text={polyLassoDraw.closed
                ? `${polyLassoDraw.points.length} pts — Enter to extract`
                : `${polyLassoDraw.points.length} pts — dbl-click or Enter to close`}
              fontSize={11}
              fontFamily="JetBrains Mono, monospace"
              fill="#cc88ff"
              listening={false}
            />
          )}
        </>
      )}

      {/* SAM multi-point — positive (green) and negative (red) dots */}
      {samMultiPoint && samMultiPoint.points.length > 0 && (
        <>
          {samMultiPoint.points.map((pt, i) => (
            <Group key={i} listening={false}>
              {/* Outer ring */}
              <Circle
                x={pt.x * zoom + panX}
                y={pt.y * zoom + panY}
                radius={9}
                stroke={pt.label === 1 ? '#33ff88' : '#ff4455'}
                strokeWidth={2}
                listening={false}
              />
              {/* Inner fill */}
              <Circle
                x={pt.x * zoom + panX}
                y={pt.y * zoom + panY}
                radius={5}
                fill={pt.label === 1 ? '#33ff88' : '#ff4455'}
                opacity={0.85}
                listening={false}
              />
              {/* +/- label */}
              <Text
                x={pt.x * zoom + panX - 4}
                y={pt.y * zoom + panY - 5}
                text={pt.label === 1 ? '+' : '−'}
                fontSize={11}
                fontFamily="JetBrains Mono, monospace"
                fill="#ffffff"
                fontStyle="bold"
                listening={false}
              />
            </Group>
          ))}
          {/* Instruction badge */}
          <Text
            x={samMultiPoint.points[0].x * zoom + panX + 14}
            y={samMultiPoint.points[0].y * zoom + panY - 14}
            text={`${samMultiPoint.points.filter(p => p.label === 1).length}+ / ${samMultiPoint.points.filter(p => p.label === 0).length}− — Enter to extract · Shift+click to add negative`}
            fontSize={10}
            fontFamily="JetBrains Mono, monospace"
            fill="#33ff88"
            listening={false}
          />
        </>
      )}

      {/* Extracting indicator */}
      {isExtracting && (
        <Text
          x={10}
          y={10}
          text="⏳ Extracting..."
          fontSize={12}
          fontFamily="Inter Tight, sans-serif"
          fill="#ffaa33"
          listening={false}
        />
      )}
    </Group>
  )
}
