// Central Express error-handling middleware. Must be registered LAST (after
// every route), and must keep exactly 4 parameters (err, req, res, next) —
// that arity is how Express distinguishes an error handler from regular
// middleware.
//
// Matches the shape 135 of server.js's 136 route-level try/catch blocks
// already used (`res.status(500).json({ error: err.message })`), so moving a
// route from its own try/catch to asyncHandler + this handler is a pure
// behavior-preserving move for the routes it applies to — see asyncHandler.js.
// The one route with a genuinely different error shape (a debug endpoint)
// keeps its own try/catch and never reaches this handler.
//
// Also logs to the console before responding, which NONE of those try/catch
// blocks did — previously a route-level 500 was invisible in server logs
// unless it happened to also be caught by an unrelated fire-and-forget
// sub-operation's own .catch(). This is a pure observability improvement,
// not a behavior change: the client-facing response is unchanged.
//
// `err.code` (when a thrown error sets one — e.g. chat/ask.js's
// AskGenerationError) rides along as an additional `code` field, purely
// additive: any error without a `.code` produces the exact same
// `{ error: message }` body as before, so every existing route/client is
// unaffected. This is what lets a client (mobile/src/hooks/useChat.ts)
// distinguish a specific, sanitized failure reason (e.g. "ask_truncated")
// from a generic 500 without the message text having to encode it.
function errorHandler(err, req, res, next) {
  console.error(`[${req.method} ${req.originalUrl}] error:`, err.message);
  if (res.headersSent) return next(err); // let Express's default handler close the connection
  res.status(err.status || 500).json({ error: err.message, ...(err.code ? { code: err.code } : {}) });
}

module.exports = { errorHandler };
