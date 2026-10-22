import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { DataRequest } from '../models/dataRequest.js';
import { rateLimit } from '../services/rateLimit.js';
import { string, fail } from '../services/validation.js';
const router = Router();
router.post('/', rateLimit(5, 60 * 60 * 1000), async (req, res) => {
  const { type, identifier, contact, ...extra } = req.body;
  if (Object.keys(extra).length || !['recovery','access','deletion'].includes(type)) fail('invalid_input');
  const safeContact = string(contact, true, 160);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(safeContact) && !/^\+?[\d ()-]{7,30}$/.test(safeContact)) fail('invalid_input');
  const reference = randomUUID();
  await DataRequest.create({ reference, type, identifier: string(identifier, true, 80), contact: safeContact,
    expiresAt: new Date(Date.now() + 90 * 86400000) });
  // No account lookup or existence signal; never expose a public status endpoint.
  res.status(202).json({ reference });
});
export default router;
