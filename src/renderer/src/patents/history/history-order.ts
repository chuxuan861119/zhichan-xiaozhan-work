let order = 0;

// Shared by drawing and reference-mark history so panel operations keep user order.
export function nextHistoryOrder(): number {
  return ++order;
}
