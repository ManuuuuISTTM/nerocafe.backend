import { Router } from 'express';
import { Order } from '../models/Order.js';
import { authUser, requireUser } from '../middleware/authUser.js';
import { getOrCreateShopSettings } from '../models/ShopSettings.js';
import { createOrderFromBody } from '../utils/orderHelpers.js';
import { normalizePhone } from '../utils/phone.js';
import { sendUserPushNotification } from '../utils/pushNotifications.js';

const router = Router();

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
    const { items, customer, paymentMethod = 'Razorpay', isOutOfRange = false, location } = req.body;
    if (!items?.length || !customer?.name || !customer?.phone) {
      return res.status(400).json({ error: 'Items and customer name/phone required' });
    }
    
    console.log('[Order Creation] User placing order:', {
      userId: req.user._id,
      userName: req.user.name,
      customerName: customer.name,
      customerPhone: customer.phone,
      itemCount: items.length,
      total: items.reduce((sum, item) => sum + (item.quantity || 1), 0),
    });
    
    const io = req.app.get('io');
    const { order, trackingToken } = await createOrderFromBody({
      items,
      customer,
      paymentMethod,
      isOutOfRange,
      userId: req.user?._id,
      location,
      io,
    });
    
    console.log('[Order Creation] Order created successfully:', {
      orderId: order._id,
      orderNo: order.orderNo,
      userId: req.user._id,
      trackingToken: trackingToken.substring(0, 8) + '...',
    });
    
    const o = order.toObject();

    // Send Push Notification
    sendUserPushNotification(req.user._id, 'Order Placed! 🍕', {
      body: `Your order #${order.orderNo} has been received. We'll start preparing it soon!`,
      data: { url: `/track/${order._id}` },
      tag: `order-${order._id}`,
    }).catch(e => console.error('[Push] Order create notify error:', e.message));

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
    order.cancellationReason = String(reason).slice(0, 300);
    await order.save();
    const io = req.app.get('io');
    const oid = order._id.toString();
    io?.to(`order:${oid}`).emit('order:status', { orderId: oid, status: 'Cancelled' });
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

// Get tracking info for a user's specific order (by ID, user must own the order)
router.get('/track/:id/user', authUser, requireUser, async (req, res) => {
  try {
    const order = await Order.findOne({
      _id: req.params.id,
      userId: req.user._id, // Only allow user to see their own order
    });
    if (!order) return res.status(404).json({ error: 'Order not found or does not belong to you' });
    
    res.json({ 
      order,
      trackingToken: order.trackingToken // Return token for customer use
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Fallback: Get orders by phone number (useful if userId isn't set correctly)
router.get('/by-phone/:phone', async (req, res) => {
  try {
    const normPhone = normalizePhone(req.params.phone);
    console.log('[Orders ByPhone] Fetching orders by phone:', { 
      rawPhone: req.params.phone, 
      normPhone,
      timestamp: new Date().toISOString(),
    });
    
    if (!normPhone) {
      return res.status(400).json({ error: 'Invalid phone number' });
    }
    
    // Find all orders with this phone number
    const orders = await Order.find({
      'customer.phone': normPhone,
      cancelledAt: null,
    }).sort({ createdAt: -1 });
    
    console.log('[Orders ByPhone] Query results:', { 
      phone: normPhone, 
      count: orders.length,
      statuses: orders.map(o => o.status),
    });
    
    if (!orders.length) {
      return res.status(404).json({ 
        error: 'No active orders found for this phone number',
        phone: normPhone,
      });
    }
    
    // Return the most recent active order
    const active = orders.filter(o => o.status !== 'Completed');
    const pending = active.length > 0 ? active[0] : orders[0];
    
    console.log('[Orders ByPhone] Returning order:', {
      orderId: pending._id,
      orderNo: pending.orderNo,
      status: pending.status,
      userId: pending.userId,
      createdAt: pending.createdAt,
    });
    
    res.json({ 
      order: pending,
      trackingToken: pending.trackingToken,
      total: orders.length,
      message: `Found ${orders.length} order(s) for this phone number`
    });
  } catch (e) {
    console.error('[Orders ByPhone] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

export default router;
