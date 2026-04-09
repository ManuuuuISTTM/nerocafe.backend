import { Router } from 'express';
import Razorpay from 'razorpay';
import crypto from 'crypto';
import { Order } from '../models/Order.js';
import { User } from '../models/User.js';
import { sendPaymentSuccessMessage } from '../utils/whatsapp.js';

const router = Router();

router.post('/create-order', async (req, res) => {
  try {
    const { amount, currency = 'INR', receipt } = req.body;

    const instance = new Razorpay({
      key_id: process.env.RAZORPAY_KEY_ID,
      key_secret: process.env.RAZORPAY_KEY_SECRET,
    });

    const options = {
      amount: amount * 100, // amount in the smallest currency unit
      currency,
      receipt,
    };

    const order = await instance.orders.create(options);

    if (!order) return res.status(500).json({ error: 'Some error occurred while creating razorpay order' });

    res.json(order);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/verify', async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature, order_id } = req.body;

    const shasum = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET);
    shasum.update(`${razorpay_order_id}|${razorpay_payment_id}`);
    const digest = shasum.digest('hex');

    if (digest !== razorpay_signature) {
      return res.status(400).json({ msg: 'Transaction not legit!' });
    }

    if (order_id) {
      const order = await Order.findById(order_id);
      if (order) {
        order.paymentStatus = 'Completed';
        order.paymentMeta = { razorpay_order_id, razorpay_payment_id };
        await order.save();

        let targetPhone = order.customer?.phone;
        // The user wants the message to go to the registered number from their login account
        if (order.userId) {
          const user = await User.findById(order.userId);
          if (user && user.phone) {
            targetPhone = user.phone;
          }
        }
        
        if (targetPhone) {
          // Playfully skip awaiting the message queue so the frontend isn't blocked
          sendPaymentSuccessMessage(targetPhone, order.customer?.name || 'Customer', order.orderNo, order._id, order.trackingToken);
        }
      }
    }

    res.json({
      msg: 'success',
      orderId: razorpay_order_id,
      paymentId: razorpay_payment_id,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;

// Refund endpoint
router.post('/refund', async (req, res) => {
  try {
    const { payment_id, amount, orderId, reason } = req.body;

    const instance = new Razorpay({
      key_id: process.env.RAZORPAY_KEY_ID,
      key_secret: process.env.RAZORPAY_KEY_SECRET,
    });

    const refundOptions = {};
    if (amount) refundOptions.amount = Math.round(amount * 100);

    // Create refund on Razorpay
    const refund = await instance.payments.refund(payment_id, refundOptions);

    // Persist refund info to order.paymentMeta.refunds if orderId provided
    if (orderId) {
      const order = await Order.findById(orderId);
      if (order) {
        const meta = order.paymentMeta || {};
        const refunds = Array.isArray(meta.refunds) ? meta.refunds : [];
        refunds.push({
          id: refund.id,
          amount: refund.amount,
          currency: refund.currency,
          status: refund.status,
          reason: reason || null,
          createdAt: new Date(),
          raw: refund,
        });

        meta.refunds = refunds;
        meta.refunded = true;
        order.paymentMeta = meta;
        order.cancelledAt = order.cancelledAt || new Date();
        await order.save();
      }
    }

    res.json({ refund });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
