# Native design checklist — exact, mechanical edits

Run on a machine with network + EAS access. Each step is find/replace against the
current files, or a new file to create. No judgment calls. Tick each box.

- [ ] **0.** `git pull` in the repo, `cd mobile`.

---

## 1. Install

- [ ] Run:
```bash
npx expo install expo-font @expo-google-fonts/sora @expo-google-fonts/inter @shopify/react-native-skia
```

---

## 2. `App.tsx` — add font imports

- [ ] **FIND** (line 1):
```tsx
import React, { useCallback, useMemo, useState } from 'react';
```
- [ ] **REPLACE WITH:**
```tsx
import React, { useCallback, useMemo, useState } from 'react';
import { useFonts, Sora_600SemiBold, Sora_700Bold, Sora_800ExtraBold } from '@expo-google-fonts/sora';
import { Inter_400Regular, Inter_500Medium, Inter_600SemiBold, Inter_700Bold } from '@expo-google-fonts/inter';
```

## 3. `App.tsx` — load the fonts

- [ ] **FIND:**
```tsx
  const liveRecovery = useRecovery();
```
- [ ] **REPLACE WITH:**
```tsx
  const liveRecovery = useRecovery();
  const [fontsLoaded] = useFonts({
    Sora_600SemiBold, Sora_700Bold, Sora_800ExtraBold,
    Inter_400Regular, Inter_500Medium, Inter_600SemiBold, Inter_700Bold,
  });
```

## 4. `App.tsx` — gate first paint until fonts load

- [ ] **FIND:**
```tsx
  return (
    <View style={[styles.root, { backgroundColor: c.background }]}>
```
- [ ] **REPLACE WITH:**
```tsx
  if (!fontsLoaded) return null; // wait for custom fonts before first paint
  return (
    <View style={[styles.root, { backgroundColor: c.background }]}>
```

---

## 5. `src/theme.ts` — turn the type system on

- [ ] **FIND:**
```ts
export const FONTS: { display?: string; text?: string } = {
  display: undefined, // headlines + numbers
  text: undefined,    // body, captions, labels
};
```
- [ ] **REPLACE WITH:**
```ts
export const FONTS: { display?: string; text?: string; displayHeavy?: string } = {
  display: 'Sora_700Bold',        // headlines + numbers
  text: 'Inter_400Regular',       // body, captions, labels
  displayHeavy: 'Sora_800ExtraBold',
};
```

---

## 6. New file — `src/components/viz/Sparkline.tsx`

- [ ] Create with exactly:
```tsx
import React from 'react';
import { Canvas, Path, Skia, LinearGradient, vec } from '@shopify/react-native-skia';

interface Props { values: number[]; width: number; height: number; color?: string; }

export function Sparkline({ values, width, height, color = '#5A52F0' }: Props) {
  if (!values || values.length < 2) return null;
  const min = Math.min(...values), max = Math.max(...values);
  const span = max - min || 1;
  const dx = width / (values.length - 1);
  const y = (v: number) => height - 6 - ((v - min) / span) * (height - 12);

  const line = Skia.Path.Make();
  line.moveTo(0, y(values[0]));
  values.forEach((v, i) => line.lineTo(i * dx, y(v)));

  const area = line.copy();
  area.lineTo(width, height);
  area.lineTo(0, height);
  area.close();

  return (
    <Canvas style={{ width, height }}>
      <Path path={area}>
        <LinearGradient start={vec(0, 0)} end={vec(0, height)} colors={[color + '55', color + '00']} />
      </Path>
      <Path path={line} style="stroke" strokeWidth={2.5} strokeCap="round" color={color} />
    </Canvas>
  );
}
```

## 7. New file — `src/components/viz/ProgressArc.tsx`

