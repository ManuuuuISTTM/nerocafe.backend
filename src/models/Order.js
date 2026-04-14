import mongoose from 'mongoose';

const STATUS = ['Pending', 'Preparing', 'Ready', 'Completed'];

const orderItemSchema = new mongoose.Schema(
  {
    menuItemId: { type: mongoose.Schema.Types.ObjectId, ref: 'MenuItem' },
    name: String,
    image: { type: String, default: '' },
    price: Number,
    quantity: { type: Number, required: true, min: 1 },
  },
  { _id: false }
);

const orderSchema = new mongoose.Schema(
  {
    orderNo: { type: Number, required: true, unique: true, sparse: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    trackingToken: { type: String, required: true, unique: true, index: true },
    items: [orderItemSchema],
    totalPrice: { type: Number, required: true, min: 0 },
    status: { type: String, default: 'Pending' },
    customer: {
      name: { type: String, required: true },
      phone: { type: String, required: true },
      email: { type: String, default: '' },
    },
    paymentMethod: { type: String, default: 'COD' },
    // Payment tracking: status and metadata (razorpay ids, refunds, etc.)
    paymentStatus: { type: String, enum: ['Pending', 'Completed', 'Failed', 'Refunded', 'Cash Pending'], default: 'Pending' },
    paymentMeta: { type: mongoose.Schema.Types.Mixed, default: {} },
    isOutOfRange: { type: Boolean, default: false },
    cancelledAt: { type: Date, default: null },
    cancellationReason: { type: String, default: '' },
    /* ── Location tracking ────────────────────────────────────── */
    location: {
      lat: { type: Number, default: null },
      lng: { type: Number, default: null },
      mapLink: { type: String, default: '' },
    },
  },
  { timestamps: true }
);

export const ORDER_STATUSES = STATUS;
export const Order = mongoose.model('Order', orderSchema);
