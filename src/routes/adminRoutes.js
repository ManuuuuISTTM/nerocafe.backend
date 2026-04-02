import { Router } from 'express';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import { Admin } from '../models/Admin.js';
import { Order } from '../models/Order.js';
import { MenuItem } from '../models/MenuItem.js';
import { Customer } from '../models/Customer.js';
import { OfferBanner } from '../models/OfferBanner.js';
import { getOrCreateShopSettings } from '../models/ShopSettings.js';
import { authAdmin } from '../middleware/authAdmin.js';
import { sendSMS, makeCall } from '../utils/smsPlaceholder.js';

const router = Router();

function signAdminToken(admin) {
  return jwt.sign({ sub: admin._id.toString() }, process.env.ADMIN_JWT_SECRET, { expiresIn: '1d' });
}

router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
    const admin = await Admin.findOne({ email });
    if (!admin || !(await admin.comparePassword(password))) {
      return res.status(401).json({ error: 'Invalid admin credentials' });
    }
    res.json({ admin: admin.toJSON(), token: signAdminToken(admin) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/me', authAdmin, (req, res) => {
  res.json({ admin: req.admin });
});

router.get('/stats', authAdmin, async (_req, res) => {
  try {
    const totalOrders = await Order.countDocuments({ cancelledAt: null });
    const activeOrders = await Order.countDocuments({
      cancelledAt: null,
      status: { $in: ['Pending', 'Preparing'] },
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

    res.json({
      totalOrders,
      revenue,
      activeOrders,
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
    const orders = await Order.find({ cancelledAt: null }).sort({ createdAt: -1 }).limit(200);
    res.json({ orders });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.patch('/orders/:id/status', authAdmin, async (req, res) => {
  try {
    const { status } = req.body;
    const allowed = ['Pending', 'Preparing', 'Ready'];
    if (!allowed.includes(status)) return res.status(400).json({ error: 'Invalid status' });
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
    }

    const io = req.app.get('io');
    const oid = order._id.toString();
    io?.to(`order:${oid}`).emit('order:status', { orderId: oid, status: order.status });
    io?.emit('orders:update', { type: 'status', orderId: oid });

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
    const io = req.app.get('io');
    io?.emit('orders:update', { type: 'cancelled', orderId: order._id });
    res.json({ ok: true, order });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/customers', authAdmin, async (req, res) => {
  try {
    const q = req.query.q?.trim();
    if (q) {
      const customers = await Customer.find({
        $or: [
          { name: new RegExp(q, 'i') },
          { phone: new RegExp(q.replace(/\D/g, ''), 'i') },
          { email: new RegExp(q, 'i') },
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
    const banner = await OfferBanner.create({ title, message, active });
    const io = req.app.get('io');
    io?.emit('banner:update');
    res.status(201).json({ banner });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.patch('/banners/:id', authAdmin, async (req, res) => {
  try {
    const banner = await OfferBanner.findByIdAndUpdate(req.params.id, req.body, { new: true });
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
      s.closedMessage = closedMessage.trim();
    }
    if (heroCardLabel !== undefined) {
      const t = String(heroCardLabel).trim();
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

/** Payment route placeholder */
router.post('/payments/razorpay-placeholder', authAdmin, (_req, res) => {
  // Integrate Razorpay here later
  res.json({ message: 'Integrate Razorpay here later', ok: false });
});

export default router;
