import { Router } from 'express';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { OAuth2Client } from 'google-auth-library';
import { User } from '../models/User.js';
import { RefreshToken } from '../models/RefreshToken.js';
import { sendWelcomeEmail } from '../utils/emailPlaceholder.js';
import { authUser, requireUser } from '../middleware/authUser.js';
import { uploadAvatarMiddleware } from '../middleware/uploadAvatar.js';
import { deleteLocalAvatarFile } from '../utils/avatarStorage.js';
import { authLimiter } from '../middleware/rateLimiter.js';

const router = Router();

const ACCESS_TOKEN_EXPIRY = '15m';

function signAccessToken(user) {
  return jwt.sign(
    { sub: user._id.toString(), type: 'access' },
    process.env.JWT_SECRET,
    { expiresIn: ACCESS_TOKEN_EXPIRY }
  );
}

async function issueTokenPair(user, deviceInfo = '') {
  const accessToken = signAccessToken(user);
  const refreshToken = await RefreshToken.createForUser(user._id, 'user', deviceInfo);
  return { accessToken, refreshToken };
}

const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID || undefined);

/* ── Rate-limited auth routes ─────────────────────────────────── */

router.post('/signup', authLimiter, async (req, res) => {
  try {
    const { name, email, phone, password } = req.body;
    if (!name || !email || !phone || !password) {
      return res.status(400).json({ error: 'All fields required' });
    }
    if (String(name).length > 100) return res.status(400).json({ error: 'Name too long' });
    if (String(password).length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
    if (String(password).length > 128) return res.status(400).json({ error: 'Password too long' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Invalid email' });

    const exists = await User.findOne({ email: email.toLowerCase().trim() });
    if (exists) return res.status(409).json({ error: 'Email already registered' });
    const user = await User.create({ name: name.trim(), email: email.toLowerCase().trim(), phone: phone.trim(), password });
    const deviceInfo = req.headers['user-agent'] || '';
    const { accessToken, refreshToken } = await issueTokenPair(user, deviceInfo);
    await sendWelcomeEmail({ to: email, name });
    res.status(201).json({ user: user.toJSON(), token: accessToken, refreshToken });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/login', authLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
    const user = await User.findOne({ email: email.toLowerCase().trim() });
    if (!user || !(await user.comparePassword(password))) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    const deviceInfo = req.headers['user-agent'] || '';
    const { accessToken, refreshToken } = await issueTokenPair(user, deviceInfo);
    res.json({ user: user.toJSON(), token: accessToken, refreshToken });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/google', authLimiter, async (req, res) => {
  try {
    const { credential } = req.body;
    if (!credential) return res.status(400).json({ error: 'Google credential required' });

    // Fetch user info from Google's UserInfo endpoint using the provided access_token
    const googleRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${credential}` }
    });

    if (!googleRes.ok) {
      throw new Error('Failed to verify Google access token');
    }

    const payload = await googleRes.json();
    const email = payload?.email?.toLowerCase().trim();
    if (!email) return res.status(400).json({ error: 'Google account email missing' });

    let user = await User.findOne({ email });
    if (!user) {
      user = await User.create({
        name: payload?.name || 'Google User',
        email,
        phone: '0000000000',
        password: crypto.randomBytes(24).toString('hex'),
        avatarUrl: payload?.picture || '',
      });
    } else if (payload.picture && !user.avatarUrl) {
      // Opportunistically update avatar if not set
      user.avatarUrl = payload.picture;
      await user.save();
    }
    
    const deviceInfo = req.headers['user-agent'] || '';
    const { accessToken, refreshToken } = await issueTokenPair(user, deviceInfo);
    res.json({ user: user.toJSON(), token: accessToken, refreshToken });
  } catch (e) {
    const errorMessage = e.message || 'Verification failed';
    res.status(401).json({ error: `Google sign-in failed: ${errorMessage}` });
  }
});

/* ── Refresh token endpoint ───────────────────────────────────── */
router.post('/refresh', async (req, res) => {
  try {
    const { refreshToken: rt } = req.body;
    if (!rt) return res.status(400).json({ error: 'Refresh token required' });

    const doc = await RefreshToken.verifyToken(rt, 'user');
    if (!doc) return res.status(401).json({ error: 'Invalid or expired refresh token' });

    const user = await User.findById(doc.userId);
    if (!user) {
      await RefreshToken.revokeToken(rt);
      return res.status(401).json({ error: 'User not found' });
    }

    /* Rotate refresh token – revoke old, issue new pair */
    await RefreshToken.revokeToken(rt);
    const deviceInfo = req.headers['user-agent'] || '';
    const { accessToken, refreshToken } = await issueTokenPair(user, deviceInfo);
    res.json({ token: accessToken, refreshToken });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ── Logout (revoke refresh token) ────────────────────────────── */
router.post('/logout', async (req, res) => {
  try {
    const { refreshToken: rt } = req.body;
    if (rt) await RefreshToken.revokeToken(rt);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ── Protected user routes ────────────────────────────────────── */

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
    if (name !== undefined) user.name = String(name).trim().slice(0, 100) || user.name;
    if (phone !== undefined) user.phone = String(phone).trim().slice(0, 20);
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
