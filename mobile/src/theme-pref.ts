import { useCallback, useEffect, useState } from 'react';
import { Appearance } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

// User's theme preference. 'system' follows the OS; 'light'/'dark' override it.
// We apply it via Appearance.setColorScheme, which changes what EVERY component's
// useColorScheme() returns — so one setting flips the whole app live, no need to
// thread a context through all 49 components.
export type ThemePref = 'system' | 'light' | 'dark';
const KEY = 'normos.themePref';

export function applyPref(pref: ThemePref) {
  Appearance.setColorScheme(pref === 'system' ? null : pref);
}

// Read the stored preference and apply it. Call once at startup.
export async function loadThemePref(): Promise<ThemePref> {
  try {
    const v = await AsyncStorage.getItem(KEY);
    const pref: ThemePref = v === 'light' || v === 'dark' ? v : 'system';
    applyPref(pref);
    return pref;
  } catch {
    return 'system';
  }
}

// Header hook: loads the stored pref on mount, exposes the current value and a
// one-tap cycle (System → Light → Dark → System).
export function useThemePref() {
  const [pref, setPref] = useState<ThemePref>('system');
  useEffect(() => { loadThemePref().then(setPref); }, []);

  const set = useCallback((p: ThemePref) => {
    setPref(p);
    applyPref(p);
    AsyncStorage.setItem(KEY, p).catch(() => {});
  }, []);

  const cycle = useCallback(() => {
    setPref((cur) => {
      const next: ThemePref = cur === 'system' ? 'light' : cur === 'light' ? 'dark' : 'system';
      applyPref(next);
      AsyncStorage.setItem(KEY, next).catch(() => {});
      return next;
    });
  }, []);

  return { pref, set, cycle };
}
