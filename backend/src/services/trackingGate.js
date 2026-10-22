// Single-process pilot: serialize coordinate disclosure with the committed
// post-pickup workflow writes and customer-link rotation for the SAME order.
// Mongo CAS remains authoritative for business transitions. No GPS is queued.
const queues = new Map();
export function withTrackingOrder(orderId, work) {
  const key = String(orderId);
  const job = (queues.get(key) ?? Promise.resolve()).then(work);
  const tail = job.catch(() => {});
  queues.set(key, tail);
  void tail.finally(() => { if (queues.get(key) === tail) queues.delete(key); });
  return job;
}
