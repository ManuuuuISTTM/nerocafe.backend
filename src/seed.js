import 'dotenv/config';
import mongoose from 'mongoose';
import { connectDB } from './config/db.js';
import { Admin } from './models/Admin.js';
import { MenuItem } from './models/MenuItem.js';
import { OfferBanner } from './models/OfferBanner.js';
import { getOrCreateShopSettings } from './models/ShopSettings.js';

const menuSeed = [
  { name: 'Truffle Nero Burger', price: 449, category: 'Burgers', tags: ['Featured', 'Trending'] },
  { name: 'Classic Smash', price: 299, category: 'Burgers', tags: ['New'] },
  { name: 'Midnight Melt', price: 379, category: 'Burgers', tags: ['Featured'] },
  { name: 'Artisan Grilled Club', price: 329, category: 'Sandwiches', tags: ['Trending'] },
  { name: 'Basil Pesto Panini', price: 289, category: 'Sandwiches', tags: ['New'] },
  { name: 'Cheese Maggi Supreme', price: 159, category: 'Maggi', tags: ['Combo'] },
  { name: 'Peri Peri Maggi', price: 169, category: 'Maggi', tags: ['Trending'] },
  { name: 'Truffle Parmesan Fries', price: 199, category: 'Fries', tags: ['Featured'] },
  { name: 'Smoked Paprika Fries', price: 149, category: 'Fries', tags: ['New'] },
  { name: 'Cold Brew Nitro', price: 179, category: 'Drinks', tags: ['Featured'] },
  { name: 'Velvet Mocha', price: 199, category: 'Drinks', tags: ['Trending'] },
  { name: 'Nero Woodfire Pizza', price: 499, category: 'Pizza', tags: ['Featured', 'Trending'] },
  { name: 'Margherita Luxe', price: 349, category: 'Pizza', tags: ['New'] },
  { name: 'Date Night Combo', price: 899, category: 'Combos', tags: ['Combo', 'Featured'] },
  { name: 'Power Lunch Combo', price: 549, category: 'Combos', tags: ['Combo', 'Trending'] },
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

  const count = await MenuItem.countDocuments();
  if (count === 0) {
    await MenuItem.insertMany(menuSeed.map((m) => ({ ...m, available: true })));
    console.log('Menu seeded');
  } else {
    console.log('Menu already has items, skip seed');
  }

  const b = await OfferBanner.findOne({ active: true });
  if (!b) {
    await OfferBanner.create({
      title: 'Opening ritual',
      message: '20% OFF on Combos — this week only',
      active: true,
    });
    console.log('Banner seeded');
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
