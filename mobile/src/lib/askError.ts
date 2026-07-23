// Maps a failed Ask NormOS response (typed /api/chat or voice /api/voice/ask)
// to a user-facing message + retry affordance, WITHOUT ever surfacing the
// raw backend error text (which is deliberately internal — see
// backend/src/chat/ask.js's AskGenerationError). The backend's sanitized
// `code` field (present since errorHandler.js started passing it through) is
// the ONLY thing this function branches on — an unrecognized/missing code
// (any other 4xx/5xx) falls back to the prior generic "NormOS hit an error
// (status)" message so old backends/unrelated routes behave exactly as
// before.
//
//   node --experimental-strip-types --test src/lib/askError.test.ts

export interface AskErrorJson {
  error?: string;
  code?: string;
}

export interface AskErrorInfo {
  message: string;
  retryable: boolean;
  code: string | null;
}

export function mapAskError(status: number, json: AskErrorJson | null | undefined): AskErrorInfo {
  const code = json?.code ?? null;
  switch (code) {
    case 'ask_truncated':
      return {
        message: "NormOS couldn't finish that answer within its response limit. Tap retry, or try a shorter or more specific question.",
        retryable: true,
        code,
      };
    case 'ask_declined':
      return {
        message: 'NormOS declined to answer that one. Try rephrasing the question.',
        retryable: true,
        code,
      };
    case 'ask_unavailable':
      return {
        message: "NormOS's reasoning model is temporarily unavailable. Tap retry in a moment.",
        retryable: true,
        code,
      };
    default:
      return {
        message: `NormOS hit an error (${status}). Please try again in a moment.`,
        retryable: true,
        code: null,
      };
  }
}

// The network-failure (no response at all) path — a distinct message from
// the above, kept separate so a true connectivity failure never gets
// conflated with a backend-classified provider failure.
export const NETWORK_ERROR_MESSAGE = 'Could not reach NormOS. Check your connection and try again.';
