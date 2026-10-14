const mongoose = require("mongoose");

/**
 * The main admin (the primary seeded admin in config/migrateAdmin) — the only
 * login that always sees Meta Ads (Live) and can grant it to others.
 */
const MAIN_ADMIN_PHONE = (process.env.MAIN_ADMIN_PHONE || "9900768505").trim();

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    phone: { type: String, required: true, unique: true, trim: true },
    passwordHash: { type: String, required: true, select: false },
    role: {
      type: String,
      enum: ["sales", "admin"],
      default: "sales",
    },
    adminScope: {
      type: String,
      enum: ["all", "export"],
      default: "all",
    },
    // Meta Ads (Live) tab — only when the main admin grants it (any role)
    metaAdsAccess: { type: Boolean, default: false },
  },
  { timestamps: true }
);

userSchema.methods.toPublicJSON = function toPublicJSON() {
  return {
    id: this._id.toString(),
    name: this.name,
    phone: this.phone,
    role: this.role || "sales",
    adminScope: this.role === "admin" ? this.adminScope || "all" : undefined,
    isMainAdmin: this.phone === MAIN_ADMIN_PHONE,
    metaAdsAccess: this.phone === MAIN_ADMIN_PHONE || !!this.metaAdsAccess,
  };
};

const User = mongoose.model("User", userSchema);
User.MAIN_ADMIN_PHONE = MAIN_ADMIN_PHONE;

module.exports = User;
