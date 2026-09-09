import React, { useEffect, useState } from 'react';
import { ActivityIndicator, AppState, Modal, Platform, Pressable, SafeAreaView, ScrollView, StyleSheet, Text, TextInput, View, useColorScheme } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { getColors, FONTS, radius, spacing, typography } from '../theme';
import { useFocusSession } from '../hooks/useFocusSession';
import { useReducedMotion } from '../lib/useReducedMotion';
import { EMPTY_DECISION, LENSES, decisionError, decisionPrompt, focusClock, focusRemaining, pauseFocus, resumeFocus, startFocus, type DecisionDraft, type DecisionLens, type FocusSession } from '../lib/nextMove';

type Mode = 'decide' | 'focus';
type Colors = ReturnType<typeof getColors>;
const PRESETS: { label: string; draft: DecisionDraft }[] = [
  { label: 'Protect my evening', draft: { question: 'How should I spend my evening?', optionA: 'Make progress on one important task', optionB: 'Keep the evening open for connection and rest', constraint: '', lens: 'energy' } },
  { label: 'Make room this week', draft: { question: 'What should I make room for this week?', optionA: 'Keep my current commitments', optionB: 'Defer one commitment to protect time for what matters most', constraint: '', lens: 'time' } },
];

function Button({ label, onPress, colors: c, primary = false, disabled = false }: { label: string; onPress: () => void; colors: Colors; primary?: boolean; disabled?: boolean }) {
  return <Pressable accessibilityRole="button" accessibilityState={{ disabled }} disabled={disabled} onPress={onPress}
    style={({ pressed }) => [s.button, { backgroundColor: primary ? c.accent : c.card, borderColor: primary ? c.accent : c.border, opacity: disabled ? 0.4 : pressed ? 0.7 : 1 }]}>
    <Text style={[s.buttonText, { color: primary ? '#FFFFFF' : c.text }]}>{label}</Text>
  </Pressable>;
}

function Field({ label, value, onChangeText, placeholder, maxLength = 500, colors: c }: { label: string; value: string; onChangeText: (text: string) => void; placeholder: string; maxLength?: number; colors: Colors }) {
  return <View style={s.field}>
    <Text style={[s.fieldLabel, { color: c.text }]}>{label}</Text>
    <TextInput value={value} onChangeText={onChangeText} placeholder={placeholder} placeholderTextColor={c.subtext}
      accessibilityLabel={label} multiline maxLength={maxLength} textAlignVertical="top"
      style={[s.input, { color: c.text, borderColor: c.border, backgroundColor: c.card }]} />
  </View>;
}

function FocusRunning({ session, onUpdate, c }: { session: FocusSession; onUpdate: (next: FocusSession | null) => void; c: Colors }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    const sub = AppState.addEventListener('change', state => { if (state === 'active') setNow(Date.now()); });
    return () => { clearInterval(timer); sub.remove(); };
  }, []);
  const left = focusRemaining(session, now);
  const done = left === 0;
  const paused = session.endsAt === null && !done;
  return <>
    <LinearGradient colors={['#211F45', '#10111F']} style={s.focusHero}>
      <View style={s.orbit} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
        <View style={s.orbitInner}><Ionicons name={done ? 'checkmark' : paused ? 'pause' : 'leaf-outline'} color="#C9C5FF" size={32} /></View>
      </View>
      <Text style={s.eyebrow}>{done ? 'SPACE WELL SPENT' : paused ? 'TAKE YOUR TIME' : 'ONE THING AT A TIME'}</Text>
      <Text style={s.focusTitle}>{session.title}</Text>
      <Text style={s.clock} accessibilityLabel={`${Math.ceil(left / 60000)} minutes remaining`}>{focusClock(left)}</Text>
      <View style={s.progressTrack} accessible accessibilityRole="progressbar" accessibilityLabel="Focus time elapsed"
        accessibilityValue={{ min: 0, max: 100, now: Math.round((1 - left / session.durationMs) * 100) }}>
        <View style={[s.progressFill, { width: `${Math.round((1 - left / session.durationMs) * 100)}%` }]} />
      </View>
      <Text style={s.heroNote}>{done ? 'Time is up. You decide whether the work is done.' : paused ? 'Paused. Pick it back up when you’re ready.' : 'You can leave the app. Your timer keeps its place.'}</Text>
    </LinearGradient>
    {!done && <Button label={paused ? 'Resume focus' : 'Pause'} primary colors={c} onPress={() => onUpdate(paused ? resumeFocus(session, Date.now()) : pauseFocus(session, Date.now()))} />}
    <Button label={done ? 'Close session' : 'End session'} colors={c} onPress={() => { onUpdate(null); void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success); }} />
    <Text style={[s.note, { color: c.subtext }]}>A timer for your attention. Closing it does not mark a goal or commitment complete. No background alarm.</Text>
  </>;
}

