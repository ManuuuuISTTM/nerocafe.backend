import { Router } from 'express';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { Admin } from '../models/Admin.js';
import { Order } from '../models/Order.js';
import { MenuItem } from '../models/MenuItem.js';
import { Customer } from '../models/Customer.js';
import { OfferBanner } from '../models/OfferBanner.js';
import { RefreshToken } from '../models/RefreshToken.js';
import { getOrCreateShopSettings } from '../models/ShopSettings.js';
import { authAdmin } from '../middleware/authAdmin.js';
import { authLimiter } from '../middleware/rateLimiter.js';
import { sendSMS, makeCall } from '../utils/smsPlaceholder.js';
import { sendPaymentSuccessMessage, sendOrderReadyMessage, sendCancellationMessage } from '../utils/whatsapp.js';
import { sendInvoiceEmail } from '../utils/emailPlaceholder.js';
import { createOrderFromBody } from '../utils/orderHelpers.js';
import { User } from '../models/User.js';
import { normalizePhone } from '../utils/phone.js';
import { sendUserPushNotification } from '../utils/pushNotifications.js';

const router = Router();

const ADMIN_ACCESS_EXPIRY = '30m';

function signAdminToken(admin) {
  return jwt.sign(
    { sub: admin._id.toString(), type: 'access', v: admin.tokenVersion || 0 },
    process.env.ADMIN_JWT_SECRET,
    { expiresIn: ADMIN_ACCESS_EXPIRY }
  );
}

async function issueAdminTokenPair(admin, deviceInfo = '') {
  const accessToken = signAdminToken(admin);
  const refreshToken = await RefreshToken.createForUser(admin._id, 'admin', deviceInfo);
  return { accessToken, refreshToken };
}

function computeFingerprint(ip, ua) {
  const raw = `${ip}__${ua}`;
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 32);
}

