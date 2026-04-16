import mongoose from 'mongoose';

/** Singleton-style settings document (first row wins). */
const shopSettingsSchema = new mongoose.Schema(
  {
    shopOpen: { type: Boolean, default: true },
    closedMessage: {
      type: String,
      default: 'The cafe is closed. Try again tomorrow.',
      trim: true,
    },
    /** Featured item on the homepage hero card (optional; falls back to a Featured-tagged item). */
    heroMenuItemId: { type: mongoose.Schema.Types.ObjectId, ref: 'MenuItem', default: null },
    heroCardLabel: { type: String, default: "Tonight's pick", trim: true },
    /** Shop's contact phone number for WhatsApp */
    contactPhoneNumber: { type: String, default: '919100020345', trim: true },
  },
  { timestamps: true }
);

export const ShopSettings = mongoose.model('ShopSettings', shopSettingsSchema);

export async function getOrCreateShopSettings() {
  let s = await ShopSettings.findOne();
  if (!s) s = await ShopSettings.create({});
  return s;
}