/** Always mounted at App level so drafts and a running session survive tab changes. */
export function NextMove({ visible, onClose, mode: initialMode, suggestedAction, onAsk, focus }: {
  visible: boolean; onClose: () => void; mode: Mode; suggestedAction?: string | null;
  onAsk: (prompt: string) => void; focus: ReturnType<typeof useFocusSession>;
}) {
  const c = getColors(useColorScheme() === 'dark');
  const reducedMotion = useReducedMotion();
  const [mode, setMode] = useState<Mode>(initialMode);
  const [draft, setDraft] = useState<DecisionDraft>({ ...EMPTY_DECISION });
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [minutes, setMinutes] = useState(25);
  useEffect(() => { if (visible) setMode(initialMode); }, [visible, initialMode]);
  const change = (key: keyof DecisionDraft, value: string) => { setDraft(d => ({ ...d, [key]: value })); setError(null); };
  return <Modal visible={visible} animationType={reducedMotion ? 'none' : 'slide'} presentationStyle="pageSheet" onRequestClose={onClose}>
    <SafeAreaView style={[s.sheet, { backgroundColor: c.background }]}>
      <View style={[s.sheetHeader, { borderColor: c.border }]}>
        <Text style={[s.sheetTitle, { color: c.text }]}>Your next move</Text>
        <Pressable accessibilityRole="button" accessibilityLabel="Close next move" onPress={onClose} style={s.close}>
          <Ionicons name="close" size={24} color={c.text} />
        </Pressable>
      </View>
      <ScrollView contentContainerStyle={s.sheetContent} keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets={Platform.OS === 'ios'}>
        <View style={[s.segments, { backgroundColor: c.card }]}>
          {(['decide', 'focus'] as const).map(m => <Pressable key={m} accessibilityRole="tab" accessibilityState={{ selected: mode === m }} onPress={() => setMode(m)}
            style={[s.segment, { backgroundColor: mode === m ? c.accentSoft : 'transparent' }]}>
            <Ionicons name={m === 'decide' ? 'git-compare-outline' : 'scan-outline'} size={18} color={mode === m ? c.accent : c.subtext} />
            <Text style={[s.segmentText, { color: mode === m ? c.accent : c.subtext }]}>{m === 'decide' ? 'Decision Studio' : 'Focus'}</Text>
          </Pressable>)}
        </View>
        {mode === 'decide' ? <>
          <Text style={[s.headline, { color: c.text }]}>See both futures.</Text>
          <Text style={[s.description, { color: c.subtext }]}>Put two possibilities beside each other. Think them through with the context NormOS already has.</Text>
          <View style={s.presetRow}>{PRESETS.map(p => <Pressable key={p.label} accessibilityRole="button" onPress={() => { setDraft({ ...p.draft }); setError(null); }} style={[s.chip, { borderColor: c.border, backgroundColor: c.card }]}><Text style={[s.chipText, { color: c.accent }]}>{p.label}</Text></Pressable>)}</View>
          <Field label="The decision" value={draft.question} onChangeText={v => change('question', v)} placeholder="What are you weighing?" colors={c} />
          <View style={[s.option, { borderLeftColor: '#A89CFF' }]}><Field label="Option A" value={draft.optionA} onChangeText={v => change('optionA', v)} placeholder="One direction…" colors={c} /></View>
          <View style={[s.option, { borderLeftColor: '#64DCC5' }]}><Field label="Option B" value={draft.optionB} onChangeText={v => change('optionB', v)} placeholder="Another direction…" colors={c} /></View>
          <Text style={[s.fieldLabel, { color: c.text }]}>What matters most?</Text>
          <View style={s.presetRow}>{(Object.keys(LENSES) as DecisionLens[]).map(lens => <Pressable key={lens} accessibilityRole="radio" accessibilityState={{ checked: draft.lens === lens }} onPress={() => change('lens', lens)}
            style={[s.chip, { borderColor: draft.lens === lens ? c.accent : c.border, backgroundColor: draft.lens === lens ? c.accentSoft : c.card }]}><Text style={[s.chipText, { color: draft.lens === lens ? c.accent : c.text }]}>{LENSES[lens]}</Text></Pressable>)}</View>
          <Field label="Anything to protect? (optional)" value={draft.constraint} onChangeText={v => change('constraint', v)} placeholder="Time with Nancy, a deadline, a spending limit…" maxLength={1000} colors={c} />
          <View style={[s.outputPreview, { backgroundColor: c.accentSoft }]}>
            <Ionicons name="sparkles-outline" size={20} color={c.accent} />
            <Text style={[s.previewText, { color: c.text }]}>The tradeoffs. The counterargument. What would change the answer. One small next step.</Text>
          </View>
          {error && <Text accessibilityRole="alert" style={[s.error, { color: c.red }]}>{error}</Text>}
          <Button label="Review in Ask →" primary colors={c} onPress={() => { const e = decisionError(draft); setError(e); if (!e) onAsk(decisionPrompt(draft)); }} />
          <Text style={[s.note, { color: c.subtext }]}>Opens an editable question in Ask. Send when you’re ready; your options are hypothetical.</Text>
        </> : focus.session ? <FocusRunning session={focus.session} onUpdate={focus.update} c={c} /> : <>
          <Text style={[s.headline, { color: c.text }]}>Make a little room.</Text>
          <Text style={[s.description, { color: c.subtext }]}>Choose one thing. Give it your attention. Everything else can wait.</Text>
          <Field label="What is this time for?" value={title} onChangeText={setTitle} placeholder="A first draft. A walk. Time together." colors={c} />
          {!!suggestedAction && <Pressable accessibilityRole="button" onPress={() => setTitle(suggestedAction.slice(0, 500))} style={[s.suggestion, { backgroundColor: c.card, borderColor: c.border }]}>
            <Text style={[s.fieldLabel, { color: c.accent }]}>Use the action from your brief ↗</Text>
            <Text numberOfLines={3} style={[s.description, { color: c.text }]}>{suggestedAction}</Text>
          </Pressable>}
          <Text style={[s.fieldLabel, { color: c.text }]}>How much space?</Text>
          <View style={s.presetRow}>{[15, 25, 45].map(n => <Pressable key={n} accessibilityRole="radio" accessibilityState={{ checked: minutes === n }} onPress={() => setMinutes(n)} style={[s.duration, { borderColor: minutes === n ? c.accent : c.border, backgroundColor: minutes === n ? c.accentSoft : c.card }]}>
            <Text style={[s.durationNumber, { color: minutes === n ? c.accent : c.text }]}>{n}</Text><Text style={[s.chipText, { color: c.subtext }]}>minutes</Text>
          </Pressable>)}</View>
          <Button label="Begin focus" primary colors={c} disabled={!title.trim() || !focus.ready} onPress={() => { focus.update(startFocus(title, minutes, Date.now())); void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); }} />
          {!focus.ready && !focus.error && <ActivityIndicator color={c.accent} />}
          <Text style={[s.note, { color: c.subtext }]}>Your session is saved on this device and resumes across app launches. No streaks. Just space.</Text>
        </>}
        {mode === 'focus' && focus.error && <View><Text accessibilityRole="alert" style={[s.error, { color: c.red }]}>{focus.error}</Text><Button label="Retry" onPress={focus.retry} colors={c} /></View>}
      </ScrollView>
    </SafeAreaView>
  </Modal>;
}

