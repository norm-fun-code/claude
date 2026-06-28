# Native design upgrades — custom type + Skia charts

The OTA design pass (orb, grade orb, hero glow, gradient buttons, soft elevation,
lit hero card) is already live. The two highest-impact remaining levers — a
**custom typeface** and **Skia charts/arcs** — need npm packages that the
agent's sandbox can't reach. This doc makes them a ~10-minute paste job in an
environment with network access, plus **one full EAS build** (native modules, not
OTA).

The scaffolding is already in place (`src/theme.ts` → `FONTS`), so the font is a
one-line activation.

---

## 1. Install (network required)

```bash
cd mobile
npx expo install expo-font \
  @expo-google-fonts/sora @expo-google-fonts/inter \
  @shopify/react-native-skia
```

Then build natively (these are native modules — OTA won't pick them up):

```bash
eas build --profile development --platform ios   # or your usual profile
```

---

## 2. Custom type — Sora (display) + Inter (text)

### a) Load the fonts in `App.tsx`

Add the imports near the top:

```tsx
import { useFonts, Sora_600SemiBold, Sora_700Bold, Sora_800ExtraBold } from '@expo-google-fonts/sora';
import { Inter_400Regular, Inter_500Medium, Inter_600SemiBold, Inter_700Bold } from '@expo-google-fonts/inter';
```

Inside the `App` component, before the first `return`:

```tsx
const [fontsLoaded] = useFonts({
  Sora_600SemiBold, Sora_700Bold, Sora_800ExtraBold,
  Inter_400Regular, Inter_500Medium, Inter_600SemiBold, Inter_700Bold,
});
if (!fontsLoaded) return null; // brief blank frame; or render a splash
```

### b) Flip the type system on — `src/theme.ts`

Change the `FONTS` object (already scaffolded — every `typography.*` token reads
from it, so this single edit re-types the whole app):

```ts
export const FONTS: { display?: string; text?: string } = {
  display: 'Sora_700Bold',     // headlines + numbers
  text: 'Inter_400Regular',    // body, captions, labels
};
```

> Weight-specific families (e.g. `Sora_700Bold`) ignore `fontWeight`, which is
> fine. For finer control, set per-weight families directly in the relevant
> tokens (e.g. `subtitle.fontFamily = 'Inter_600SemiBold'`,
> `label.fontFamily = 'Inter_600SemiBold'`).

### c) The Recovery Orb numerals (optional, recommended)

In `src/components/RecoveryOrb.tsx`, give the score a heavier display face — add
`fontFamily: FONTS.displayHeavy` and extend `FONTS` with
`displayHeavy: 'Sora_800ExtraBold'`. Big numbers in a geometric display face is
the single most "designed" detail.

---

## 3. Skia — gradient charts + a true progress arc

Create `src/components/viz/Sparkline.tsx` (gradient area line for trends/sleep/
HRV history):

```tsx
import React from 'react';
import { Canvas, Path, Skia, LinearGradient, vec } from '@shopify/react-native-skia';

interface Props { values: number[]; width: number; height: number; color?: string; }

export function Sparkline({ values, width, height, color = '#5A52F0' }: Props) {
  if (values.length < 2) return null;
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
        <LinearGradient start={vec(0, 0)} end={vec(0, height)}
          colors={[color + '55', color + '00']} />
      </Path>
      <Path path={line} style="stroke" strokeWidth={2.5} strokeCap="round" color={color} />
    </Canvas>
  );
}
```

Create `src/components/viz/ProgressArc.tsx` (a true Oura-style arc for the
recovery orb — wrap it around `RecoveryOrb`):

```tsx
import React from 'react';
import { Canvas, Path, Skia, SweepGradient, vec } from '@shopify/react-native-skia';
import { bandGradient } from '../../theme';

interface Props { score: number; band?: string; size: number; stroke?: number; }

export function ProgressArc({ score, band, size, stroke = 7 }: Props) {
  const r = (size - stroke) / 2;
  const cx = size / 2, cy = size / 2;
  const sweep = Math.max(0, Math.min(1, score / 100)) * 359.9;
  const colors = bandGradient[band || 'neutral'] || bandGradient.neutral;

  const track = Skia.Path.Make();
  track.addArc({ x: stroke / 2, y: stroke / 2, width: 2 * r, height: 2 * r }, -90, 360);
  const arc = Skia.Path.Make();
  arc.addArc({ x: stroke / 2, y: stroke / 2, width: 2 * r, height: 2 * r }, -90, sweep);

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

Usage in `RecoveryCard.tsx` — layer the arc behind the orb (orb slightly smaller):

```tsx
<View style={{ width: 104, height: 104, alignItems: 'center', justifyContent: 'center' }}>
  <View style={{ position: 'absolute' }}>
    <ProgressArc score={recovery.score} band={recovery.band} size={104} />
  </View>
  <RecoveryOrb score={recovery.score} band={recovery.band} size={84} />
</View>
```

Then use `<Sparkline values={...} width={...} height={40} />` in the trends and
allocation cards in place of the dot-grid / flat bar.

---

## 4. After it builds

- The whole app adopts Sora/Inter from one `FONTS` edit.
- Recovery shows a real gradient arc + glowing orb.
- Trends/allocation get gradient sparklines.

Ping the agent ("fonts + Skia are installed") and it will wire the charts into the
specific cards and tune the type scale per surface.
