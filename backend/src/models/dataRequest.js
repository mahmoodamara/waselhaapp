import mongoose from 'mongoose';
export const DataRequest = mongoose.model('DataRequest', new mongoose.Schema({
  reference: { type: String, unique: true, required: true },
  type: { type: String, enum: ['recovery','access','deletion'], required: true },
  identifier: { type: String, maxlength: 80, required: true },
  contact: { type: String, maxlength: 160, required: true },
  status: { type: String, enum: ['pending','completed','rejected'], default: 'pending' },
  resolvedBy: mongoose.Schema.Types.ObjectId,
  verifiedUserId: mongoose.Schema.Types.ObjectId,
  resolvedAt: Date,
  expiresAt: { type: Date, required: true, index: { expireAfterSeconds: 0 } },
}, { timestamps: true }));
