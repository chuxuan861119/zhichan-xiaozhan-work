import { nonWhiteBounds } from "../../../shared/drawing-markup/trim-white";

self.onmessage = (
  event: MessageEvent<{ data: Uint8ClampedArray; width: number; height: number }>,
) => {
  const { data, width, height } = event.data;
  try {
    self.postMessage({ bounds: nonWhiteBounds(data, width, height) });
  } catch {
    self.postMessage({ error: true });
  }
};
