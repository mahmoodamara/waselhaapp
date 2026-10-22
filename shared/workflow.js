// Additive protocol: historical orders retain their original behavior.
export const WORKFLOW_VERSION = 3;
export const isUnifiedOrder = order => order?.workflowVersion === WORKFLOW_VERSION;
export const isQuickWorkflow = order => [2, WORKFLOW_VERSION].includes(order?.workflowVersion);
export const PAYMENT_STATUSES = Object.freeze(["unpaid", "prepaid"]);
export const supportsUnifiedWorkflow = driver => driver?.supportedWorkflowVersion === WORKFLOW_VERSION;
// Three expanding waves within the existing bounded search window.
export function dispatchWave(order, now = Date.now()) {
  if (!isUnifiedOrder(order)) return 3;
  const start = new Date(order.searchStartedAt).getTime(), end = new Date(order.searchDeadlineAt).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return 1;
  return Math.max(1, Math.min(3, 1 + Math.floor((now - start) * 3 / (end - start))));
}
