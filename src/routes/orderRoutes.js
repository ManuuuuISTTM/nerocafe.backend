import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { Order } from '../models/Order.js';
import { MenuItem } from '../models/MenuItem.js';
import { Customer } from '../models/Customer.js';
import { Counter } from '../models/Counter.js';
import { getOrCreateShopSettings } from '../models/ShopSettings.js';
import { authUser, requireUser } from '../middleware/authUser.js';
import { sendOrderConfirmationEmail } from '../utils/emailPlaceholder.js';
import { sendPaymentSuccessMessage } from '../utils/whatsapp.js';
import { normalizePhone } from '../utils/phone.js';
import { User } from '../models/User.js';

const router = Router();

async function upsertCustomer({ name, phone, email, userId }) {
  const normPhone = normalizePhone(phone);
  let c = await Customer.findOne({ phone: normPhone });
  if (c) {
    c.name = name;
    if (email) c.email = email;
    if (userId) c.userId = userId;
    c.orderCount = (c.orderCount || 0) + 1;
    await c.save();
    return c;
  }
  return Customer.create({
    name,
    phone: normPhone,
    email: email || '',
    userId: userId || null,
    orderCount: 1,
  });
}

async function createOrderFromBody({ items, customer, paymentMethod, isOutOfRange, userId, io }) {
  let total = 0;
  const lineItems = [];
  for (const line of items) {
    const menu = await MenuItem.findById(line.menuItemId);
    if (!menu || !menu.available) continue;
    const qty = Math.max(1, Number(line.quantity) || 1);
    total += menu.price * qty;
    lineItems.push({
      menuItemId: menu._id,
      name: menu.name,
      image: menu.image || '',
      price: menu.price,
      quantity: qty,
    });
  }
  if (!lineItems.length) throw new Error('No valid items');

  const trackingToken = uuidv4();
  const orderNo = await Counter.getNextValue('orderNumber');

  const order = await Order.create({
    orderNo,
    userId: userId || null,
    trackingToken,
    items: lineItems,
    totalPrice: total,
    status: 'Pending',
    customer: {
      name: customer.name,
      phone: normalizePhone(customer.phone),
      email: customer.email || '',
    },
    paymentMethod: paymentMethod || 'Razorpay',
    isOutOfRange: !!isOutOfRange,
  });

  await upsertCustomer({
    name: customer.name,
    phone: customer.phone,
    email: customer.email,
    userId: userId || null,
  });

  for (const li of lineItems) {
    await MenuItem.updateOne({ _id: li.menuItemId }, { $inc: { orderCount: li.quantity } });
  }

  if (customer.email) {
    await sendOrderConfirmationEmail({
      to: customer.email,
      name: customer.name,
      orderNo: order.orderNo,
      total,
    });
  }

  // Confirmation message for all orders (verified Razorpay)
  let targetPhone = customer.phone;
  if (userId) {
    const user = await User.findById(userId);
    if (user && user.phone) targetPhone = user.phone;
  }
  if (targetPhone) {
    sendPaymentSuccessMessage(targetPhone, customer.name, order.orderNo, order._id, order.trackingToken);
  }

  io?.emit('orders:update', { type: 'created', orderId: order._id });
  return { order, trackingToken };
}

/** Logged-in users only */
router.post('/', authUser, requireUser, async (req, res) => {
  try {
    const settings = await getOrCreateShopSettings();
    if (!settings.shopOpen) {
      return res.status(403).json({
        error: settings.closedMessage || 'The cafe is closed. Try again tomorrow.',
        shopClosed: true,
      });
    }
    const { items, customer, paymentMethod = 'Razorpay', isOutOfRange = false } = req.body;
    if (!items?.length || !customer?.name || !customer?.phone) {
      return res.status(400).json({ error: 'Items and customer name/phone required' });
    }
    // Prevent multiple active/pending orders per user
    const existing = await Order.findOne({ userId: req.user._id, status: 'Pending', cancelledAt: null });
    if (existing) {
      return res.status(400).json({ error: 'An active order already exists for this user' });
    }
    const io = req.app.get('io');
    const { order, trackingToken } = await createOrderFromBody({
      items,
      customer,
      paymentMethod,
      isOutOfRange,
      userId: req.user?._id,
      io,
    });
    const o = order.toObject();
    res.status(201).json({ order: o, trackingToken });
  } catch (e) {
    const msg = e.message === 'No valid items' ? e.message : e.message;
    const code = e.message === 'No valid items' ? 400 : 500;
    res.status(code).json({ error: msg });
  }
});

router.get('/track/:id', async (req, res) => {
  try {
    const token = req.query.token || req.headers['x-tracking-token'];
    if (!token) return res.status(400).json({ error: 'Tracking token required' });
    const order = await Order.findOne({
      _id: req.params.id,
      trackingToken: token,
      cancelledAt: null,
    });
    if (!order) return res.status(404).json({ error: 'Order not found' });
    res.json({ order });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/track/:id/cancel', async (req, res) => {
  try {
    const token = req.body.token || req.query.token;
    const reason = req.body.reason || '';
    if (!token) return res.status(400).json({ error: 'Tracking token required' });
    const order = await Order.findOne({ _id: req.params.id, trackingToken: token });
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.cancelledAt) return res.status(400).json({ error: 'Already cancelled' });
    if (order.status !== 'Pending') {
      return res.status(400).json({ error: 'Only pending orders can be cancelled' });
    }
    order.cancelledAt = new Date();
    order.cancellationReason = reason;
    await order.save();
    const io = req.app.get('io');
    io?.emit('orders:update', { type: 'cancelled', orderId: order._id });
    res.json({ ok: true, order });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/me', authUser, requireUser, async (req, res) => {
  try {
    // Get all orders for the user, sorted by newest first
    const orders = await Order.find({ userId: req.user._id }).sort({ createdAt: -1 });
    res.json({ orders });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
