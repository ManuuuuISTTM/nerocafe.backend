import 'dotenv/config';
import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { connectDB } from './config/db.js';
import { sanitizeMongo, xssSanitize } from './middleware/sanitize.js';
import { apiLimiter } from './middleware/rateLimiter.js';
import authRoutes from './routes/authRoutes.js';
import menuRoutes from './routes/menuRoutes.js';
import orderRoutes from './routes/orderRoutes.js';
import adminRoutes from './routes/adminRoutes.js';
import publicRoutes from './routes/publicRoutes.js';
import razorpayRoutes from './routes/razorpayRoutes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Allowed CORS origins – production-locked on deploy. */
const corsOrigins = [
  process.env.CLIENT_ORIGIN,
  'https://nerocafes.netlify.app',
].filter(Boolean);

if (process.env.NODE_ENV !== 'production') {
  corsOrigins.push('http://localhost:5173', 'http://127.0.0.1:5173');
}

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: corsOrigins,
    methods: ['GET', 'POST'],
    credentials: true,
  },
});

app.set('io', io);

io.on('connection', (socket) => {
  socket.on('subscribe:order', (orderId) => {
    if (orderId) socket.join(`order:${orderId}`);
  });
  socket.on('unsubscribe:order', (orderId) => {
    if (orderId) socket.leave(`order:${orderId}`);
  });
});

/* ── Security middleware (applied first) ───────────────────────── */
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  contentSecurityPolicy: false, // Let Netlify handle CSP via _headers
}));

app.use(
  cors({
    origin: corsOrigins,
    credentials: true,
  })
);

/* Body parsing with size limit to prevent payload attacks */
app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: false, limit: '10kb' }));

/* Sanitise inputs — NoSQL injection + XSS */
app.use(sanitizeMongo);
app.use(xssSanitize);

/* Global rate limiter */
app.use('/api', apiLimiter);

/* ── HTTPS enforcement in production ───────────────────────────── */
if (process.env.NODE_ENV === 'production') {
  app.use((req, res, next) => {
    if (req.headers['x-forwarded-proto'] !== 'https' && !req.secure) {
      return res.redirect(301, `https://${req.headers.host}${req.url}`);
    }
    next();
  });
}

/* ── Static files ──────────────────────────────────────────────── */
app.use('/uploads', express.static(path.join(__dirname, '../uploads')));

/* ── API routes ────────────────────────────────────────────────── */
app.use('/api/auth', authRoutes);
app.use('/api/menu', menuRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/public', publicRoutes);
app.use('/api/razorpay', razorpayRoutes);

app.get('/api/health', (_req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 5000;

connectDB()
  .then(() => {
    httpServer.listen(PORT, () => {
      console.log(`NeroCafe API on port ${PORT}`);
      console.log(`Connected to Site: ${process.env.CLIENT_ORIGIN || 'http://localhost:5173'}`);
    });
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
