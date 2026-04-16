import { v4 as uuidv4 } from 'uuid';
import { Order } from '../models/Order.js';
import { MenuItem } from '../models/MenuItem.js';
import { Customer } from '../models/Customer.js';
import { Counter } from '../models/Counter.js';
import { User } from '../models/User.js';
import { sendOrderConfirmationEmail } from './emailPlaceholder.js';
import { sendPaymentSuccessMessage } from './whatsapp.js';
import { normalizePhone } from './phone.js';

export async function upsertCustomer({ name, phone, email, userId }) {
  const normPhone = normalizePhone(phone);
  let c = await Customer.findOne({ phone: normPhone });
  if (c) {
    c.name = name;
    if (email) c.email = email;
    if (userId) c.userId = userId;
    c.orderCount = (c.orderCount || 0) + 1;
    await c.save();
    return c;
  }
  return Customer.create({
    name,
    phone: normPhone,
    email: email || '',
    userId: userId || null,
    orderCount: 1,
  });
}

export async function createOrderFromBody({ items, customer, paymentMethod, isOutOfRange, userId, location, io }) {
  let total = 0;
  const lineItems = [];
  for (const line of items) {
    const menu = await MenuItem.findById(line.menuItemId);
    if (!menu || !menu.available) continue;
    const qty = Math.max(1, Number(line.quantity) || 1);
    total += menu.price * qty;
    lineItems.push({
      menuItemId: menu._id,
      name: menu.name,
      image: menu.image || '',
      price: menu.price,
      quantity: qty,
    });
  }
  if (!lineItems.length) throw new Error('No valid items');

  const trackingToken = uuidv4();
  const orderNo = await Counter.getNextValue('orderNumber');

  /* Determine payment status based on method */
  const isCOD = paymentMethod === 'COD';
  const paymentStatus = isCOD ? 'Cash Pending' : 'Pending';

  /* Build location data if provided */
  const loc = {};
  if (location && location.lat != null && location.lng != null) {
    loc.lat = Number(location.lat);
    loc.lng = Number(location.lng);
    loc.mapLink = `https://www.google.com/maps?q=${loc.lat},${loc.lng}`;
  }

  const order = await Order.create({
    orderNo,
    userId: userId || null,
    trackingToken,
    items: lineItems,
    totalPrice: total,
    status: 'Pending',
    customer: {
      name: String(customer.name).trim().slice(0, 100),
      phone: normalizePhone(customer.phone),
      email: customer.email ? String(customer.email).trim().slice(0, 200) : '',
    },
    paymentMethod: paymentMethod || 'Razorpay',
    paymentStatus,
    isOutOfRange: !!isOutOfRange,
    location: loc.lat != null ? loc : undefined,
  });

  await upsertCustomer({
    name: customer.name,
    phone: customer.phone,
    email: customer.email,
    userId: userId || null,
  });

  for (const li of lineItems) {
    await MenuItem.updateOne({ _id: li.menuItemId }, { $inc: { orderCount: li.quantity } });
  }

  if (customer.email) {
    try {
      await sendOrderConfirmationEmail({
        to: customer.email,
        name: customer.name,
        orderNo: order.orderNo,
        total,
      });
    } catch (e) {
      console.warn('Email confirmation failed:', e.message);
    }
  }

  // Confirmation message for all orders
  let targetPhone = customer.phone;
  if (userId) {
    const user = await User.findById(userId);
    if (user && user.phone) targetPhone = user.phone;
  }
  if (targetPhone) {
    try {
      sendPaymentSuccessMessage(targetPhone, customer.name, order.orderNo, order._id, order.trackingToken);
    } catch (e) {
      console.warn('WhatsApp confirmation failed:', e.message);
    }
  }

  // Emit detailed order info to admins
  io?.emit('orders:update', {
    type: 'created',
    status: 'Pending',
    orderId: order._id,
    orderNo: order.orderNo,
    customerName: customer.name,
    totalPrice: total,
    itemCount: lineItems.length,
    createdAt: order.createdAt,
  });
  return { order, trackingToken };
}
