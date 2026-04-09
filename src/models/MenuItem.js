import mongoose from 'mongoose';

const TAGS = ['New', 'Featured', 'Combo', 'Trending', 'Ultimate Combo'];

const menuItemSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    price: { type: Number, required: true, min: 0 },
    category: {
      type: String,
      required: true,
      enum: ['Burgers', 'Sandwiches', 'Maggi', 'Fries', 'Drinks', 'Pizza', 'Combos', 'Add-ons'],
    },
    tags: [{ type: String, enum: TAGS }],
    available: { type: Boolean, default: true },
    image: { type: String, default: '' },
    orderCount: { type: Number, default: 0 },
  },
  { timestamps: true }
);

export const MENU_TAGS = TAGS;
export const MenuItem = mongoose.model('MenuItem', menuItemSchema);
