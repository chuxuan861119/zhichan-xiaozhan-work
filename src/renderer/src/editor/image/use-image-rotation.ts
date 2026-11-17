import { useState } from "react";

// Keep display angles continuous; the saved document still uses 0/90/180/270.
export function useImageRotation(rotationDeg: number, assetKey: string): number {
  const [previous, setPrevious] = useState({ rotationDeg, assetKey, angle: rotationDeg });
  if (previous.assetKey !== assetKey) {
    setPrevious({ rotationDeg, assetKey, angle: rotationDeg });
    return rotationDeg;
  }
  if (previous.rotationDeg !== rotationDeg) {
    const delta = ((rotationDeg - previous.rotationDeg + 540) % 360) - 180;
    const angle = previous.angle + delta;
    setPrevious({ rotationDeg, assetKey, angle });
    return angle;
  }
  return previous.angle;
}