/* ── Admin Login ──────────────────────────────────────────────── */
router.post('/login', authLimiter, async (req, res) => {
  try {
    const { email, password, fingerprint: clientFingerprint } = req.body;
    if (!email) return res.status(400).json({ error: 'Email required' });

    const admin = await Admin.findOne({ email: email.toLowerCase().trim() });
    if (!admin) return res.status(401).json({ error: 'Invalid admin credentials' });

    const ip = req.headers['x-forwarded-for'] || req.ip || '';
    const ua = req.headers['user-agent'] || '';
    const fp = clientFingerprint || computeFingerprint(ip, ua);

    /* Check if this device is trusted (auto-login) */
    const trustedIdx = (admin.trustedDevices || []).findIndex(d => d.fingerprint === fp);
    const isTrusted = trustedIdx >= 0;

    if (!isTrusted) {
      /* New device → require password */
      if (!password) return res.status(400).json({ error: 'Password required for new device' });
      if (!(await admin.comparePassword(password))) {
        return res.status(401).json({ error: 'Invalid admin credentials' });
      }
      /* Save new trusted device */
      const label = ua.includes('Mobile') ? 'Mobile Browser' :
                    ua.includes('Chrome') ? 'Chrome Desktop' :
                    ua.includes('Firefox') ? 'Firefox Desktop' : 'Unknown Browser';
      if (!admin.trustedDevices) admin.trustedDevices = [];
      admin.trustedDevices.push({ fingerprint: fp, label, lastUsed: new Date(), ip: String(ip).slice(0, 45) });
      await admin.save();
    } else {
      /* Trusted device → update lastUsed */
      admin.trustedDevices[trustedIdx].lastUsed = new Date();
      admin.trustedDevices[trustedIdx].ip = String(ip).slice(0, 45);
      await admin.save();
    }

    const deviceInfo = ua;
    const { accessToken, refreshToken } = await issueAdminTokenPair(admin, deviceInfo);
    res.json({ admin: admin.toJSON(), token: accessToken, refreshToken, trustedDevice: isTrusted });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ── Check trusted device (auto-login probe) ──────────────────── */
router.post('/check-device', authLimiter, async (req, res) => {
  try {
    const { email, fingerprint: clientFingerprint } = req.body;
    if (!email) return res.status(400).json({ trusted: false });

    const admin = await Admin.findOne({ email: email.toLowerCase().trim() });
    if (!admin) return res.status(200).json({ trusted: false });

    const ip = req.headers['x-forwarded-for'] || req.ip || '';
    const ua = req.headers['user-agent'] || '';
    const fp = clientFingerprint || computeFingerprint(ip, ua);

    const trusted = (admin.trustedDevices || []).some(d => d.fingerprint === fp);
    res.json({ trusted });
  } catch {
    res.json({ trusted: false });
  }
});

/* ── Admin refresh token ──────────────────────────────────────── */
router.post('/refresh', async (req, res) => {
  try {
    const { refreshToken: rt } = req.body;
    if (!rt) return res.status(400).json({ error: 'Refresh token required' });

    const doc = await RefreshToken.verifyToken(rt, 'admin');
    if (!doc) return res.status(401).json({ error: 'Invalid or expired refresh token' });

    const admin = await Admin.findById(doc.userId);
    if (!admin) {
      await RefreshToken.revokeToken(rt);
      return res.status(401).json({ error: 'Admin not found' });
    }

    await RefreshToken.revokeToken(rt);
    const deviceInfo = req.headers['user-agent'] || '';
    const { accessToken, refreshToken } = await issueAdminTokenPair(admin, deviceInfo);
    res.json({ token: accessToken, refreshToken });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ── Logout from all devices ──────────────────────────────────── */
router.post('/logout-all', authAdmin, async (req, res) => {
  try {
    await RefreshToken.revokeAllForUser(req.admin._id, 'admin');
    const admin = await Admin.findById(req.admin._id);
    if (admin) {
      admin.trustedDevices = [];
      admin.tokenVersion = (admin.tokenVersion || 0) + 1;
      await admin.save();
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ── Trusted devices management ───────────────────────────────── */
router.get('/trusted-devices', authAdmin, async (req, res) => {
  try {
    const admin = await Admin.findById(req.admin._id);
    res.json({ devices: admin?.trustedDevices || [] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete('/trusted-devices/:fingerprint', authAdmin, async (req, res) => {
  try {
    const admin = await Admin.findById(req.admin._id);
    if (!admin) return res.status(404).json({ error: 'Admin not found' });
    admin.trustedDevices = (admin.trustedDevices || []).filter(d => d.fingerprint !== req.params.fingerprint);
    await admin.save();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ── Admin info ───────────────────────────────────────────────── */

router.get('/me', authAdmin, (req, res) => {
  res.json({ admin: req.admin });
});

router.get('/stats', authAdmin, async (_req, res) => {
  try {
    const totalOrders = await Order.countDocuments({ cancelledAt: null });
    const activeOrders = await Order.countDocuments({
      cancelledAt: null,
      status: { $in: ['Pending', 'Preparing', 'Ready'] },
    });
    const completedOrders = await Order.countDocuments({
      cancelledAt: null,
      status: 'Completed',
    });
    const revenueAgg = await Order.aggregate([
      { $match: { cancelledAt: null } },
      { $group: { _id: null, total: { $sum: '$totalPrice' } } },
    ]);
    const revenue = revenueAgg[0]?.total || 0;

    const popularAgg = await Order.aggregate([
      { $match: { cancelledAt: null } },
      { $unwind: '$items' },
      {
        $group: {
          _id: '$items.name',
          count: { $sum: '$items.quantity' },
        },
      },
      { $sort: { count: -1 } },
      { $limit: 6 },
    ]);

    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 6);
    sevenDaysAgo.setHours(0, 0, 0, 0);
    const dailyAgg = await Order.aggregate([
      { $match: { cancelledAt: null, createdAt: { $gte: sevenDaysAgo } } },
      {
        $group: {
          _id: {
            y: { $year: '$createdAt' },
            m: { $month: '$createdAt' },
            d: { $dayOfMonth: '$createdAt' },
          },
          orders: { $sum: 1 },
          revenue: { $sum: '$totalPrice' },
        },
      },
      { $sort: { '_id.y': 1, '_id.m': 1, '_id.d': 1 } },
    ]);

    const topCustomersAgg = await Order.aggregate([
      { $match: { cancelledAt: null } },
      {
        $group: {
          _id: {
            name: '$customer.name',
            phone: '$customer.phone',
            email: '$customer.email',
          },
          orders: { $sum: 1 },
          spent: { $sum: '$totalPrice' },
        },
      },
      { $sort: { spent: -1 } },
      { $limit: 6 },
    ]);

    const statusAgg = await Order.aggregate([
      { $match: { cancelledAt: null } },
      {
        $group: {
          _id: '$status',
          count: { $sum: 1 },
        },
      },
    ]);
    res.json({
      totalOrders,
      revenue,
      activeOrders,
      completedOrders,
      statusDistribution: statusAgg.map((s) => ({ name: s._id, value: s.count })),
      popularItems: popularAgg.map((p) => ({ name: p._id, count: p.count })),
      dailyOrders: dailyAgg.map((d) => ({
        day: `${String(d._id.d).padStart(2, '0')}/${String(d._id.m).padStart(2, '0')}`,
        orders: d.orders,
        revenue: Math.round(d.revenue),
      })),
      topCustomers: topCustomersAgg.map((c) => ({
        name: c._id.name || 'Guest',
        phone: c._id.phone || '',
        email: c._id.email || '',
        orders: c.orders,
        spent: Math.round(c.spent),
      })),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/orders', authAdmin, async (_req, res) => {
  try {
    // Fetch all orders including canceled ones for history view
    const orders = await Order.find({}).sort({ createdAt: -1 }).limit(500);
    res.json({ orders });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Check if a customer has pending orders (by phone)
router.get('/orders/check-pending/:phone', authAdmin, async (req, res) => {
  try {
    const phone = normalizePhone(req.params.phone);
    const pendingOrders = await Order.find({
      'customer.phone': phone,
      status: 'Pending',
      cancelledAt: null,
    }).sort({ createdAt: -1 });

    const hasPending = pendingOrders.length > 0;
    
    res.json({
      hasPending,
      count: pendingOrders.length,
      orders: hasPending ? pendingOrders.map(o => ({
        _id: o._id,
        orderNo: o.orderNo,
        status: o.status,
        createdAt: o.createdAt,
        totalPrice: o.totalPrice,
        items: o.items,
      })) : [],
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * POST /admin/orders
 * Create a manual order (Reception)
 */
router.post('/orders', authAdmin, async (req, res) => {
  try {
    const { items, customer, paymentMethod = 'COD', notes } = req.body;
    if (!items?.length || !customer?.name || !customer?.phone) {
      return res.status(400).json({ error: 'Items and customer name/phone required' });
    }

    // Optional: Search for existing user to link
    const normPhone = normalizePhone(customer.phone);
    let existingUser = await User.findOne({ phone: normPhone });
    
    // Fallback: If not found by normalized phone, try searching with different normalization patterns
    if (!existingUser) {
      console.log('[Admin Order] User lookup by normalized phone failed, trying raw phone:', {
        normPhone,
        rawPhone: customer.phone,
      });
      
      // Try searching all users and normalize both sides
      const allUsers = await User.find({}).lean();
      existingUser = allUsers.find(u => normalizePhone(u.phone) === normPhone);
      
      if (existingUser) {
        existingUser = await User.findById(existingUser._id); // Re-fetch to get full document
        console.log('[Admin Order] User found via fallback normalization:', {
          userId: existingUser._id,
          storedPhone: existingUser.phone,
          normalizedMatch: normalizePhone(existingUser.phone),
        });
      }
    }

    // Check if customer already has a pending order
    const existingPendingOrder = await Order.findOne({
      'customer.phone': normPhone,
      status: 'Pending',
      cancelledAt: null,
    });

    const io = req.app.get('io');
    const { order, trackingToken } = await createOrderFromBody({
      items,
      customer,
      paymentMethod,
      isOutOfRange: false, // Manual orders are always in-range
      userId: existingUser?._id,
      location: null,
      io,
    });

    if (notes) {
      order.notes = notes;
      await order.save();
    }

    console.log('[Admin Order] Created manual order:', {
      orderId: order._id,
      orderNo: order.orderNo,
      customerName: customer.name,
      customerPhone: normPhone,
      hasUser: !!existingUser,
      userId: existingUser?._id,
      trackingToken: trackingToken.substring(0, 8) + '...',
    });

    // Emit real-time notification to customer if they have a user account
    if (existingUser) {
      console.log('[Admin Order] Emitting order:created to user room:', {
        userId: existingUser._id,
        room: `user:${existingUser._id}`,
      });
      
      io?.to(`user:${existingUser._id}`).emit('order:created', {
        orderId: order._id,
        orderNo: order.orderNo,
        totalPrice: order.totalPrice,
        status: order.status,
        createdAt: order.createdAt,
        items: order.items,
        customerName: order.customer?.name,
        trackingToken: trackingToken, // Include token so customer can track
      });

      // Send Push Notification
      sendUserPushNotification(existingUser._id, 'Order Placed!', {
        body: `Your order #${order.orderNo} has been placed successfully for ₹${order.totalPrice}.`,
        data: { url: `/track/${order._id}` },
        tag: `order-${order._id}`,
      }).catch(e => console.error('[Push] Manual order create notify error:', e.message));

      // Send WhatsApp notification to customer about their order
      try {
        const trackLink = `${process.env.CLIENT_URL || 'https://nerocafe.com'}/track/${order._id}`;
        const message = `Hi ${customer.name}! 🎉 Your order #${order.orderNo} has been placed for ₹${order.totalPrice}. Track it here: ${trackLink}`;
        sendPaymentSuccessMessage(normPhone, customer.name, order.orderNo, order._id, trackingToken);
        console.log('[Admin Order] WhatsApp notification sent to:', normPhone);
      } catch (e) {
        console.warn('[Admin Order] Failed to send WhatsApp notification:', e.message);
      }
    } else {
      console.log('[Admin Order] No registered user found for phone:', normPhone);
    }

    // Also send a broadcast notification about the order
    io?.emit('admin:order-created', {
      orderId: order._id,
      customerPhone: normPhone,
      customerName: customer.name,
      totalPrice: order.totalPrice,
    });

    res.status(201).json({
      order,
      trackingToken,
      // Alert admin if customer has other pending orders
      customerHasPendingOrder: !!existingPendingOrder,
      pendingOrderInfo: existingPendingOrder ? {
        orderId: existingPendingOrder._id,
        orderNo: existingPendingOrder.orderNo,
        createdAt: existingPendingOrder.createdAt,
        status: existingPendingOrder.status,
      } : null,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Add items to a pending order (admin)
router.patch('/orders/:id/items', authAdmin, async (req, res) => {
  try {
    const { items } = req.body; // [{ menuItemId, quantity }]
    if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'Items required' });
    const order = await Order.findOne({ _id: req.params.id, cancelledAt: null });
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.status !== 'Pending') return res.status(400).json({ error: 'Only pending orders can be modified' });

    let total = order.totalPrice || 0;
    for (const it of items) {
      if (!it.menuItemId) continue;
      const m = await MenuItem.findById(it.menuItemId);
      if (!m || !m.available) continue;
      const qty = Math.max(1, Number(it.quantity) || 1);
      total += m.price * qty;
      order.items.push({
        menuItemId: m._id,
        name: m.name,
        image: m.image || '',
        price: m.price,
        quantity: qty,
      });
      await MenuItem.updateOne({ _id: m._id }, { $inc: { orderCount: qty } });
    }
    order.totalPrice = Math.round(total);
    await order.save();
    const io = req.app.get('io');
    io?.emit('orders:update', { type: 'modified', orderId: order._id });
    res.json({ order });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Update payment info/status for an order (admin)
router.patch('/orders/:id/payment', authAdmin, async (req, res) => {
  try {
    const { paymentStatus, paymentMeta } = req.body; // paymentStatus: 'Completed'|'Failed'|'Refunded'
    const allowed = ['Pending', 'Completed', 'Failed', 'Refunded', 'Cash Pending'];
    if (paymentStatus && !allowed.includes(paymentStatus)) return res.status(400).json({ error: 'Invalid payment status' });
    const order = await Order.findOne({ _id: req.params.id });
    if (!order) return res.status(404).json({ error: 'Order not found' });

    if (paymentMeta && typeof paymentMeta === 'object') {
      order.paymentMeta = { ...(order.paymentMeta || {}), ...paymentMeta };
    }
    if (paymentStatus) order.paymentStatus = paymentStatus;

    // If admin marks refunded, also set cancelledAt if not already
    if (paymentStatus === 'Refunded' && !order.cancelledAt) {
      order.cancelledAt = new Date();
    }

    await order.save();
    const io = req.app.get('io');
    io?.emit('orders:update', { type: 'payment', orderId: order._id });
    res.json({ order });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.patch('/orders/:id/status', authAdmin, async (req, res) => {
  try {
    const { status } = req.body;
    const allowed = ['Pending', 'Preparing', 'Ready', 'Completed'];
    if (!status || !allowed.includes(status)) {
      return res.status(400).json({ error: `Invalid status. Allowed: ${allowed.join(', ')}` });
    }
    
    const order = await Order.findOne({ _id: req.params.id, cancelledAt: null });
    if (!order) return res.status(404).json({ error: 'Order not found' });

    const prev = order.status;
    order.status = status;
    await order.save();

    const phone = order.customer?.phone;
    if (phone && status === 'Preparing' && prev !== 'Preparing') {
      await sendSMS('Preparing', phone, { orderId: order._id });
    }
    if (phone && status === 'Ready' && prev !== 'Ready') {
      await sendSMS('Ready', phone, { orderId: order._id });
      // Future: Twilio voice / click-to-call — wire makeCall when provider is ready
      await makeCall(phone);
      // Send WhatsApp notification when order is ready
      try {
        const result = await sendOrderReadyMessage(phone, order.customer?.name || 'Customer', order.orderNo);
        if (!result.ok) {
          console.warn('WhatsApp send failed:', result.error);
        }
      } catch (e) {
        console.warn('WhatsApp send failed', e.message || e);
      }
      // Send invoice email when order is ready (if email provided)
      try {
        if (order.customer?.email) {
          await sendInvoiceEmail({
            to: order.customer.email,
            name: order.customer.name,
            orderId: order._id,
            total: order.totalPrice,
          });
        }
      } catch (e) {
        console.warn('Invoice send failed', e.message || e);
      }
    }

    const io = req.app.get('io');
    const oid = order._id.toString();
    io?.to(`order:${oid}`).emit('order:status', { orderId: oid, status: order.status });
    io?.emit('orders:update', { type: 'status', orderId: oid });

    // Send Push Notification if user is linked
    if (order.userId) {
      let pushTitle = 'Order Update';
      let pushBody = `Your order #${order.orderNo} is now ${status}.`;
      
      if (status === 'Preparing') {
        pushTitle = '🔥 Preparing Your Order';
        pushBody = `Hang tight! We've started preparing your order #${order.orderNo}.`;
      } else if (status === 'Ready') {
        pushTitle = '☕ Order Ready!';
        pushBody = `Your order #${order.orderNo} is ready for pickup! See you soon.`;
      } else if (status === 'Completed') {
        pushTitle = '✨ Enjoy your meal!';
        pushBody = `Order #${order.orderNo} has been completed. Hope you like it!`;
      }

      sendUserPushNotification(order.userId, pushTitle, {
        body: pushBody,
        data: { url: `/track/${order._id}` },
        tag: `order-${order._id}`,
      }).catch(e => console.error('[Push] Status update notify error:', e.message));
    }

    res.json({ order });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/orders/:id/cancel', authAdmin, async (req, res) => {
  try {
    const order = await Order.findOne({ _id: req.params.id, cancelledAt: null });
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.status !== 'Pending') {
      return res.status(400).json({ error: 'Only pending orders can be cancelled' });
    }
    order.cancelledAt = new Date();
    await order.save();
    
    // Send WhatsApp cancellation message to customer
    const phone = order.customer?.phone;
    if (phone) {
      try {
        await sendCancellationMessage(phone, order.customer?.name || 'Customer', order.orderNo);
      } catch (e) {
        console.warn('Failed to send cancellation WhatsApp message:', e.message || e);
      }
    }
    
    const io = req.app.get('io');
    const oid = order._id.toString();
    io?.to(`order:${oid}`).emit('order:status', { orderId: oid, status: 'Cancelled' });
    io?.emit('orders:update', { type: 'cancelled', orderId: order._id });

    // Send Push notification for cancellation
    if (order.userId) {
      sendUserPushNotification(order.userId, 'Order Cancelled', {
        body: `Your order #${order.orderNo} has been cancelled.`,
        data: { url: `/track/${order._id}` },
        tag: `order-${order._id}`,
      }).catch(e => console.error('[Push] Cancel notify error:', e.message));
    }

    res.json({ ok: true, order });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Delete a single order
router.delete('/orders/:id', authAdmin, async (req, res) => {
  try {
    const order = await Order.findByIdAndDelete(req.params.id);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    const io = req.app.get('io');
    io?.emit('orders:update', { type: 'deleted', orderId: order._id });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Bulk delete orders
router.post('/orders/bulk/delete', authAdmin, async (req, res) => {
  try {
    const { orderIds } = req.body;
    if (!Array.isArray(orderIds) || !orderIds.length) {
      return res.status(400).json({ error: 'Order IDs array required' });
    }
    const result = await Order.deleteMany({ _id: { $in: orderIds } });
    const io = req.app.get('io');
    io?.emit('orders:update', { type: 'bulk_deleted', count: result.deletedCount });
    res.json({ ok: true, deletedCount: result.deletedCount });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/customers', authAdmin, async (req, res) => {
  try {
    const q = req.query.q?.trim();
    if (q) {
      const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const customers = await Customer.find({
        $or: [
          { name: new RegExp(escaped, 'i') },
          { phone: new RegExp(escaped.replace(/\D/g, ''), 'i') },
          { email: new RegExp(escaped, 'i') },
        ],
      })
        .limit(20)
        .sort({ updatedAt: -1 });
      return res.json({ customers });
    }
    const customers = await Customer.find().sort({ updatedAt: -1 }).limit(100);
    res.json({ customers });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete('/customers/:id', authAdmin, async (req, res) => {
  try {
    const c = await Customer.findByIdAndDelete(req.params.id);
    if (!c) return res.status(404).json({ error: 'Customer not found' });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/banners', authAdmin, async (_req, res) => {
  try {
    const banners = await OfferBanner.find().sort({ createdAt: -1 });
    res.json({ banners });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/banners', authAdmin, async (req, res) => {
  try {
    const { title, message, active = true } = req.body;
    if (!title || !message) return res.status(400).json({ error: 'Title and message required' });
    const banner = await OfferBanner.create({ title: String(title).slice(0, 200), message: String(message).slice(0, 500), active });
    const io = req.app.get('io');
    io?.emit('banner:update');
    res.status(201).json({ banner });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.patch('/banners/:id', authAdmin, async (req, res) => {
  try {
    const { title, message, active } = req.body;
    const updates = {};
    if (title !== undefined) updates.title = String(title).slice(0, 200);
    if (message !== undefined) updates.message = String(message).slice(0, 500);
    if (active !== undefined) updates.active = !!active;
    const banner = await OfferBanner.findByIdAndUpdate(req.params.id, updates, { new: true });
    if (!banner) return res.status(404).json({ error: 'Not found' });
    const io = req.app.get('io');
    io?.emit('banner:update');
    res.json({ banner });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.delete('/banners/:id', authAdmin, async (req, res) => {
  try {
    await OfferBanner.findByIdAndDelete(req.params.id);
    const io = req.app.get('io');
    io?.emit('banner:update');
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/shop', authAdmin, async (_req, res) => {
  try {
    const s = await getOrCreateShopSettings();
    let heroMenuItem = null;
    if (s.heroMenuItemId) {
      const m = await MenuItem.findById(s.heroMenuItemId).lean();
      if (m) {
        heroMenuItem = {
          _id: m._id,
          name: m.name,
          price: m.price,
          category: m.category,
          image: m.image || '',
        };
      }
    }
    res.json({
      shopOpen: s.shopOpen,
      closedMessage: s.closedMessage,
      heroCardLabel: s.heroCardLabel || "Tonight's pick",
      heroMenuItemId: s.heroMenuItemId ? s.heroMenuItemId.toString() : null,
      heroMenuItem,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.patch('/shop', authAdmin, async (req, res) => {
  try {
    const { shopOpen, closedMessage, heroCardLabel, heroMenuItemId } = req.body;
    const s = await getOrCreateShopSettings();
    if (typeof shopOpen === 'boolean') s.shopOpen = shopOpen;
    if (typeof closedMessage === 'string' && closedMessage.trim()) {
      s.closedMessage = closedMessage.trim().slice(0, 300);
    }
    if (heroCardLabel !== undefined) {
      const t = String(heroCardLabel).trim().slice(0, 100);
      s.heroCardLabel = t || "Tonight's pick";
    }
    if (heroMenuItemId !== undefined) {
      if (heroMenuItemId === null || heroMenuItemId === '') {
        s.heroMenuItemId = null;
      } else if (mongoose.isValidObjectId(heroMenuItemId)) {
        const exists = await MenuItem.findById(heroMenuItemId);
        if (!exists) return res.status(400).json({ error: 'Menu item not found' });
        s.heroMenuItemId = heroMenuItemId;
      } else {
        return res.status(400).json({ error: 'Invalid menu item id' });
      }
    }
    await s.save();
    const io = req.app.get('io');
    io?.emit('shop:update');
    let heroMenuItem = null;
    if (s.heroMenuItemId) {
      const m = await MenuItem.findById(s.heroMenuItemId).lean();
      if (m) {
        heroMenuItem = {
          _id: m._id,
          name: m.name,
          price: m.price,
          category: m.category,
          image: m.image || '',
        };
      }
    }
    res.json({
      shopOpen: s.shopOpen,
      closedMessage: s.closedMessage,
      heroCardLabel: s.heroCardLabel || "Tonight's pick",
      heroMenuItemId: s.heroMenuItemId ? s.heroMenuItemId.toString() : null,
      heroMenuItem,
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

export default router;
