import 'dotenv/config';
import mongoose from 'mongoose';
import { connectDB } from './config/db.js';
import { Admin } from './models/Admin.js';
import { MenuItem } from './models/MenuItem.js';
import { OfferBanner } from './models/OfferBanner.js';
import { WhatsAppTemplate } from './models/WhatsAppTemplate.js';
import { getOrCreateShopSettings } from './models/ShopSettings.js';

const menuSeed = [
  // BURGERS
  { name: 'Classic / Tandoori Veg Burger', price: 99, category: 'Burgers' },
  { name: 'Double Patty Veg Burger', price: 119, category: 'Burgers' },
  { name: 'Classic / Tandoori Chicken Burger', price: 109, category: 'Burgers' },
  { name: 'Double Patty Chicken Burger', price: 129, category: 'Burgers' },
  { name: 'Classic / Tandoori Paneer Burger', price: 109, category: 'Burgers' },
  { name: 'Double Patty Paneer Burger', price: 129, category: 'Burgers' },
  { name: 'Any two Classic / Tandoori Veg Burgers', price: 130, category: 'Burgers', tags: ['Combo'] },
  { name: 'Any two Classic / Tandoori Chicken Burgers', price: 140, category: 'Burgers', tags: ['Combo'] },
  { name: 'Any two Classic / Tandoori Paneer Burgers', price: 160, category: 'Burgers', tags: ['Combo'] },

  // ULTIMATE COMBO BURGERS
  { name: 'Veg Burger + Fries + Any Drink + Chips', price: 150, category: 'Burgers', tags: ['Ultimate Combo'] },
  { name: 'Chicken Burger + Fries + Any Drink + Chips', price: 160, category: 'Burgers', tags: ['Ultimate Combo'] },
  { name: 'Paneer Burger + Fries + Any Drink + Chips', price: 170, category: 'Burgers', tags: ['Ultimate Combo'] },

  // SANDWICHES
  { name: 'Mediterranean Chicken Sandwich', price: 89, category: 'Sandwiches' },
  { name: 'Tandoori Chicken Sandwich', price: 99, category: 'Sandwiches' },
  { name: 'Mayo Chicken Sandwich', price: 99, category: 'Sandwiches' },
  { name: 'Italian Veg Sandwich', price: 79, category: 'Sandwiches' },
  { name: 'Cheese Melt Sandwich', price: 99, category: 'Sandwiches' },
  { name: 'Mayo Egg Sandwich', price: 99, category: 'Sandwiches' },
  { name: 'Paneer Sandwich', price: 99, category: 'Sandwiches' },
  { name: 'Any two Veg Sandwiches', price: 120, category: 'Sandwiches', tags: ['Combo'] },
  { name: 'Any two Chicken Sandwiches', price: 130, category: 'Sandwiches', tags: ['Combo'] },
  { name: 'Any two Paneer Sandwiches', price: 140, category: 'Sandwiches', tags: ['Combo'] },

  // ULTIMATE COMBO SANDWICHES
  { name: 'Veg Sandwich + Fries + Any Drink + Chips', price: 120, category: 'Sandwiches', tags: ['Ultimate Combo'] },
  { name: 'Chicken Sandwich + Fries + Any Drink + Chips', price: 130, category: 'Sandwiches', tags: ['Ultimate Combo'] },
  { name: 'Paneer Sandwich + Fries + Any Drink + Chips', price: 140, category: 'Sandwiches', tags: ['Ultimate Combo'] },

  // MAGGIE'S
  { name: 'Veg Maggie', price: 99, category: 'Maggi' },
  { name: 'Egg Maggie', price: 109, category: 'Maggi' },
  { name: 'Chicken Maggie', price: 119, category: 'Maggi' },
  { name: 'Veg Maggie + Any Drink', price: 130, category: 'Maggi', tags: ['Combo'] },
  { name: 'Egg Maggie + Any Drink', price: 140, category: 'Maggi', tags: ['Combo'] },
  { name: 'Chicken Maggie + Any Drink', price: 150, category: 'Maggi', tags: ['Combo'] },

  // FRIES
  { name: 'French Fries', price: 79, category: 'Fries' },
  { name: 'Peri Peri Fries', price: 90, category: 'Fries' },

  // DRINKS
  { name: 'Diet Coke', price: 40, category: 'Drinks' },
  { name: 'Thums Up', price: 40, category: 'Drinks' },

  // PIZZAS
  { name: 'Veg Supreme Pizza', price: 120, category: 'Pizza' },
  { name: 'Margherita Pizza', price: 130, category: 'Pizza' },
  { name: 'Corn and Cheese Pizza', price: 120, category: 'Pizza' },
  { name: 'Chicken Pizza', price: 140, category: 'Pizza' },
  { name: 'Paneer Peri Peri Pizza', price: 140, category: 'Pizza' },
  { name: 'Any Veg Pizza + Any Drink', price: 140, category: 'Pizza', tags: ['Combo'] },
  { name: 'Chicken Pizza + Any Drink', price: 150, category: 'Pizza', tags: ['Combo'] },
  { name: 'Paneer Pizza + Any Drink', price: 150, category: 'Pizza', tags: ['Combo'] },

  // ADDITIONS
  { name: 'Cheese Slices', price: 10, category: 'Add-ons' },
  { name: 'Chips', price: 10, category: 'Add-ons' },
];

