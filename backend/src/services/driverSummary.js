import mongoose from 'mongoose';
import { Order, DriverCashRecord } from '../models/index.js';
import { fail } from './validation.js';
import { SUMMARY_PAGE_SIZE } from '../../../shared/apiContract.js';

const zone = 'Asia/Jerusalem';
const owned = driverId => ({ $or: [
  { $eq: [{ $ifNull: ['$financialSnapshot', null] }, null] },
  { $eq: [{ $toString: '$financialSnapshot.driverId' }, String(driverId)] },
] });
const zero = value => ({ $ifNull: [value, 0] });
const sumIf = (condition, value) => ({ $sum: { $cond: [condition, zero(value), 0] } });
const earnings = { $ifNull: ['$financialSnapshot.driverEarningsAgorot', zero('$driverEarningsAgorot')] };
export async function driverCashHistory(driverId, { admin = false, cursor, limit = SUMMARY_PAGE_SIZE } = {}) {
  const size = Math.min(50, Math.max(1, Number(limit) || SUMMARY_PAGE_SIZE));
  let after;
  if (cursor) {
    try {
      const value = JSON.parse(Buffer.from(cursor, 'base64url').toString());
      if (!/^[a-f\d]{24}$/i.test(value.id) || !Number.isFinite(Date.parse(value.at))) throw Error();
      after = { id: new mongoose.Types.ObjectId(value.id), at: new Date(value.at) };
    } catch { fail('invalid_input'); }
  }
  const rows = await DriverCashRecord.find({ driverId, ...(after ? { $or: [{ createdAt: { $lt: after.at } }, { createdAt: after.at, _id: { $lt: after.id } }] } : {}) })
    .sort({ createdAt: -1, _id: -1 }).limit(size + 1).lean();
  const page = rows.slice(0,size), last = page.at(-1);
  return { items: admin ? page : page.map(({ note, recordedByAdminId, requestId, ...record }) => record),
    nextCursor: rows.length > size ? Buffer.from(JSON.stringify({ id:String(last._id), at:last.createdAt.toISOString() })).toString('base64url') : null };
}
export async function driverSummary(driverId, { admin = false, cursor, limit = SUMMARY_PAGE_SIZE } = {}) {
  const driver = new mongoose.Types.ObjectId(String(driverId));
  const pageSize = Math.min(50, Math.max(1, Number(limit) || 20));
  const match = { driverId: driver, status: 'delivered' };
  let after;
  if (cursor) {
    try {
      const value = JSON.parse(Buffer.from(cursor, 'base64url').toString());
      if (!/^[a-f\d]{24}$/i.test(value.id) || (value.at !== null && !Number.isFinite(Date.parse(value.at)))) throw Error();
      after = { id: new mongoose.Types.ObjectId(value.id), at: value.at === null ? null : new Date(value.at) };
    } catch { fail('invalid_input'); }
  }
  const historyFilter = { ...match, ...(after ? { $or: [
    { deliveredAt: { $lt: after.at } }, { deliveredAt: after.at, _id: { $lt: after.id } },
  ] } : {}) };
  const fulfilled = { $and: [owned(driverId), { $eq: ['$status', 'delivered'] }] };
  const handed = { $eq: ['$cashHandover.status', 'completed'] };
  const paid = { $eq: ['$driverPayout.status', 'completed'] };
  const today = { $dateTrunc: { date: '$$NOW', unit: 'day', timezone: zone } };
  const periods = Object.fromEntries(['today','week','month'].map(period => [period, [
    { $match: { $expr: { $and: [fulfilled, { $gte: ['$deliveredAt', period === 'today' ? today : period === 'week'
      ? { $dateSubtract: { startDate: today, unit: 'day', amount: 6, timezone: zone } }
      : { $dateTrunc: { date: '$$NOW', unit: 'month', timezone: zone } }] }] } } },
    { $group: { _id: { $dateTrunc: { date: '$deliveredAt', unit: 'day', timezone: zone } }, count: { $sum: 1 }, earningsAgorot: { $sum: earnings } } },
    { $sort: { _id: 1 } },
  ]]));
  const [aggregate, recordTotals, recent, records] = await Promise.all([
    Order.aggregate([{ $match: { driverId: driver } }, { $facet: {
      bounds: [{ $limit: 1 }, { $project: { today, week: { $dateSubtract: { startDate: today, unit: 'day', amount: 6, timezone: zone } }, month: { $dateTrunc: { date: '$$NOW', unit: 'month', timezone: zone } } } }],
      totals: [{ $group: { _id: null, deliveredCount: sumIf({ $eq: ['$status', 'delivered'] }, 1),
        cashCollectedAgorot: { $sum: zero('$actualCashCollectedAgorot') },
        earningsAgorot: sumIf(fulfilled, earnings),
        orderCash: sumIf({ $and: [owned(driverId), handed] }, '$cashHandover.amountAgorot'),
        orderPayments: sumIf({ $and: [fulfilled, paid] }, '$driverPayout.amountAgorot'),
        driverShortagePaidAgorot: sumIf({ $and: [fulfilled, handed,
          { $eq: ['$collectionAdjustment.status', 'resolved'] }, { $eq: ['$collectionAdjustment.resolutionType', 'driver_pays'] }] }, '$collectionAdjustment.amountAgorot'),
      } }], ...periods,
    } }]),
    DriverCashRecord.aggregate([{ $match: { driverId: driver } }, { $group: { _id: '$type', total: { $sum: '$amountAgorot' } } }]),
    Order.find(historyFilter).sort({ deliveredAt: -1, _id: -1 }).select('_id deliveredAt updatedAt serviceArea area driverEarningsAgorot financialSnapshot routeDistanceMeters actualCashCollectedAgorot driverPayout cashHandover').limit(pageSize + 1).lean(),
    driverCashHistory(driver, { admin, limit: pageSize }),
  ]);
  const totals = aggregate[0]?.totals[0] ?? {};
  const recordSum = type => recordTotals.find(r => r._id === type)?.total ?? 0;
  const cashCollectedAgorot = totals.cashCollectedAgorot ?? 0;
  const cashHandedOverAgorot = recordSum('cash_handover') + (totals.orderCash ?? 0);
  const paymentsAgorot = recordSum('driver_payment') + (totals.orderPayments ?? 0);
  const driverShortagePaidAgorot = totals.driverShortagePaidAgorot ?? 0;
  const page = recent.slice(0, pageSize), last = page.at(-1);
  const visible = page.filter(o => !o.financialSnapshot || String(o.financialSnapshot.driverId) === String(driverId));
  return {
    driverId, deliveredCount: totals.deliveredCount ?? 0, cashCollectedAgorot, cashHandedOverAgorot,
    paymentsAgorot, driverShortagePaidAgorot, earningsAgorot: totals.earningsAgorot ?? 0,
    cashHeldAgorot: cashCollectedAgorot + driverShortagePaidAgorot - cashHandedOverAgorot,
    unpaidEarningsAgorot: (totals.earningsAgorot ?? 0) - paymentsAgorot,
    timezone: zone,
    periods: Object.fromEntries(['today','week','month'].map(period => {
      const days = aggregate[0]?.[period] ?? [];
      return [period, { sinceAt: aggregate[0]?.bounds[0]?.[period] ?? null, count: days.reduce((n,d) => n+d.count, 0), earningsAgorot: days.reduce((n,d) => n+d.earningsAgorot, 0),
        days: days.map(d => ({ deliveredAt: d._id, driverEarningsAgorot: d.earningsAgorot })) }];
    })),
    records: records.items, nextRecordsCursor: records.nextCursor,
    deliveries: visible.map(o => ({ orderId: o._id, deliveredAt: o.deliveredAt ?? o.updatedAt ?? null, serviceArea: o.serviceArea ?? null,
      area: o.area ?? null, driverEarningsAgorot: o.financialSnapshot?.driverEarningsAgorot ?? o.driverEarningsAgorot ?? 0, routeDistanceMeters: o.routeDistanceMeters ?? null })),
    orderFinances: visible.filter(o => o.financialSnapshot).map(o => ({ orderId: o._id, actualCashCollectedAgorot: o.actualCashCollectedAgorot,
      driverEarningsAgorot: o.financialSnapshot.driverEarningsAgorot,
      driverPayout: { status: o.driverPayout.status, amountAgorot: o.driverPayout.amountAgorot },
      cashHandover: { status: o.cashHandover.status, ...(o.cashHandover.amountAgorot == null ? {} : { amountAgorot: o.cashHandover.amountAgorot }) } })),
    nextCursor: recent.length > pageSize ? Buffer.from(JSON.stringify({ id: String(last._id), at: last.deliveredAt?.toISOString() ?? null })).toString('base64url') : null,
  };
}