export function NextMoveCard({ onOpen, session }: { onOpen: (mode: Mode) => void; session: FocusSession | null }) {
  return <LinearGradient colors={['#272348', '#151A2B']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={s.card}>
    <View style={s.cardTop}><Text style={s.eyebrow}>ROOM FOR WHAT MATTERS</Text><Ionicons name="sparkles-outline" size={20} color="#BDB5FF" /></View>
    <Text style={s.cardTitle}>Your next move.</Text>
    <Text style={s.cardDescription}>Think it through. Then make time for it.</Text>
    <View style={s.cardActions}>
      <Pressable accessibilityRole="button" onPress={() => onOpen('decide')} style={({ pressed }) => [s.cardAction, { backgroundColor: pressed ? '#8278ED' : '#BDB5FF' }]}><Ionicons name="git-compare-outline" size={18} color="#1C1638" /><Text style={s.cardActionText}>Think it through</Text></Pressable>
      <Pressable accessibilityRole="button" onPress={() => onOpen('focus')} style={({ pressed }) => [s.cardAction, s.secondaryAction, { opacity: pressed ? 0.7 : 1 }]}><Ionicons name="scan-outline" size={18} color="#E0DDF8" /><Text style={[s.cardActionText, { color: '#E0DDF8' }]}>{session ? 'Open focus' : 'Make time'}</Text></Pressable>
    </View>
    {!!session && <Text style={s.savedSession} numberOfLines={2}>Your focus · {session.title}</Text>}
  </LinearGradient>;
}

const s = StyleSheet.create({
  card: { borderRadius: radius.xl, padding: 22, marginBottom: spacing.md, borderWidth: 1, borderColor: '#443E67' },
  cardTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  eyebrow: { fontFamily: FONTS.text, fontSize: 10, fontWeight: '700', letterSpacing: 1.7, color: '#BDB5E3', flexShrink: 1 },
  cardTitle: { fontFamily: FONTS.display, fontSize: 27, color: '#F7F6FF', marginTop: 18, letterSpacing: -0.7 },
  cardDescription: { ...typography.body, color: '#C9C5DE', marginTop: 6 },
  cardActions: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 20 },
  cardAction: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, minHeight: 48, paddingHorizontal: 14, paddingVertical: 12, borderRadius: 14, flexGrow: 1 },
  secondaryAction: { backgroundColor: '#FFFFFF0D', borderWidth: 1, borderColor: '#68627E' },
  cardActionText: { fontFamily: FONTS.text, fontSize: 13, fontWeight: '600', color: '#1C1638' },
  savedSession: { ...typography.caption, color: '#C9C5DE', marginTop: 16 },
  sheet: { flex: 1 },
  sheetHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingLeft: 22, paddingRight: 10, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth },
  sheetTitle: { fontFamily: FONTS.display, fontSize: 18, flex: 1 },
  close: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  sheetContent: { padding: 22, paddingBottom: 48 },
  segments: { flexDirection: 'row', borderRadius: 16, padding: 4, gap: 4, marginBottom: 26 },
  segment: { flex: 1, flexDirection: 'row', gap: 7, minHeight: 48, padding: 8, justifyContent: 'center', alignItems: 'center', borderRadius: 12 },
  segmentText: { fontSize: 13, fontWeight: '600', flexShrink: 1 },
  headline: { fontFamily: FONTS.display, fontSize: 30, letterSpacing: -0.8, marginBottom: 10 },
  description: { ...typography.body, marginBottom: 16 },
  presetRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 10, marginBottom: 22 },
  chip: { minHeight: 44, justifyContent: 'center', borderWidth: 1, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10 },
  chipText: { fontFamily: FONTS.text, fontSize: 13 },
  field: { marginBottom: 18 },
  fieldLabel: { ...typography.body, fontWeight: '600', marginBottom: 8 },
  input: { ...typography.body, minHeight: 58, borderWidth: 1, borderRadius: 14, padding: 14 },
  option: { borderLeftWidth: 3, paddingLeft: 14 },
  outputPreview: { flexDirection: 'row', gap: 12, padding: 16, borderRadius: 14, marginBottom: 18 },
  previewText: { ...typography.body, flex: 1, fontSize: 14 },
  button: { minHeight: 50, alignItems: 'center', justifyContent: 'center', padding: 14, borderRadius: 14, borderWidth: 1, marginBottom: 10 },
  buttonText: { ...typography.body, fontWeight: '600', textAlign: 'center' },
  note: { ...typography.caption, lineHeight: 19, textAlign: 'center', marginTop: 8, marginBottom: 16 },
  error: { ...typography.body, marginBottom: 12 },
  suggestion: { borderWidth: 1, padding: 16, borderRadius: 14, marginBottom: 24 },
  duration: { flex: 1, minWidth: 75, alignItems: 'center', padding: 16, borderWidth: 1, borderRadius: 16, gap: 4 },
  durationNumber: { fontFamily: FONTS.display, fontSize: 26 },
  focusHero: { alignItems: 'center', borderRadius: 26, paddingHorizontal: 24, paddingVertical: 32, marginBottom: 22 },
  orbit: { width: 120, height: 120, borderRadius: 60, borderWidth: 1, borderColor: '#686188', alignItems: 'center', justifyContent: 'center', marginBottom: 24 },
  orbitInner: { width: 88, height: 88, borderRadius: 44, borderWidth: 1, borderColor: '#8C80C4', backgroundColor: '#A89CFF19', alignItems: 'center', justifyContent: 'center' },
  focusTitle: { fontFamily: FONTS.display, fontSize: 22, lineHeight: 31, textAlign: 'center', color: '#F7F6FF', marginTop: 14 },
  clock: { fontFamily: FONTS.displayLight, fontSize: 58, letterSpacing: -2, fontVariant: ['tabular-nums'], color: '#ECE9FF', marginVertical: 24 },
  progressTrack: { height: 4, width: '100%', backgroundColor: '#4A435F', borderRadius: 2, overflow: 'hidden' },
  progressFill: { height: 4, backgroundColor: '#BDB5FF' },
  heroNote: { ...typography.caption, lineHeight: 20, color: '#BDB5D1', textAlign: 'center', marginTop: 18 },
});