- [ ] Create with exactly:
```tsx
import React from 'react';
import { Canvas, Path, Skia, SweepGradient, vec } from '@shopify/react-native-skia';
import { bandGradient } from '../../theme';

interface Props { score: number; band?: string | null; size: number; stroke?: number; }

export function ProgressArc({ score, band, size, stroke = 7 }: Props) {
  const r = (size - stroke) / 2;
  const cx = size / 2, cy = size / 2;
  const sweep = Math.max(0, Math.min(1, score / 100)) * 359.9;
  const colors = bandGradient[band || 'neutral'] || bandGradient.neutral;
  const rect = { x: stroke / 2, y: stroke / 2, width: 2 * r, height: 2 * r };

  const track = Skia.Path.Make();
  track.addArc(rect, -90, 360);
  const arc = Skia.Path.Make();
  arc.addArc(rect, -90, sweep);

  return (
    <Canvas style={{ width: size, height: size }}>
      <Path path={track} style="stroke" strokeWidth={stroke} color="rgba(0,0,0,0.06)" strokeCap="round" />
      <Path path={arc} style="stroke" strokeWidth={stroke} strokeCap="round">
        <SweepGradient c={vec(cx, cy)} colors={colors} />
      </Path>
    </Canvas>
  );
}
```

---

## 8. `src/components/RecoveryCard.tsx` — add the arc import

- [ ] **FIND:**
```tsx
import { RecoveryOrb } from './RecoveryOrb';
```
- [ ] **REPLACE WITH:**
```tsx
import { RecoveryOrb } from './RecoveryOrb';
import { ProgressArc } from './viz/ProgressArc';
```

## 9. `src/components/RecoveryCard.tsx` — wrap the orb in the arc

- [ ] **FIND:**
```tsx
        <RecoveryOrb score={recovery.score} band={recovery.band} size={96} />
```
- [ ] **REPLACE WITH:**
```tsx
        <View style={{ width: 104, height: 104, alignItems: 'center', justifyContent: 'center' }}>
          <View style={{ position: 'absolute' }}>
            <ProgressArc score={recovery.score} band={recovery.band} size={104} />
          </View>
          <RecoveryOrb score={recovery.score} band={recovery.band} size={84} />
        </View>
```

---

## 10. (Optional) heavier orb numerals — `src/components/RecoveryOrb.tsx`

- [ ] At the top, ensure `FONTS` is imported:
```tsx
import { bandGradient, glow, FONTS } from '../theme';
```
- [ ] **FIND:**
```tsx
  score: { color: '#FFFFFF', fontWeight: '800', letterSpacing: -1, marginBottom: -3 },
```
- [ ] **REPLACE WITH:**
```tsx
  score: { color: '#FFFFFF', fontFamily: FONTS.displayHeavy, fontWeight: '800', letterSpacing: -1, marginBottom: -3 },
```

---

## 11. Verify, build, ship

- [ ] `npx tsc --noEmit` → no errors.
- [ ] `eas build --profile development --platform ios` (native modules → must be a build, NOT an OTA update).
- [ ] Install on device; confirm: custom type app-wide, gradient arc around the recovery orb, no crash.
- [ ] `git add -A && git commit && git push`.
- [ ] Tell the agent: **"fonts + Skia are installed."**

---

## 12. (Agent, OTA after rebuild) swap continuous-metric bars → Skia lines

The trend charts already ship as RN bars (`viz/MiniBars`). Once Skia is in the
binary, the agent swaps the **continuous** signals to the gradient `Sparkline`
(line/area) and leaves **discrete** amounts as bars — OTA-safe once the native
module exists. No action from you; listed so the plan is captured.

- Continuous → `Sparkline` (line): recovery trend (`RecoveryCard`), net worth
  (`WealthCard`), HRV & resting-HR rows (`HealthCard`).
- Stay bars (`MiniBars`): steps, active energy, sleep; habit adherence stays
  dots (`viz/DotRow`).
- Also wire `Sparkline` into the asset-mix card and tune the per-surface type
  scale now that the custom font is live.
