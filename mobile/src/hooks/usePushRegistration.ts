// Registers this device for proactive nudges: asks for notification permission,
// gets the Expo push token, and hands it to the backend so NormOS can reach out
// at the right moment (the "7am text"). Safe no-op on simulators / web.
import { useEffect, useRef } from 'react';
import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import { DEVICE_REGISTER_URL, authHeaders } from '../config';

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

  const projectId =
    // expo-notifications needs the EAS projectId for a token on SDK 49+
    (Notifications as any)?.easConfig?.projectId ||
    undefined;
  const token = await Notifications.getExpoPushTokenAsync(
    projectId ? { projectId } : undefined
  );
  return token.data ?? null;
}

export function usePushRegistration() {
  const registered = useRef(false);

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
}
