// Gate for the diagnostic (/api/diag/*, /api/debug/*) and destructive-admin
// (/api/admin/reset-demo, /api/admin/recompute-wealth, /api/ingest/run)
// routes. These sat behind the same single NORMOS_API_TOKEN as every other
// route — a leaked/shared app token (or a less-trusted automation holding it)
// would also grant data-destroying power. Requires a SEPARATE
// NORMOS_ADMIN_TOKEN, checked against the same Authorization header. Unlike
// the general /api gate, an unconfigured token fails closed in production
// rather than opening these routes to the world.
//
// The general /api gate (server.js) must SKIP these paths (see isAdminPath)
// rather than also requiring NORMOS_API_TOKEN on top — both checks read the
// same single Authorization header, so requiring it match two different
// secrets at once would make these routes permanently unreachable.
const { createTokenGate } = require('./auth');

const ADMIN_PATHS = [
  '/diag',
  '/debug',
  '/admin/reset-demo',
  '/admin/recompute-wealth',
  '/ingest/run',
];

function isAdminPath(path) {
  return ADMIN_PATHS.some((p) => path === p || path.startsWith(`${p}/`));
}

const requireAdminToken = createTokenGate('NORMOS_ADMIN_TOKEN', { failClosedInProd: true });

module.exports = { requireAdminToken, isAdminPath };
