// Registers this device for proactive nudges: asks for notification permission,
// gets the Expo push token, and hands it to the backend so NormOS can reach out
// at the right moment (the "7am text"). Safe no-op on simulators / web.
import { useCallback, useEffect, useRef } from 'react';
import { AppState, Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import Constants from 'expo-constants';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { DEVICE_REGISTER_URL, authHeaders, fetchWithTimeout } from '../config';
import { acknowledgePushRegistration } from '../lib/pushRegistration';

// The EAS projectId, required by getExpoPushTokenAsync on SDK 49+. EAS injects
// it into the manifest at build time; fall back to an explicit env override for
// local/dev builds. (The previous code read a non-existent field and silently
// failed, so push tokens never registered.)
function getProjectId(): string | undefined {
  return (
    Constants?.expoConfig?.extra?.eas?.projectId ||
    (Constants as any)?.easConfig?.projectId ||
    process.env.EXPO_PUBLIC_EAS_PROJECT_ID ||
    undefined
  );
}

// Show notifications even when the app is foregrounded.
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

async function registerForPush(): Promise<string | null> {
  if (!Device.isDevice) return null; // push only works on physical hardware

  const existing = await Notifications.getPermissionsAsync();
  let status = existing.status;
  if (status !== 'granted') {
    status = (await Notifications.requestPermissionsAsync()).status;
  }
  if (status !== 'granted') return null;

  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('default', {
      name: 'NormOS',
      importance: Notifications.AndroidImportance.DEFAULT,
    });
  }

  const projectId = getProjectId();
  if (!projectId) {
    console.warn('[push] no EAS projectId found — cannot register for push. Set expo.extra.eas.projectId in app.json.');
    return null;
  }
  const token = await Notifications.getExpoPushTokenAsync({ projectId });
  return token.data ?? null;
}

/**
 * Registers this device for push. The onNotificationTap callback receives the
 * notification's data payload so callers can route by type (e.g. open the
 * habits modal on a habits push vs. reload the briefing on a morning push).
 */
export function usePushRegistration(onNotificationTap?: (data: Record<string, unknown>) => void) {
  const registered = useRef(false);
  const registrationInFlight = useRef(false);
  const tapCb = useRef(onNotificationTap);
  tapCb.current = onNotificationTap;

  const registerDevice = useCallback(async () => {
    // Critically, `registered` only becomes true AFTER the backend returns a
    // 2xx acknowledgement. The previous eager assignment made one transient
    // offline/500/timeout failure permanently disable push for the whole app
    // session, which is why morning notifications could disappear silently.
    if (registered.current || registrationInFlight.current) return;
    registrationInFlight.current = true;
    try {
      const pushToken = await registerForPush();
      if (!pushToken) return;
      const result = await acknowledgePushRegistration({
        pushToken,
        storage: AsyncStorage,
        post: () => fetchWithTimeout(DEVICE_REGISTER_URL, {
          method: 'POST',
          headers: authHeaders(),
          body: JSON.stringify({ pushToken, platform: Platform.OS, label: Device.modelName }),
        }, 10_000),
      });
      if (result === 'acknowledged' || result === 'alreadyAcknowledged') {
        registered.current = true;
      } else {
        console.warn('[push] device registration was not acknowledged; will retry when the app returns to foreground');
      }
    } catch {
      // Preserve the retry path: no 2xx acknowledgement means no terminal
      // state. A foreground transition retries after connectivity recovers.
      console.warn('[push] device registration failed; will retry when the app returns to foreground');
    } finally {
      registrationInFlight.current = false;
    }
  }, []);

  useEffect(() => { void registerDevice(); }, [registerDevice]);

  // React Native does not expose a dependable cross-platform connectivity
  // event without another native dependency. Foreground is the reliable
  // availability boundary we already observe everywhere else in the app: it
  // retries a previous transport/5xx/deadline failure without prompting again
  // when the user returns after Wi-Fi/cellular recovers.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') void registerDevice();
    });
    return () => sub.remove();
  }, [registerDevice]);

  useEffect(() => {
    const sub = Notifications.addNotificationResponseReceivedListener((response) => {
      const data = (response.notification.request.content.data ?? {}) as Record<string, unknown>;
      tapCb.current?.(data);
    });
    return () => sub.remove();
  }, []);

  // Cold start: addNotificationResponseReceivedListener above only fires for
  // a tap that happens while this listener is already registered (app
  // foregrounded, or backgrounded but still running in memory). If the app
  // was fully closed, tapping a notification LAUNCHES it fresh — that tap
  // happens before this hook ever mounts, so the listener never sees it and
  // the tap silently does nothing (the exact "I tap the check-in
  // notification and it doesn't take me anywhere" bug: a notification
  // that's sat for a while is much more likely to be tapped from a killed
  // app). getLastNotificationResponseAsync() is the separate Expo API for
  // recovering that launch-triggering tap.
  const handledLaunchResponse = useRef(false);
  useEffect(() => {
    (async () => {
      try {
        const response = await Notifications.getLastNotificationResponseAsync();
        if (!response || handledLaunchResponse.current) return;
        handledLaunchResponse.current = true;
        const data = (response.notification.request.content.data ?? {}) as Record<string, unknown>;
        tapCb.current?.(data);
        // Clear it so this same launch tap doesn't get replayed on a LATER
        // cold start too (e.g. after a crash, or a dev Fast Refresh) —
        // "last" otherwise stays frozen until a brand new tap replaces it.
        await Notifications.clearLastNotificationResponseAsync();
      } catch {
        // Non-fatal: worst case the cold-launch tap doesn't navigate.
      }
    })();
  }, []);
}
