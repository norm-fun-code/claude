// The backend must acknowledge a push token before this device considers
// registration complete.  This deliberately lives outside the React hook so
// the acknowledgement/retry contract is testable without Expo native modules.

export const PUSH_REGISTRATION_ACK_KEY = 'normos.pushRegistrationAck.v1';
export const PUSH_REGISTRATION_ACK_TTL_MS = 24 * 60 * 60 * 1000;

export type PushRegistrationStorage = {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
};

export type PushRegistrationResult = 'acknowledged' | 'alreadyAcknowledged' | 'notAcknowledged';

type PushRegistrationAck = {
  token: string;
  acknowledgedAt: number;
};

function parseAck(raw: string | null): PushRegistrationAck | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw);
    if (
      value &&
      typeof value.token === 'string' &&
      typeof value.acknowledgedAt === 'number' &&
      Number.isFinite(value.acknowledgedAt)
    ) {
      return value as PushRegistrationAck;
    }
  } catch {
    // A corrupt cache should make us re-register, never crash or suppress push.
  }
  return null;
}

/** A same-token acknowledgement is reusable for one day, then refreshed. */
export function isCurrentPushRegistrationAck(
  raw: string | null,
  pushToken: string,
  now = Date.now(),
  ttlMs = PUSH_REGISTRATION_ACK_TTL_MS
): boolean {
  const ack = parseAck(raw);
  return Boolean(
    ack &&
    ack.token === pushToken &&
    ack.acknowledgedAt <= now &&
    now - ack.acknowledgedAt < ttlMs
  );
}

/**
 * Post a token and persist completion only after a real HTTP 2xx response.
 * A transport error, deadline, or any non-2xx response deliberately leaves no
 * acknowledgement behind, allowing the hook to retry on the next foreground.
 */
export async function acknowledgePushRegistration({
  pushToken,
  storage,
  post,
  now = Date.now(),
}: {
  pushToken: string;
  storage: PushRegistrationStorage;
  post: () => Promise<{ ok: boolean }>;
  now?: number;
}): Promise<PushRegistrationResult> {
  const cached = await storage.getItem(PUSH_REGISTRATION_ACK_KEY);
  if (isCurrentPushRegistrationAck(cached, pushToken, now)) return 'alreadyAcknowledged';

  const response = await post();
  if (!response.ok) return 'notAcknowledged';

  // Storage is a performance/deduplication cache, not the source of truth: a
  // successful server registration remains successful even if this write fails.
  try {
    await storage.setItem(PUSH_REGISTRATION_ACK_KEY, JSON.stringify({ token: pushToken, acknowledgedAt: now }));
  } catch {
    // Next launch will register again, which is safe because the backend upsert
    // is idempotent. Do not turn a confirmed server acknowledgement into failure.
  }
  return 'acknowledged';
}
