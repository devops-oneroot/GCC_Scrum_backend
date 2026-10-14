const jwt = require("jsonwebtoken");
const User = require("../models/User");

function getJwtSecret() {
  const secret = process.env.JWT_SECRET?.trim();
  if (!secret) {
    throw new Error("JWT_SECRET is not configured");
  }
  return secret;
}

function signToken(userId) {
  return jwt.sign({ sub: userId }, getJwtSecret(), { expiresIn: "7d" });
}

async function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ message: "Authentication required" });
  }

  try {
    const payload = jwt.verify(token, getJwtSecret());
    const user = await User.findById(payload.sub).select("role name phone adminScope metaAdsAccess");
    if (!user) {
      return res.status(401).json({ message: "User not found" });
    }
    req.userId = payload.sub;
    req.userRole = user.role || "sales";
    req.userName = user.name?.trim() || "";
    req.isAdmin = req.userRole === "admin";
    req.isMainAdmin = user.phone === User.MAIN_ADMIN_PHONE;
    req.metaAdsAccess = req.isMainAdmin || !!user.metaAdsAccess;
    req.adminScope =
      req.isAdmin && user.adminScope === "export" ? "export" : "all";
    next();
  } catch {
    return res.status(401).json({ message: "Invalid or expired token" });
  }
}

module.exports = { requireAuth, signToken, getJwtSecret };
