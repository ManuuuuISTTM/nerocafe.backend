import { Router } from 'express';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { OAuth2Client } from 'google-auth-library';
import { User } from '../models/User.js';
import { sendWelcomeEmail } from '../utils/emailPlaceholder.js';
import { authUser, requireUser } from '../middleware/authUser.js';
import { uploadAvatarMiddleware } from '../middleware/uploadAvatar.js';
import { deleteLocalAvatarFile } from '../utils/avatarStorage.js';

const router = Router();

function signUserToken(user) {
  return jwt.sign({ sub: user._id.toString() }, process.env.JWT_SECRET, { expiresIn: '7d' });
}

const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID || undefined);

router.post('/signup', async (req, res) => {
  try {
    const { name, email, phone, password } = req.body;
    if (!name || !email || !phone || !password) {
      return res.status(400).json({ error: 'All fields required' });
    }
    const exists = await User.findOne({ email });
    if (exists) return res.status(409).json({ error: 'Email already registered' });
    const user = await User.create({ name, email, phone, password });
    const token = signUserToken(user);
    await sendWelcomeEmail({ to: email, name });
    res.status(201).json({ user, token });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
    const user = await User.findOne({ email });
    if (!user || !(await user.comparePassword(password))) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    const token = signUserToken(user);
    res.json({ user: user.toJSON(), token });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/google', async (req, res) => {
  try {
    const { credential } = req.body;
    if (!credential) return res.status(400).json({ error: 'Google credential required' });
    if (!process.env.GOOGLE_CLIENT_ID) {
      return res.status(500).json({ error: 'Google auth is not configured on server' });
    }
    const ticket = await googleClient.verifyIdToken({
      idToken: credential,
      audience: process.env.GOOGLE_CLIENT_ID?.trim(),
    });
    const payload = ticket.getPayload();
    const email = payload?.email?.toLowerCase().trim();
    if (!email) return res.status(400).json({ error: 'Google account email missing' });

    let user = await User.findOne({ email });
    if (!user) {
      user = await User.create({
        name: payload?.name || 'Google User',
        email,
        phone: '0000000000',
        password: crypto.randomBytes(24).toString('hex'),
      });
    }
    const token = signUserToken(user);
    res.json({ user: user.toJSON(), token });
  } catch (e) {
    console.error('[Auth] Google verify error:', e);
    const errorMessage = e.message || 'Verification failed';
    res.status(401).json({ error: `Google sign-in failed: ${errorMessage}` });
  }
});

router.get('/me', authUser, requireUser, (req, res) => {
  res.json({ user: req.user });
});

router.patch('/me', authUser, requireUser, async (req, res) => {
  try {
    const { name, phone } = req.body || {};
    if (phone !== undefined && !String(phone).trim()) {
      return res.status(400).json({ error: 'Phone is required' });
    }
    const user = await User.findById(req.user._id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (name !== undefined) user.name = String(name).trim() || user.name;
    if (phone !== undefined) user.phone = String(phone).trim();
    await user.save();
    res.json({ user: user.toJSON() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post(
  '/me/avatar',
  authUser,
  requireUser,
  (req, res, next) => {
    uploadAvatarMiddleware.single('avatar')(req, res, (err) => {
      if (err) return res.status(400).json({ error: err.message || 'Upload failed' });
      next();
    });
  },
  async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
      const user = await User.findById(req.user._id);
      if (!user) return res.status(404).json({ error: 'User not found' });
      await deleteLocalAvatarFile(user.avatarUrl);
      user.avatarUrl = `/uploads/avatars/${req.file.filename}`;
      await user.save();
      res.json({ user: user.toJSON() });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  }
);

router.delete('/me/avatar', authUser, requireUser, async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    await deleteLocalAvatarFile(user.avatarUrl);
    user.avatarUrl = '';
    await user.save();
    res.json({ user: user.toJSON() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
