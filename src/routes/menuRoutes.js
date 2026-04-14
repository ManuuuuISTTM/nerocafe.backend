import { Router } from 'express';
import { MenuItem } from '../models/MenuItem.js';
import { Order } from '../models/Order.js';
import { authAdmin } from '../middleware/authAdmin.js';
import multer from 'multer';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const router = Router();

/* ── Menu image upload config ─────────────────────────────────── */
const MENU_UPLOAD_DIR = path.join(__dirname, '../../uploads/menu');
if (!fs.existsSync(MENU_UPLOAD_DIR)) fs.mkdirSync(MENU_UPLOAD_DIR, { recursive: true });

const menuStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, MENU_UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
    cb(null, `menu_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`);
  },
});

const menuUpload = multer({
  storage: menuStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = /jpeg|jpg|png|webp|gif/;
    const ok = allowed.test(file.mimetype) && allowed.test(path.extname(file.originalname).toLowerCase().replace('.', ''));
    cb(ok ? null : new Error('Only image files are allowed'), ok);
  },
});

/* ── Public menu routes ───────────────────────────────────────── */

router.get('/', async (req, res) => {
  try {
    const { category, search } = req.query;
    const q = { available: true };
    if (category) q.category = String(category).trim();
    if (search) {
      const escaped = String(search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      q.$or = [
        { name: new RegExp(escaped, 'i') },
        { category: new RegExp(escaped, 'i') },
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

/* ── Admin CRUD with input validation ─────────────────────────── */

router.post('/', authAdmin, async (req, res) => {
  try {
    const { name, price, category, tags, available, image, description } = req.body;
    if (!name || price === undefined || !category) {
      return res.status(400).json({ error: 'Name, price, and category are required' });
    }
    const item = await MenuItem.create({
      name: String(name).trim().slice(0, 100),
      price: Math.max(0, Number(price) || 0),
      category: String(category).trim(),
      tags: Array.isArray(tags) ? tags.map(t => String(t).trim()).slice(0, 5) : [],
      available: available !== false,
      image: image ? String(image).trim().slice(0, 500) : '',
      description: description ? String(description).trim().slice(0, 500) : '',
    });
    res.status(201).json({ item });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.put('/:id', authAdmin, async (req, res) => {
  try {
    const { name, price, category, tags, available, image, description } = req.body;
    const updates = {};
    if (name !== undefined) updates.name = String(name).trim().slice(0, 100);
    if (price !== undefined) updates.price = Math.max(0, Number(price) || 0);
    if (category !== undefined) updates.category = String(category).trim();
    if (tags !== undefined) updates.tags = Array.isArray(tags) ? tags.map(t => String(t).trim()).slice(0, 5) : [];
    if (available !== undefined) updates.available = !!available;
    if (image !== undefined) updates.image = String(image).trim().slice(0, 500);
    if (description !== undefined) updates.description = String(description).trim().slice(0, 500);

    const item = await MenuItem.findByIdAndUpdate(req.params.id, updates, { new: true, runValidators: true });
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

/* ── Image upload endpoint ────────────────────────────────────── */
router.post('/upload-image', authAdmin, (req, res, next) => {
  menuUpload.single('image')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message || 'Upload failed' });
    next();
  });
}, (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const imageUrl = `/uploads/menu/${req.file.filename}`;
  res.json({ imageUrl });
});

export default router;