async function run() {
  await connectDB();
  const adminEmail = process.env.SEED_ADMIN_EMAIL || 'nerocafes14@gmail.com';
  const adminPass = process.env.SEED_ADMIN_PASSWORD || 'NeroCafe2026';
  const exists = await Admin.findOne({ email: adminEmail });
  if (!exists) {
    await Admin.create({ name: 'Nero Admin', email: adminEmail, password: adminPass });
    console.log('Admin created:', adminEmail);
  } else {
    exists.password = adminPass;
    await exists.save();
    console.log('Admin password updated:', adminEmail);
  }

  // Clear existing menu so we can re-seed with clean data
  await MenuItem.deleteMany({});
  await MenuItem.insertMany(menuSeed.map((m) => ({ ...m, available: true })));
  console.log('Menu seeded with', menuSeed.length, 'items');

  const b = await OfferBanner.findOne({ active: true });
  if (!b) {
    await OfferBanner.create({
      title: 'Opening Ritual',
      message: 'Freshly prepared food for your ritual — Order now!',
      active: true,
    });
    console.log('Banner seeded');
  }

  // Seed WhatsApp templates
  const templateCount = await WhatsAppTemplate.countDocuments();
  if (templateCount === 0) {
    const templates = [
      {
        name: 'order_started',
        description: 'Order confirmation message',
        messageType: 'confirmation',
        messageBody: 'Hey {{1}},\n\nYour order {{2}} has been received. We are preparing your delicious meal. You\'ll be notified when it\'s ready!\n\nEnjoy your meal ☕',
        variables: ['name', 'order_no'],
        enabled: true,
        isApproved: true,
        metaStatus: 'approved',
      },
      {
        name: 'order_ready',
        description: 'Order placed with tracking',
        messageType: 'confirmation',
        messageBody: 'Hey {{1}},\n\nYour order {{2}} has been placed successfully! 🎉\n\nTrack your order: {{3}}\n\nWe\'ll notify you when it\'s ready for pickup.',
        variables: ['name', 'order_no', 'track_link'],
        enabled: true,
        isApproved: true,
        metaStatus: 'approved',
      },
      {
        name: 'order_can',
        description: 'Order cancellation message',
        messageType: 'cancellation',
        messageBody: 'Hi {{1}},\n\nYour order {{2}} has been cancelled.\n\nSorry for the inconvenience 💛\nWe\'re here if you need help.\n\nReply STOP to opt out.',
        variables: ['name', 'order_no'],
        enabled: true,
        isApproved: true,
        metaStatus: 'approved',
      },
    ];
    await WhatsAppTemplate.insertMany(templates);
    console.log('WhatsApp templates seeded:', templates.length);
  }

  await getOrCreateShopSettings();
  console.log('Shop settings ready');

  await mongoose.disconnect();
  console.log('Done');
  process.exit(0);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
