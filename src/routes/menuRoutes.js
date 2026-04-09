import { Router } from 'express';
import { MenuItem } from '../models/MenuItem.js';
import { Order } from '../models/Order.js';
import { authAdmin } from '../middleware/authAdmin.js';

const router = Router();

router.get('/', async (req, res) => {
  try {
    const { category, search, tag } = req.query;
    const q = { available: true };
    if (category) q.category = category;
    if (tag) q.tags = tag;
    if (search) {
      q.$or = [
        { name: new RegExp(search, 'i') },
        { category: new RegExp(search, 'i') },
      ];
    }
    const items = await MenuItem.find(q).sort({ createdAt: -1 });
    res.json({ items });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** Admin + public trending — aggregate from completed-ish orders */
router.get('/trending', async (_req, res) => {
  try {
    const agg = await Order.aggregate([
      { $match: { cancelledAt: null, status: { $in: ['Preparing', 'Ready', 'Pending'] } } },
      { $unwind: '$items' },
      {
        $group: {
          _id: '$items.menuItemId',
          count: { $sum: '$items.quantity' },
        },
      },
      { $sort: { count: -1 } },
      { $limit: 8 },
    ]);
    const ids = agg.map((a) => a._id).filter(Boolean);
    const items = await MenuItem.find({ _id: { $in: ids }, available: true });
    const map = new Map(items.map((i) => [i._id.toString(), i]));
    const ordered = agg.map((a) => map.get(a._id?.toString())).filter(Boolean);
    res.json({ items: ordered });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/admin/all', authAdmin, async (req, res) => {
  try {
    const items = await MenuItem.find().sort({ category: 1, name: 1 });
    res.json({ items });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/', authAdmin, async (req, res) => {
  try {
    const item = await MenuItem.create(req.body);
    res.status(201).json({ item });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.put('/:id', authAdmin, async (req, res) => {
  try {
    const item = await MenuItem.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true });
    if (!item) return res.status(404).json({ error: 'Not found' });
    res.json({ item });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.delete('/:id', authAdmin, async (req, res) => {
  try {
    await MenuItem.findByIdAndDelete(req.params.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
