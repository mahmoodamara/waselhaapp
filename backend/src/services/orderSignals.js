// Process-local invalidation for the single-instance pilot. No order documents
// or customer data cross this boundary. Delivery is recoverable through REST.
const listeners = new Set();
export function onOrdersChanged(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
export function ordersChanged() {
  for (const listener of listeners) listener();
}
