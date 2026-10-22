import { Order } from '../models/index.js';
import { log } from './log.js';
import { randomBytes } from 'node:crypto';
export const CUSTOMER_RETENTION_DAYS = 90;
export async function sweepCustomerRetention(now = new Date(), batchSize = 200) {
  const filter = { status: { $in: ['delivered','cancelled','delivery_failed','returned'] }, activeAssignment: false,
    updatedAt: { $lt: new Date(now.getTime() - CUSTOMER_RETENTION_DAYS * 86400000) }, piiRemovedAt: null };
  const rows = await Order.find(filter).select('_id').limit(Math.min(1000, batchSize)).lean();
  if (!rows.length) return 0;
  const result = await Order.bulkWrite(rows.map(row => ({ updateOne: { filter: { ...filter, _id: row._id }, update: {
    $set: { piiRemovedAt: now, customerPhone: '', recipientName: '', preliminaryAddress: '', finalAddress: '', deliveryInstructions: '', parcelDescription: '',
      customerToken: randomBytes(24).toString('hex'), customerTokenExpiresAt: new Date(0) },
    $unset: { destinationLocation: 1, customerAgreement: 1, driverAgreement: 1 },
  }, timestamps: false } })), { ordered: false });
  log('info', 'customer_retention_swept', { count: result.modifiedCount });
  return result.modifiedCount;
}
export function startPrivacyRetention() {
  let running = false;
  const tick = async () => {
    if (running) return; running = true;
    try { await sweepCustomerRetention(); } catch { log('error', 'customer_retention_failed', { code: 'server_error' }); }
    finally { running = false; }
  };
  void tick();
  const timer = setInterval(() => { void tick(); }, 60000); timer.unref();
  return () => clearInterval(timer);
}
