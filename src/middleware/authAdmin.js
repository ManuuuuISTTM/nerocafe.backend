import jwt from 'jsonwebtoken';
import { Admin } from '../models/Admin.js';

export async function authAdmin(req, res, next) {
  try {
    const header = req.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'Admin token required' });
    const decoded = jwt.verify(token, process.env.ADMIN_JWT_SECRET);
    const admin = await Admin.findById(decoded.sub).select('-password');
    if (!admin) return res.status(401).json({ error: 'Invalid admin' });
    req.admin = admin;
    next();
  } catch {
    return res.status(401).json({ error: 'Unauthorized' });
  }
}
