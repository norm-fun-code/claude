// Wraps an async Express route handler so a rejected promise is forwarded to
// next(err) instead of being silently unhandled. Lets extracted routers rely
// on the central error middleware (see errorHandler.js) instead of repeating
// the `try { ... } catch (err) { res.status(500).json({ error: err.message }) }`
// block that was duplicated 135 times across server.js's 146 routes.
//
// Every route handler in this codebase is declared `async (req, res) => {...}`,
// so a call to `fn(req, res, next)` always returns a promise (a synchronous
// throw inside an async function body is automatically converted into a
// rejected promise by JS semantics) — Promise.resolve(...).catch(next) is
// therefore sufficient to catch every failure mode these handlers can produce.
function asyncHandler(fn) {
  return function wrapped(req, res, next) {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

module.exports = { asyncHandler };
