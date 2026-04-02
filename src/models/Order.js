import mongoose from 'mongoose';

const STATUS = ['Pending', 'Preparing', 'Ready'];

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
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    trackingToken: { type: String, required: true, unique: true, index: true },
    items: [orderItemSchema],
    totalPrice: { type: Number, required: true, min: 0 },
    status: { type: String, enum: STATUS, default: 'Pending' },
    customer: {
      name: { type: String, required: true },
      phone: { type: String, required: true },
      email: { type: String, default: '' },
    },
    paymentMethod: { type: String, enum: ['COD', 'Razorpay'], default: 'COD' },
    // Integrate Razorpay here later — store paymentId, razorpay_order_id when integrated
    paymentMeta: { type: mongoose.Schema.Types.Mixed, default: {} },
    cancelledAt: { type: Date, default: null },
  },
  { timestamps: true }
);

export const ORDER_STATUSES = STATUS;
export const Order = mongoose.model('Order', orderSchema);
