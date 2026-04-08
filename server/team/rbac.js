'use strict';
/**
 * RBAC Middleware
 *
 * Role hierarchy: owner > editor > viewer
 * Checks req.user.role (set by auth middleware).
 */

const ROLE_RANK = { viewer: 0, editor: 1, owner: 2 };

/**
 * Returns Express middleware that allows only users with at least `minRole`.
 * @param {'viewer'|'editor'|'owner'} minRole
 */
function requireRole(minRole) {
  return (req, res, next) => {
    const role = req.user?.role ?? 'viewer';
    if ((ROLE_RANK[role] ?? -1) >= (ROLE_RANK[minRole] ?? Infinity)) {
      return next();
    }
    return res.status(403).json({ error: `Requires role: ${minRole}` });
  };
}

module.exports = { requireRole };
