export type GlassFilterMap = {
  href: string
  width: number
  height: number
  scale: number
}

function smoothStep(a: number, b: number, value: number): number {
  const t = Math.max(0, Math.min(1, (value - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

function vectorLength(x: number, y: number): number {
  return Math.sqrt(x * x + y * y)
}

function roundedRectSdf(x: number, y: number, width: number, height: number, radius: number): number {
  const qx = Math.abs(x) - width + radius
  const qy = Math.abs(y) - height + radius
  return Math.min(Math.max(qx, qy), 0) + vectorLength(Math.max(qx, 0), Math.max(qy, 0)) - radius
}

export type GlassShapeOptions = {
  halfX?: number   // 归一化半宽（相对元素）；胶囊默认 0.3
  halfY?: number   // 归一化半高；胶囊默认 0.2
  radius?: number  // 圆角半径（归一化）；默认 0.6
  edge?: number    // 边缘折射带偏移；默认 0.15
  feather?: number // 折射带羽化范围；默认 0.8
  strength?: number // 折射强度倍率（只乘最终 scale，真正放大位移）；默认 1
  surface?: number // 内部表面折射强度（像素）；默认 0，仅边缘折射
  surfaceScale?: number // 内部表面折射波纹密度；默认 2.6
  uniformSurface?: boolean // 内部折射是否在形状内保持一致强度；默认 false
  edgeStrength?: number // 边缘折射强度倍率；默认 1
}

export function createLiquidGlassMap(width: number, height: number, opts: GlassShapeOptions = {}): GlassFilterMap | null {
  const { halfX = 0.3, halfY = 0.2, radius = 0.6, edge = 0.15, feather = 0.8, strength = 1, surface = 0, surfaceScale = 2.6, uniformSurface = false, edgeStrength = 1 } = opts
  const w = Math.max(1, Math.round(width))
  const h = Math.max(1, Math.round(height))
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const context = canvas.getContext('2d')
  if (!context) return null

  const data = new Uint8ClampedArray(w * h * 4)
  const rawValues: number[] = []
  let maxScale = 0
  for (let i = 0; i < data.length; i += 4) {
    const x = (i / 4) % w
    const y = Math.floor(i / 4 / w)
    const uvX = x / w
    const uvY = y / h
    const ix = uvX - 0.5
    const iy = uvY - 0.5
    const distanceToEdge = roundedRectSdf(ix, iy, halfX, halfY, radius)
    const displacement = smoothStep(feather, 0, distanceToEdge - edge)
    const scaled = smoothStep(0, 1, displacement)
    const targetX = (ix * scaled + 0.5) * w
    const targetY = (iy * scaled + 0.5) * h
    const insideMask = uniformSurface ? 1 : 1 - smoothStep(0, 0.12, distanceToEdge)
    const surfaceX = surface
      ? (
          Math.sin((uvY * surfaceScale + uvX * 0.38) * Math.PI * 2)
          + Math.sin((uvX * surfaceScale * 0.72 + uvY * 1.7) * Math.PI * 2) * 0.45
        ) * surface * insideMask
      : 0
    const surfaceY = surface
      ? (
          Math.cos((uvX * surfaceScale + uvY * 0.42) * Math.PI * 2)
          + Math.sin((uvY * surfaceScale * 0.68 + uvX * 1.35) * Math.PI * 2) * 0.4
        ) * surface * insideMask
      : 0
    const dx = (targetX - x) * edgeStrength + surfaceX
    const dy = (targetY - y) * edgeStrength + surfaceY
    maxScale = Math.max(maxScale, Math.abs(dx), Math.abs(dy))
    rawValues.push(dx, dy)
  }

  maxScale = Math.max(1, maxScale * 0.5)
  let index = 0
  for (let i = 0; i < data.length; i += 4) {
    const r = rawValues[index++] / maxScale + 0.5
    const g = rawValues[index++] / maxScale + 0.5
    data[i] = Math.max(0, Math.min(255, r * 255))
    data[i + 1] = Math.max(0, Math.min(255, g * 255))
    data[i + 2] = 0
    data[i + 3] = 255
  }

  context.putImageData(new ImageData(data, w, h), 0, 0)
  return {
    href: canvas.toDataURL(),
    width: w,
    height: h,
    scale: maxScale * strength,
  }
}
