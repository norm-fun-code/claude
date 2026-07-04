import { useCallback, useEffect, useState } from 'react';
import { Appearance } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

// User's theme preference. 'system' follows the OS; 'light'/'dark' override it.
// We apply it via Appearance.setColorScheme, which changes what EVERY component's
// useColorScheme() returns — so one setting flips the whole app live, no need to
// thread a context through all 49 components.
export type ThemePref = 'system' | 'light' | 'dark';
const KEY = 'normos.themePref';

// React Native bug (confirmed in Appearance.js, RN 0.76): setColorScheme(x)
// caches `x` directly as the app's "current scheme" WITHOUT re-querying native —
// including when x is null (clearing back to "follow system"). useColorScheme()
// reads that exact cache, so right after setColorScheme(null) every component
// sees `null` (not the real OS scheme), until a genuine native appearance-change
// event happens to fire later and self-heals it. Since loadThemePref() used to
// call this unconditionally on EVERY cold start — even with nothing to clear —
// "Auto" mode poisoned itself to "light" on every launch and stayed wrong all
// evening, only correcting itself if the OS happened to flip while the app
// stayed open (rare — most launches happen well after any sunset/sunrise
// transition already passed).
// Fix: only call setColorScheme(null) when THIS session actually set an
// override that needs clearing. A fresh launch with pref='system' never
// touches Appearance at all, so useColorScheme() stays live and correct.
let hasActiveOverride = false;

export function applyPref(pref: ThemePref) {
  if (pref === 'system') {
    if (hasActiveOverride) {
      Appearance.setColorScheme(null);
      hasActiveOverride = false;
    }
  } else {
    Appearance.setColorScheme(pref);
    hasActiveOverride = true;
  }
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
