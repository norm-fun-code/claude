// Registers this device for proactive nudges: asks for notification permission,
// gets the Expo push token, and hands it to the backend so NormOS can reach out
// at the right moment (the "7am text"). Safe no-op on simulators / web.
import { useEffect, useRef } from 'react';
import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import Constants from 'expo-constants';
import { DEVICE_REGISTER_URL, authHeaders } from '../config';

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
 * Registers this device for push, and (optionally) refreshes when a
 * notification is tapped — so tapping "Your morning briefing is ready!" opens
 * the app to fresh content instead of a stale view.
 */
export function usePushRegistration(onNotificationTap?: () => void) {
  const registered = useRef(false);
  const tapCb = useRef(onNotificationTap);
  tapCb.current = onNotificationTap;

  useEffect(() => {
    if (registered.current) return;
    registered.current = true;

    (async () => {
      try {
        const pushToken = await registerForPush();
        if (!pushToken) return;
        await fetch(DEVICE_REGISTER_URL, {
          method: 'POST',
          headers: authHeaders(),
          body: JSON.stringify({ pushToken, platform: Platform.OS, label: Device.modelName }),
        });
      } catch {
        // Non-fatal: nudges are an enhancement, not required for the app to work.
      }
    })();
  }, []);

  // Refresh when the user taps a notification (e.g. the morning briefing).
  useEffect(() => {
    const sub = Notifications.addNotificationResponseReceivedListener(() => {
      tapCb.current?.();
    });
    return () => sub.remove();
  }, []);
}
