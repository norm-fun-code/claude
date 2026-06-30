import React, { useState, useEffect } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Modal, TextInput, KeyboardAvoidingView, Platform, ScrollView } from 'react-native';
import { getColors, spacing, radius, shadow } from '../theme';
import { API_BASE, WORKOUT_LOG_URL, WORKOUT_OVERRIDE_URL, WORKOUT_OVERRIDES_URL, ACTIVITY_URL, authHeaders, fetchWithTimeout, localTz } from '../config';
import {
  getTodaysWorkout,
  HRV_ZONES,
  WEEKLY_SCHEDULE,
  SESSION_A,
  SESSION_B,
  ZONE2,
  INTERVALS,
  MOBILITY,
  REST,
  type AnySession,
  type StrengthSession,
  type Zone2Session,
  type IntervalsSession,
  type MobilitySession,
  type RestSession,
  type Exercise,
  type HRVZone,
} from '../data/workouts';

interface Props {
  hrv: number | null;
  isDark: boolean;
  // Baseline-relative recovery band (from the Recovery card). When present and
  // viewing today, it drives workout downgrades instead of absolute HRV cutoffs,
  // so training guidance matches the Recovery score.
  recoveryBand?: 'green' | 'yellow' | 'red' | null;
  // Composite recovery score (0–100) shown in the zone pill instead of raw HRV
  // when the zone is recovery-driven, so the source of truth is unambiguous.
  recoveryScore?: number | null;
}

const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

const WORKOUT_TYPE_COLORS: Record<string, string> = {
  zone2: '#1D9E75',
  mobility: '#534AB7',
  intervals: '#993C1D',
  push: '#0C447C',
  pull: '#0C447C',
  rest: '#666666',
};

function getWeekDayWorkoutId(dayIndex: number): string {
  const scheduleDay = (dayIndex + 1) % 7;
  return WEEKLY_SCHEDULE[scheduleDay] ?? 'rest';
}

function getWorkoutShortLabel(id: string): string {
  switch (id) {
    case 'zone2': return 'Zone 2';
    case 'mobility': return 'Mobility';
    case 'intervals': return 'Intervals';
    case 'push': return 'Push';
    case 'pull': return 'Pull';
    case 'rest': return 'Rest';
    default: return 'Rest';
  }
}

// Sessions the user can manually swap a day to (each has a full logging view).
const SWAP_CHOICES = ['push', 'pull', 'zone2', 'intervals', 'mobility', 'rest'];

const ET_TZ = localTz();

// JS day-of-week (0=Sun..6=Sat) in Eastern Time, matching the backend.
function getEasternDay(): number {
  const wd = new Intl.DateTimeFormat('en-US', { timeZone: ET_TZ, weekday: 'short' }).format(new Date());
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(wd);
}

// Today's date as YYYY-MM-DD in Eastern Time.
function getEasternDateString(offsetDays = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return new Intl.DateTimeFormat('en-CA', { timeZone: ET_TZ }).format(d);
}

function getTodayDayIndex(): number {
  const jsDay = getEasternDay();
  return (jsDay + 6) % 7;
}

function getDateKey(dayIndex: number): string {
  const todayIndex = getTodayDayIndex();
  return getEasternDateString(dayIndex - todayIndex);
}

function Checkbox({
  checked,
  onPress,
  accentColor,
}: {
  checked: boolean;
  onPress: () => void;
  accentColor: string;
}) {
  return (
    <TouchableOpacity
      onPress={onPress}
      style={[
        cbStyles.box,
        checked
          ? { backgroundColor: accentColor, borderColor: accentColor }
          : { backgroundColor: 'transparent', borderColor: '#999' },
      ]}
      activeOpacity={0.7}
    >
      {checked && <Text style={cbStyles.check}>✓</Text>}
    </TouchableOpacity>
  );
}

const cbStyles = StyleSheet.create({
  box: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  check: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '700',
    lineHeight: 16,
  },
});

function WeeklyStrip({
  c,
  isDark,
  weeklyCompleted,
  selectedDayIndex,
  onDayPress,
  swapByDay,
}: {
  c: ReturnType<typeof getColors>;
  isDark: boolean;
  weeklyCompleted: Record<string, boolean>;
  selectedDayIndex: number;
  onDayPress: (dayIndex: number) => void;
  swapByDay: Record<string, string>;
}) {
  const todayIndex = getTodayDayIndex();

  return (
    <View style={stripStyles.row}>
      {DAY_LABELS.map((day, i) => {
        const isToday = i === todayIndex;
        const isSelected = i === selectedDayIndex;
        const isPast = i < todayIndex;
        const dateKey = getDateKey(i);
        const done = !!weeklyCompleted[dateKey];
        const workoutId = swapByDay[dateKey] ?? getWeekDayWorkoutId(i);
        const dotColor = WORKOUT_TYPE_COLORS[workoutId] ?? '#666';
        const shortLabel = getWorkoutShortLabel(workoutId);

        return (
          <TouchableOpacity
            key={day}
            style={[
              stripStyles.dayCell,
              {
                backgroundColor: isSelected
                  ? isDark ? '#1C2A3A' : '#EBF3FF'
                  : c.card,
                borderColor: isSelected ? '#0C447C' : isToday ? '#0C447C' : c.border,
                borderWidth: isSelected || isToday ? 1.5 : 1,
              },
            ]}
            onPress={() => onDayPress(i)}
            activeOpacity={0.7}
          >
            <Text style={[stripStyles.dayName, { color: isSelected || isToday ? '#0C447C' : c.subtext }]}>
              {isToday ? 'Today' : day}
            </Text>
            {done ? (
              <Text style={stripStyles.checkmark}>✓</Text>
            ) : (
              <View style={[stripStyles.dot, { backgroundColor: dotColor, opacity: isPast ? 0.4 : 1 }]} />
            )}
            <Text
              style={[
                stripStyles.typeLabel,
                { color: isPast || isSelected ? dotColor : c.subtext },
              ]}
              numberOfLines={1}
            >
              {shortLabel}
            </Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

const stripStyles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    gap: 4,
    marginBottom: spacing.md,
  },
  dayCell: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 8,
    paddingHorizontal: 2,
    borderRadius: radius.md,
    borderWidth: 1,
    gap: 4,
  },
  dayName: {
    fontSize: 10,
    fontWeight: '600',
    letterSpacing: 0.3,
  },
  dot: {
    width: 7,
    height: 7,
    borderRadius: 4,
  },
  checkmark: {
    fontSize: 12,
    color: '#1D9E75',
    fontWeight: '700',
    lineHeight: 14,
  },
  typeLabel: {
    fontSize: 8,
    fontWeight: '500',
    textAlign: 'center',
  },
});

function HRVHeaderCard({
  c,
  isDark,
  hrv,
  zone,
  workoutLabel,
  workoutDuration,
  override,
  recoveryScore,
}: {
  c: ReturnType<typeof getColors>;
  isDark: boolean;
  hrv: number | null;
  zone: HRVZone;
  workoutLabel: string;
  workoutDuration?: string;
  override?: string;
  recoveryScore?: number | null;
}) {
  const bgTag = isDark ? '#2A2A28' : '#F3F3F0';

  const zoneConfig =
    zone !== 'unknown'
      ? HRV_ZONES[zone as 'green' | 'yellow' | 'red']
      : null;

  // Show recovery score when it's available (zone is recovery-driven); fall back
  // to raw HRV so the source of the zone label is always unambiguous.
  const pillLabel = recoveryScore != null
    ? `${zone.toUpperCase()} · ${recoveryScore}% recovery`
    : hrv != null
      ? `${zone.toUpperCase()} · ${hrv} ms HRV`
      : zone.toUpperCase();

  return (
    <View style={[cardStyles.card, { backgroundColor: c.card }, shadow(isDark)]}>
      <Text style={[cardStyles.workoutLabel, { color: c.text }]}>{workoutLabel}</Text>
      {workoutDuration && (
        <View style={[cardStyles.durationTag, { backgroundColor: bgTag }]}>
          <Text style={[cardStyles.durationText, { color: c.subtext }]}>⏱ {workoutDuration}</Text>
        </View>
      )}

      <View style={cardStyles.zoneRow}>
        {zoneConfig ? (
          <View style={[cardStyles.zonePill, { backgroundColor: zoneConfig.color + '22', borderColor: zoneConfig.color }]}>
            <Text style={[cardStyles.zoneText, { color: zoneConfig.color }]}>
              {pillLabel}
            </Text>
          </View>
        ) : (
          <View style={[cardStyles.zonePill, { backgroundColor: bgTag, borderColor: c.border }]}>
            <Text style={[cardStyles.zoneText, { color: c.subtext }]}>Recovery unknown</Text>
          </View>
        )}
      </View>

      {zoneConfig ? (
        <Text style={[cardStyles.instruction, { color: c.subtext }]}>{zoneConfig.instruction}</Text>
      ) : (
        <Text style={[cardStyles.instruction, { color: c.subtext }]}>
          No HRV data — showing scheduled workout.
        </Text>
      )}

      {override && (
        <View style={[cardStyles.overrideBanner, { backgroundColor: isDark ? '#2A1A0A' : '#FFF4E5', borderColor: '#BA7517' }]}>
          <Text style={[cardStyles.overrideText, { color: '#BA7517' }]}>{override}</Text>
        </View>
      )}
    </View>
  );
}

const cardStyles = StyleSheet.create({
  card: {
    borderRadius: radius.lg,
    padding: spacing.md,
    marginBottom: spacing.md,
    gap: spacing.sm,
  },
  workoutLabel: {
    fontSize: 20,
    fontWeight: '700',
    letterSpacing: -0.4,
  },
  durationTag: {
    alignSelf: 'flex-start',
    borderRadius: radius.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  durationText: {
    fontSize: 13,
    fontWeight: '500',
  },
  zoneRow: {
    flexDirection: 'row',
    marginTop: spacing.xs,
  },
  zonePill: {
    borderRadius: 20,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 4,
  },
  zoneText: {
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 0.5,
  },
  instruction: {
    fontSize: 14,
    lineHeight: 20,
  },
  overrideBanner: {
    borderRadius: radius.sm,
    borderWidth: 1,
    padding: spacing.sm,
    marginTop: spacing.xs,
  },
  overrideText: {
    fontSize: 13,
    fontWeight: '600',
    lineHeight: 18,
  },
});

function LogModal({
  visible,
  exercise,
  setNumber,
  lastSets,
  day,
  c,
  isDark,
  onClose,
  onSaved,
}: {
  visible: boolean;
  exercise: string;
  setNumber: number;
  lastSets: Array<{set_number: number; reps: number | null; weight_lbs: number | null}>;
  day: string;
  c: ReturnType<typeof getColors>;
  isDark: boolean;
  onClose: () => void;
  onSaved: (setNum: number, reps: number | null, weight: number | null) => void;
}) {
  const lastSet = lastSets.find(s => s.set_number === setNumber);
  const [reps, setReps] = useState(lastSet?.reps != null ? String(lastSet.reps) : '');
  const [weight, setWeight] = useState(lastSet?.weight_lbs != null ? String(lastSet.weight_lbs) : '');
  const [saving, setSaving] = useState(false);

  React.useEffect(() => {
    const ls = lastSets.find(s => s.set_number === setNumber);
    setReps(ls?.reps != null ? String(ls.reps) : '');
    setWeight(ls?.weight_lbs != null ? String(ls.weight_lbs) : '');
  }, [exercise, setNumber]);

  async function save() {
    setSaving(true);
    try {
      await fetchWithTimeout(WORKOUT_LOG_URL, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          day,
          exercise,
          set_number: setNumber,
          reps: reps ? parseInt(reps) : null,
          weight_lbs: weight ? parseFloat(weight) : null,
        }),
      });
      onSaved(setNumber, reps ? parseInt(reps) : null, weight ? parseFloat(weight) : null);
      onClose();
    } catch { /* silent */ } finally {
      setSaving(false);
    }
  }

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={{ flex: 1 }}>
        <View style={{ flex: 1, justifyContent: 'flex-end' }}>
          <View style={[logStyles.sheet, { backgroundColor: c.card, borderColor: c.border }]}>
            <Text style={[logStyles.title, { color: c.text }]}>Log Set {setNumber} — {exercise}</Text>
            {lastSets.length > 0 && (
              <Text style={[logStyles.hint, { color: c.subtext }]}>
                Last: {lastSets.map(s => `${s.reps ?? '?'} × ${s.weight_lbs != null ? `${s.weight_lbs} lbs` : 'BW'}`).join(', ')}
              </Text>
            )}
            <View style={logStyles.row}>
              <View style={logStyles.inputWrap}>
                <Text style={[logStyles.inputLabel, { color: c.subtext }]}>Reps</Text>
                <TextInput
                  style={[logStyles.input, { color: c.text, borderColor: c.border, backgroundColor: isDark ? '#1C1C1A' : '#F9F8F6' }]}
                  value={reps}
                  onChangeText={setReps}
                  keyboardType="number-pad"
                  placeholder="—"
                  placeholderTextColor={c.subtext}
                />
              </View>
              <View style={logStyles.inputWrap}>
                <Text style={[logStyles.inputLabel, { color: c.subtext }]}>Weight (lbs)</Text>
                <TextInput
                  style={[logStyles.input, { color: c.text, borderColor: c.border, backgroundColor: isDark ? '#1C1C1A' : '#F9F8F6' }]}
                  value={weight}
                  onChangeText={setWeight}
                  keyboardType="decimal-pad"
                  placeholder="BW"
                  placeholderTextColor={c.subtext}
                />
              </View>
            </View>
            <View style={logStyles.buttons}>
              <TouchableOpacity onPress={onClose} style={[logStyles.btn, { borderColor: c.border }]}>
                <Text style={[logStyles.btnTxt, { color: c.subtext }]}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={save} disabled={saving} style={[logStyles.btn, logStyles.btnPrimary, { backgroundColor: c.accent }]}>
                <Text style={[logStyles.btnTxt, { color: '#FFF' }]}>{saving ? 'Saving…' : 'Save set'}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const logStyles = StyleSheet.create({
  sheet: { borderTopLeftRadius: 20, borderTopRightRadius: 20, borderTopWidth: 1, borderLeftWidth: 1, borderRightWidth: 1, padding: spacing.lg, paddingBottom: spacing.xl + 10 },
  title: { fontSize: 16, fontWeight: '700', marginBottom: spacing.xs },
  hint: { fontSize: 13, marginBottom: spacing.md },
  row: { flexDirection: 'row', gap: spacing.md, marginBottom: spacing.md },
  inputWrap: { flex: 1 },
  inputLabel: { fontSize: 12, fontWeight: '600', marginBottom: 4 },
  input: { borderWidth: 1, borderRadius: 8, padding: spacing.sm, fontSize: 18, fontWeight: '600', textAlign: 'center' },
  buttons: { flexDirection: 'row', gap: spacing.sm },
  btn: { flex: 1, borderRadius: 10, borderWidth: 1, paddingVertical: spacing.sm + 2, alignItems: 'center' },
  btnPrimary: { borderWidth: 0 },
  btnTxt: { fontSize: 15, fontWeight: '600' },
});

function ExerciseRow({
  exercise,
  completed,
  cueOpen,
  onToggleComplete,
  onToggleCue,
  isYellow,
  showSetsDimmed,
  c,
  isDark,
  day,
  loggedSets,
  lastHistory,
  onSetSaved,
  onAllSetsLogged,
}: {
  exercise: Exercise;
  completed: boolean;
  cueOpen: boolean;
  onToggleComplete: () => void;
  onToggleCue: () => void;
  isYellow: boolean;
  showSetsDimmed: boolean;
  c: ReturnType<typeof getColors>;
  isDark: boolean;
  day: string;
  loggedSets: Array<{set_number: number; reps: number | null; weight_lbs: number | null}>;
  lastHistory: Array<{set_number: number; reps: number | null; weight_lbs: number | null}>;
  onSetSaved?: (exercise: string, setNum: number, reps: number | null, weight: number | null) => void;
  onAllSetsLogged?: (exercise: string) => void;
}) {
  const bgTag = isDark ? '#2A2A28' : '#F3F3F0';
  const setsText = isYellow && showSetsDimmed
    ? exercise.sets.replace(/^3/, '2')
    : exercise.sets;
  const dimmed = isYellow && showSetsDimmed;
  const numSets = parseInt(exercise.sets) || 0;
  const [logModalSet, setLogModalSet] = useState<number | null>(null);

  return (
    <View style={[exStyles.row, { borderColor: c.border }]}>
      <View style={exStyles.topLine}>
        <Checkbox checked={completed} onPress={onToggleComplete} accentColor="#1D9E75" />
        <TouchableOpacity onPress={onToggleCue} style={exStyles.nameWrap} activeOpacity={0.7}>
          <Text style={[exStyles.name, { color: c.text, textDecorationLine: completed ? 'line-through' : 'none', opacity: completed ? 0.5 : 1 }]}>
            {exercise.name}
          </Text>
        </TouchableOpacity>
      </View>

      <View style={exStyles.tagsRow}>
        <View style={[exStyles.tag, { backgroundColor: bgTag }]}>
          <Text style={[exStyles.tagText, { color: c.subtext, textDecorationLine: dimmed ? 'line-through' : 'none' }]}>
            {setsText}
          </Text>
        </View>
        {exercise.rest && (
          <View style={[exStyles.tag, { backgroundColor: bgTag }]}>
            <Text style={[exStyles.tagText, { color: c.subtext }]}>{exercise.rest} rest</Text>
          </View>
        )}
        {exercise.load && (
          <View style={[exStyles.tag, { backgroundColor: bgTag }]}>
            <Text style={[exStyles.tagText, { color: c.subtext }]}>{exercise.load}</Text>
          </View>
        )}
      </View>

      {numSets > 0 && (
        <View style={exStyles.setRow}>
          {Array.from({length: numSets}, (_, i) => i + 1).map(setNum => {
            const logged = loggedSets.find(s => s.set_number === setNum);
            return (
              <TouchableOpacity
                key={setNum}
                onPress={() => setLogModalSet(setNum)}
                style={[exStyles.setBtn, { borderColor: logged ? '#1D9E75' : c.border, backgroundColor: logged ? '#1D9E7511' : 'transparent' }]}
              >
                <Text style={[exStyles.setBtnTxt, { color: logged ? '#1D9E75' : c.subtext }]}>
                  {logged ? `${logged.reps ?? '?'}${logged.weight_lbs ? `@${logged.weight_lbs}` : ''}` : `S${setNum}`}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>
      )}

      {cueOpen && exercise.cue && (
        <View style={[exStyles.cueBox, { backgroundColor: isDark ? '#1C1C1A' : '#F9F8F6', borderColor: c.border }]}>
          <Text style={[exStyles.cueText, { color: c.subtext }]}>{exercise.cue}</Text>
        </View>
      )}

      {logModalSet !== null && (
        <LogModal
          visible
          exercise={exercise.name}
          setNumber={logModalSet}
          lastSets={lastHistory}
          day={day}
          c={c}
          isDark={isDark}
          onClose={() => setLogModalSet(null)}
          onSaved={(setNum, reps, weight) => {
            setLogModalSet(null);
            onSetSaved?.(exercise.name, setNum, reps, weight);
            // When the final set's logged, auto-check the exercise's circle.
            const distinct = new Set(loggedSets.map((s) => s.set_number));
            distinct.add(setNum);
            if (numSets > 0 && distinct.size >= numSets && !completed) {
              onAllSetsLogged?.(exercise.name);
            }
          }}
        />
      )}
    </View>
  );
}

const exStyles = StyleSheet.create({
  row: {
    borderBottomWidth: 1,
    paddingVertical: spacing.sm,
    gap: spacing.xs,
  },
  topLine: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  nameWrap: {
    flex: 1,
  },
  name: {
    fontSize: 15,
    fontWeight: '600',
    letterSpacing: -0.2,
  },
  tagsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    paddingLeft: 30,
  },
  tag: {
    borderRadius: radius.sm,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  tagText: {
    fontSize: 12,
    fontWeight: '500',
  },
  cueBox: {
    marginLeft: 30,
    borderRadius: radius.sm,
    borderWidth: 1,
    padding: spacing.sm,
  },
  cueText: {
    fontSize: 13,
    lineHeight: 19,
  },
  setRow: { flexDirection: 'row', gap: 6, flexWrap: 'wrap', marginTop: 4, paddingLeft: 30 },
  setBtn: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6, borderWidth: 1 },
  setBtnTxt: { fontSize: 11, fontWeight: '600' },
});

function CollapsibleSection({
  title,
  c,
  isDark,
  children,
}: {
  title: string;
  c: ReturnType<typeof getColors>;
  isDark: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(true);
  const bg = isDark ? '#2A2A28' : '#F3F3F0';

  return (
    <View style={{ marginBottom: spacing.md }}>
      <TouchableOpacity
        onPress={() => setOpen((v) => !v)}
        style={[sectStyles.header, { backgroundColor: bg }]}
        activeOpacity={0.7}
      >
        <Text style={[sectStyles.headerText, { color: c.text }]}>{title}</Text>
        <Text style={[sectStyles.chevron, { color: c.subtext }]}>{open ? '▲' : '▼'}</Text>
      </TouchableOpacity>
      {open && <View>{children}</View>}
    </View>
  );
}

const sectStyles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    borderRadius: radius.md,
    padding: spacing.sm,
    paddingHorizontal: spacing.md,
    marginBottom: spacing.xs,
  },
  headerText: {
    fontSize: 13,
    fontWeight: '700',
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  },
  chevron: {
    fontSize: 11,
  },
});

function StrengthContent({
  session,
  zone,
  completedExercises,
  expandedCues,
  onToggleComplete,
  onToggleCue,
  c,
  isDark,
  day,
  workoutLogs,
  workoutHistory,
  onSetSaved,
  onAllSetsLogged,
}: {
  session: StrengthSession;
  zone: HRVZone;
  completedExercises: Set<string>;
  expandedCues: Set<string>;
  onToggleComplete: (name: string) => void;
  onToggleCue: (name: string) => void;
  c: ReturnType<typeof getColors>;
  isDark: boolean;
  day: string;
  workoutLogs: Record<string, Array<{set_number: number; reps: number | null; weight_lbs: number | null}>>;
  workoutHistory: Record<string, Array<{set_number: number; reps: number | null; weight_lbs: number | null}>>;
  onSetSaved: (exercise: string, setNum: number, reps: number | null, weight: number | null) => void;
  onAllSetsLogged: (exercise: string) => void;
}) {
  const isYellow = zone === 'yellow';

  return (
    <View>
      <CollapsibleSection title="Warm-up" c={c} isDark={isDark}>
        {session.warmup.map((ex) => (
          <ExerciseRow
            key={ex.name}
            exercise={ex}
            completed={completedExercises.has(ex.name)}
            cueOpen={expandedCues.has(ex.name)}
            onToggleComplete={() => onToggleComplete(ex.name)}
            onToggleCue={() => onToggleCue(ex.name)}
            isYellow={false}
            showSetsDimmed={false}
            c={c}
            isDark={isDark}
            day={day}
            loggedSets={workoutLogs[ex.name] ?? []}
            lastHistory={workoutHistory[ex.name] ?? []}
            onSetSaved={onSetSaved}
            onAllSetsLogged={onAllSetsLogged}
          />
        ))}
      </CollapsibleSection>

      <CollapsibleSection title="Working Sets" c={c} isDark={isDark}>
        {isYellow && (
          <View style={[strengthStyles.yellowBanner, { backgroundColor: isDark ? '#2A1A0A' : '#FFF4E5' }]}>
            <Text style={strengthStyles.yellowBannerText}>Yellow recovery — 2 sets per exercise, load –20%</Text>
          </View>
        )}
        {session.working.map((ex) => {
          const dimThirdSet = isYellow && ex.sets.startsWith('3');
          return (
            <ExerciseRow
              key={ex.name}
              exercise={ex}
              completed={completedExercises.has(ex.name)}
              cueOpen={expandedCues.has(ex.name)}
              onToggleComplete={() => onToggleComplete(ex.name)}
              onToggleCue={() => onToggleCue(ex.name)}
              isYellow={isYellow}
              showSetsDimmed={dimThirdSet}
              c={c}
              isDark={isDark}
              day={day}
              loggedSets={workoutLogs[ex.name] ?? []}
              lastHistory={workoutHistory[ex.name] ?? []}
            />
          );
        })}
      </CollapsibleSection>
    </View>
  );
}

const strengthStyles = StyleSheet.create({
  yellowBanner: {
    borderRadius: radius.sm,
    padding: spacing.sm,
    marginBottom: spacing.sm,
  },
  yellowBannerText: {
    color: '#BA7517',
    fontSize: 13,
    fontWeight: '600',
  },
});

function Zone2Content({
  session,
  c,
  isDark,
}: {
  session: Zone2Session;
  c: ReturnType<typeof getColors>;
  isDark: boolean;
}) {
  const bg = isDark ? '#0D1F15' : '#EBF7F2';

  return (
    <View style={[z2Styles.card, { backgroundColor: c.card }, shadow(isDark)]}>
      <View style={[z2Styles.hrBand, { backgroundColor: bg }]}>
        <Text style={z2Styles.hrLabel}>Target HR</Text>
        <Text style={z2Styles.hrRange}>135 – 145 BPM</Text>
      </View>
      {session.details.map((d, i) => (
        <View key={i} style={z2Styles.bulletRow}>
          <Text style={[z2Styles.bullet, { color: '#1D9E75' }]}>•</Text>
          <Text style={[z2Styles.bulletText, { color: c.subtext }]}>{d}</Text>
        </View>
      ))}
    </View>
  );
}

const z2Styles = StyleSheet.create({
  card: {
    borderRadius: radius.lg,
    padding: spacing.md,
    gap: spacing.sm,
    marginBottom: spacing.md,
  },
  hrBand: {
    borderRadius: radius.md,
    padding: spacing.md,
    alignItems: 'center',
    marginBottom: spacing.xs,
  },
  hrLabel: {
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 0.8,
    textTransform: 'uppercase',
    color: '#1D9E75',
    marginBottom: 2,
  },
  hrRange: {
    fontSize: 24,
    fontWeight: '700',
    color: '#1D9E75',
    letterSpacing: -0.5,
  },
  bulletRow: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  bullet: {
    fontSize: 16,
    lineHeight: 22,
  },
  bulletText: {
    flex: 1,
    fontSize: 14,
    lineHeight: 21,
  },
});

function IntervalsContent({
  session,
  zone,
  c,
  isDark,
}: {
  session: IntervalsSession;
  zone: HRVZone;
  c: ReturnType<typeof getColors>;
  isDark: boolean;
}) {
  const isYellow = zone === 'yellow';

  function phaseColor(phase: string): string {
    const p = phase.toLowerCase();
    if (p.startsWith('interval')) return '#993C1D';
    if (p.startsWith('recovery')) return '#1D9E75';
    return '#5A7A9A';
  }

  return (
    <View style={{ marginBottom: spacing.md }}>
      <View style={[intStyles.equipBox, { backgroundColor: isDark ? '#2A2A28' : '#F3F3F0', borderColor: c.border }]}>
        <Text style={[intStyles.equipText, { color: c.subtext }]}>Equipment: {session.equipment}</Text>
      </View>

      {isYellow && (
        <View style={[intStyles.yellowBanner, { backgroundColor: isDark ? '#2A1A0A' : '#FFF4E5' }]}>
          <Text style={intStyles.yellowText}>{session.note_yellow_hrv}</Text>
        </View>
      )}

      {session.phases.map((p, i) => {
        const color = phaseColor(p.phase);
        return (
          <View
            key={i}
            style={[intStyles.phaseCard, { backgroundColor: c.card, borderColor: c.border, borderLeftColor: color }]}
          >
            <View style={intStyles.phaseLeft}>
              <Text style={[intStyles.phaseName, { color: c.text }]}>{p.phase}</Text>
              <Text style={[intStyles.phaseDuration, { color: c.subtext }]}>{p.duration}</Text>
              <Text style={[intStyles.phaseNote, { color: c.subtext }]}>{p.note}</Text>
            </View>
            <View style={[intStyles.hrBox, { backgroundColor: color + '22' }]}>
              <Text style={[intStyles.hrText, { color }]}>{p.hr}</Text>
            </View>
          </View>
        );
      })}
    </View>
  );
}

const intStyles = StyleSheet.create({
  equipBox: {
    borderRadius: radius.md,
    borderWidth: 1,
    padding: spacing.sm,
    marginBottom: spacing.sm,
  },
  equipText: {
    fontSize: 13,
    lineHeight: 18,
  },
  yellowBanner: {
    borderRadius: radius.sm,
    padding: spacing.sm,
    marginBottom: spacing.sm,
  },
  yellowText: {
    color: '#BA7517',
    fontSize: 13,
    fontWeight: '600',
  },
  phaseCard: {
    borderRadius: radius.md,
    borderWidth: 1,
    borderLeftWidth: 4,
    padding: spacing.sm,
    marginBottom: spacing.sm,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  phaseLeft: {
    flex: 1,
    gap: 2,
  },
  phaseName: {
    fontSize: 14,
    fontWeight: '700',
  },
  phaseDuration: {
    fontSize: 12,
  },
  phaseNote: {
    fontSize: 12,
    lineHeight: 17,
  },
  hrBox: {
    borderRadius: radius.sm,
    paddingHorizontal: 10,
    paddingVertical: 6,
    alignItems: 'center',
    minWidth: 90,
  },
  hrText: {
    fontSize: 12,
    fontWeight: '700',
    textAlign: 'center',
  },
});

function MobilityContent({
  session,
  completedExercises,
  onToggleComplete,
  c,
  isDark,
}: {
  session: MobilitySession;
  completedExercises: Set<string>;
  onToggleComplete: (name: string) => void;
  c: ReturnType<typeof getColors>;
  isDark: boolean;
}) {
  return (
    <View style={{ marginBottom: spacing.md }}>
      <View style={[mobStyles.noteBox, { backgroundColor: isDark ? '#2A2A28' : '#F3F3F0' }]}>
        <Text style={[mobStyles.noteText, { color: c.subtext }]}>{session.note}</Text>
      </View>
      <View style={[mobStyles.list, { backgroundColor: c.card, borderColor: c.border }]}>
        {session.exercises.map((ex, i) => {
          const done = completedExercises.has(ex.name);
          return (
            <View
              key={ex.name}
              style={[
                mobStyles.exRow,
                { borderBottomWidth: i < session.exercises.length - 1 ? 1 : 0, borderColor: c.border },
              ]}
            >
              <View style={mobStyles.topLine}>
                <Checkbox checked={done} onPress={() => onToggleComplete(ex.name)} accentColor="#534AB7" />
                <View style={mobStyles.info}>
                  <Text style={[mobStyles.name, { color: c.text, opacity: done ? 0.5 : 1, textDecorationLine: done ? 'line-through' : 'none' }]}>
                    {ex.name}
                  </Text>
                  <Text style={[mobStyles.sets, { color: c.subtext }]}>{ex.sets}</Text>
                </View>
              </View>
              <Text style={[mobStyles.cue, { color: c.subtext }]}>{ex.cue}</Text>
            </View>
          );
        })}
      </View>
    </View>
  );
}

const mobStyles = StyleSheet.create({
  noteBox: {
    borderRadius: radius.md,
    padding: spacing.sm,
    marginBottom: spacing.sm,
  },
  noteText: {
    fontSize: 13,
    lineHeight: 19,
  },
  list: {
    borderRadius: radius.lg,
    borderWidth: 1,
    paddingHorizontal: spacing.md,
  },
  exRow: {
    paddingVertical: spacing.sm,
    gap: spacing.xs,
  },
  topLine: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  info: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  name: {
    fontSize: 14,
    fontWeight: '600',
    flex: 1,
  },
  sets: {
    fontSize: 12,
    fontWeight: '500',
  },
  cue: {
    fontSize: 12,
    lineHeight: 17,
    paddingLeft: 30,
  },
});

function RestContent({
  session,
  c,
  isDark,
}: {
  session: RestSession;
  c: ReturnType<typeof getColors>;
  isDark: boolean;
}) {
  return (
    <View style={[restStyles.card, { backgroundColor: c.card }, shadow(isDark)]}>
      <Text style={restStyles.icon}>🛌</Text>
      <Text style={[restStyles.note, { color: c.subtext }]}>{session.note}</Text>
    </View>
  );
}

const restStyles = StyleSheet.create({
  card: {
    borderRadius: radius.lg,
    padding: spacing.md,
    gap: spacing.sm,
    marginBottom: spacing.md,
    alignItems: 'center',
  },
  icon: {
    fontSize: 40,
  },
  note: {
    fontSize: 14,
    lineHeight: 21,
    textAlign: 'center',
  },
  reminder: {
    borderRadius: radius.sm,
    padding: spacing.sm,
    width: '100%',
  },
  reminderText: {
    fontSize: 13,
    textAlign: 'center',
  },
});

function NonNegotiablesStrip({
  c,
  isDark,
  values,
  onChange,
}: {
  c: ReturnType<typeof getColors>;
  isDark: boolean;
  values: { chinTucks: boolean; walk: boolean; noLateTraining: boolean };
  onChange: (key: keyof typeof values) => void;
}) {
  const items: { key: keyof typeof values; label: string; sub: string }[] = [
    { key: 'chinTucks', label: 'Chin tucks', sub: '2×10 at desk (2–3× today)' },
    { key: 'walk', label: 'Walk', sub: 'At least 10 min' },
    { key: 'noLateTraining', label: 'No training after 7pm', sub: '' },
  ];

  return (
    <View style={[nnStyles.card, { backgroundColor: c.card }, shadow(isDark)]}>
      <Text style={[nnStyles.title, { color: c.text }]}>Daily Non-Negotiables</Text>
      {items.map((item) => (
        <TouchableOpacity
          key={item.key}
          style={nnStyles.row}
          onPress={() => onChange(item.key)}
          activeOpacity={0.7}
        >
          <Checkbox
            checked={values[item.key]}
            onPress={() => onChange(item.key)}
            accentColor="#0C447C"
          />
          <View style={{ flex: 1 }}>
            <Text style={[nnStyles.label, { color: c.text }]}>{item.label}</Text>
            {item.sub ? (
              <Text style={[nnStyles.sub, { color: c.subtext }]}>{item.sub}</Text>
            ) : null}
          </View>
        </TouchableOpacity>
      ))}
    </View>
  );
}

const nnStyles = StyleSheet.create({
  card: {
    borderRadius: radius.lg,
    padding: spacing.md,
    marginBottom: spacing.md,
    gap: spacing.sm,
  },
  title: {
    fontSize: 14,
    fontWeight: '700',
    letterSpacing: -0.2,
    marginBottom: spacing.xs,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: 2,
  },
  label: {
    fontSize: 14,
    fontWeight: '500',
  },
  sub: {
    fontSize: 12,
    marginTop: 1,
  },
});

function renderWorkoutContent(
  workout: AnySession,
  zone: HRVZone,
  completedExercises: Set<string>,
  expandedCues: Set<string>,
  onToggleComplete: (name: string) => void,
  onToggleCue: (name: string) => void,
  c: ReturnType<typeof getColors>,
  isDark: boolean,
  day: string,
  workoutLogs: Record<string, Array<{set_number: number; reps: number | null; weight_lbs: number | null}>>,
  workoutHistory: Record<string, Array<{set_number: number; reps: number | null; weight_lbs: number | null}>>,
  onSetSaved: (exercise: string, setNum: number, reps: number | null, weight: number | null) => void,
  onAllSetsLogged: (exercise: string) => void,
) {
  if (workout.id === 'push' || workout.id === 'pull') {
    return (
      <StrengthContent
        session={workout as StrengthSession}
        zone={zone}
        completedExercises={completedExercises}
        expandedCues={expandedCues}
        onToggleComplete={onToggleComplete}
        onToggleCue={onToggleCue}
        c={c}
        isDark={isDark}
        day={day}
        workoutLogs={workoutLogs}
        workoutHistory={workoutHistory}
        onSetSaved={onSetSaved}
        onAllSetsLogged={onAllSetsLogged}
      />
    );
  }
  if (workout.id === 'zone2') {
    return <Zone2Content session={workout as Zone2Session} c={c} isDark={isDark} />;
  }
  if (workout.id === 'intervals') {
    return <IntervalsContent session={workout as IntervalsSession} zone={zone} c={c} isDark={isDark} />;
  }
  if (workout.id === 'mobility') {
    return (
      <MobilityContent
        session={workout as MobilitySession}
        completedExercises={completedExercises}
        onToggleComplete={onToggleComplete}
        c={c}
        isDark={isDark}
      />
    );
  }
  if (workout.id === 'rest') {
    return <RestContent session={workout as RestSession} c={c} isDark={isDark} />;
  }
  return null;
}

// --- Alternate activity logging ----------------------------------------------
// Log what you ACTUALLY did when it differs from the plan (e.g. scheduled Pull
// but you walked / did Zone 2 instead).

interface ActivityEstimate { steps: number; kcal: number; met?: number | null }
interface Activity {
  id: number;
  activity_type: string;
  label: string | null;
  duration_min: number | null;
  note: string | null;
  estimate?: ActivityEstimate;
}

const ACTIVITY_TYPES: { id: string; label: string; emoji: string }[] = [
  { id: 'walk', label: 'Walk', emoji: '🚶' },
  { id: 'zone2', label: 'Zone 2', emoji: '🟢' },
  { id: 'run', label: 'Run', emoji: '🏃' },
  { id: 'strength', label: 'Strength', emoji: '🏋️' },
  { id: 'intervals', label: 'Intervals', emoji: '⚡️' },
  { id: 'mobility', label: 'Mobility', emoji: '🧎' },
  { id: 'basketball', label: 'Basketball', emoji: '🏀' },
  { id: 'soccer', label: 'Soccer', emoji: '⚽️' },
  { id: 'tennis', label: 'Tennis', emoji: '🎾' },
  { id: 'pickleball', label: 'Pickleball', emoji: '🏓' },
  { id: 'dance', label: 'Dance', emoji: '💃' },
  { id: 'hike', label: 'Hike', emoji: '🥾' },
  { id: 'swim', label: 'Swim', emoji: '🏊' },
  { id: 'cycle', label: 'Cycle', emoji: '🚴' },
  { id: 'yoga', label: 'Yoga', emoji: '🧘' },
  { id: 'golf', label: 'Golf', emoji: '⛳️' },
  { id: 'ski', label: 'Ski', emoji: '⛷️' },
  { id: 'box', label: 'Boxing', emoji: '🥊' },
  { id: 'rest', label: 'Rest', emoji: '😴' },
  { id: 'other', label: 'Other', emoji: '➕' },
];

function activityEmoji(type: string): string {
  return ACTIVITY_TYPES.find((a) => a.id === type)?.emoji ?? '🏃';
}

function ActivityLogModal({
  visible,
  plannedType,
  c,
  isDark,
  onClose,
  onSave,
}: {
  visible: boolean;
  plannedType: string;
  c: ReturnType<typeof getColors>;
  isDark: boolean;
  onClose: () => void;
  onSave: (a: { activity_type: string; label: string; duration_min: number | null; note: string | null; no_watch: boolean }) => Promise<void>;
}) {
  const [type, setType] = useState('walk');
  const [duration, setDuration] = useState('');
  const [note, setNote] = useState('');
  const [noWatch, setNoWatch] = useState(false);
  const [saving, setSaving] = useState(false);

  React.useEffect(() => {
    if (visible) { setType('walk'); setDuration(''); setNote(''); setNoWatch(false); }
  }, [visible]);

  async function handleSave() {
    setSaving(true);
    try {
      const labelBase = ACTIVITY_TYPES.find((a) => a.id === type)?.label ?? type;
      await onSave({
        activity_type: type,
        label: labelBase,
        duration_min: duration ? parseInt(duration) : null,
        note: note.trim() || null,
        no_watch: noWatch,
      });
      onClose();
    } catch { /* surfaced by caller */ } finally {
      setSaving(false);
    }
  }

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={{ flex: 1 }}>
        <View style={{ flex: 1, justifyContent: 'flex-end' }}>
          <View style={[logStyles.sheet, { backgroundColor: c.card, borderColor: c.border }]}>
            <Text style={[logStyles.title, { color: c.text }]}>Log a different activity</Text>
            <Text style={[logStyles.hint, { color: c.subtext }]}>
              Scheduled: {plannedType}. Record what you actually did instead. If you didn't wear your watch,
              NormOS estimates the steps & energy from the type and duration.
            </Text>

            <View style={actStyles.typeGrid}>
              {ACTIVITY_TYPES.map((a) => {
                const sel = a.id === type;
                return (
                  <TouchableOpacity
                    key={a.id}
                    onPress={() => setType(a.id)}
                    style={[
                      actStyles.typeChip,
                      { borderColor: sel ? c.accent : c.border, backgroundColor: sel ? c.accent + '15' : 'transparent' },
                    ]}
                    activeOpacity={0.7}
                  >
                    <Text style={actStyles.typeChipEmoji}>{a.emoji}</Text>
                    <Text style={[actStyles.typeChipLabel, { color: sel ? c.accent : c.subtext }]}>{a.label}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            <View style={logStyles.row}>
              <View style={logStyles.inputWrap}>
                <Text style={[logStyles.inputLabel, { color: c.subtext }]}>Duration (min)</Text>
                <TextInput
                  style={[logStyles.input, { color: c.text, borderColor: c.border, backgroundColor: isDark ? '#1C1C1A' : '#F9F8F6' }]}
                  value={duration}
                  onChangeText={setDuration}
                  keyboardType="number-pad"
                  placeholder="—"
                  placeholderTextColor={c.subtext}
                />
              </View>
              <View style={[logStyles.inputWrap, { flex: 2 }]}>
                <Text style={[logStyles.inputLabel, { color: c.subtext }]}>Note (optional)</Text>
                <TextInput
                  style={[logStyles.input, { color: c.text, borderColor: c.border, backgroundColor: isDark ? '#1C1C1A' : '#F9F8F6', textAlign: 'left' }]}
                  value={note}
                  onChangeText={setNote}
                  placeholder="e.g. incline walk"
                  placeholderTextColor={c.subtext}
                />
              </View>
            </View>

            <TouchableOpacity
              onPress={() => setNoWatch((v) => !v)}
              activeOpacity={0.7}
              style={[actStyles.watchToggle, { borderColor: noWatch ? c.accent : c.border, backgroundColor: noWatch ? c.accent + '15' : 'transparent' }]}
            >
              <View style={[actStyles.checkbox, { borderColor: noWatch ? c.accent : c.border, backgroundColor: noWatch ? c.accent : 'transparent' }]}>
                {noWatch ? <Text style={actStyles.checkboxTick}>✓</Text> : null}
              </View>
              <Text style={[actStyles.watchToggleTxt, { color: noWatch ? c.accent : c.text }]}>
                I didn't wear my watch — estimate steps & energy
              </Text>
            </TouchableOpacity>

            <View style={logStyles.buttons}>
              <TouchableOpacity onPress={onClose} style={[logStyles.btn, { borderColor: c.border }]}>
                <Text style={[logStyles.btnTxt, { color: c.subtext }]}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={handleSave} disabled={saving} style={[logStyles.btn, logStyles.btnPrimary, { backgroundColor: c.accent }]}>
                <Text style={[logStyles.btnTxt, { color: '#FFF' }]}>{saving ? 'Saving…' : 'Log activity'}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function ActivityLogSection({
  activities,
  c,
  isDark,
  onAdd,
  onDelete,
}: {
  activities: Activity[];
  c: ReturnType<typeof getColors>;
  isDark: boolean;
  onAdd: () => void;
  onDelete: (id: number) => void;
}) {
  return (
    <View style={[actStyles.card, { backgroundColor: c.card }, shadow(isDark)]}>
      <Text style={[actStyles.cardTitle, { color: c.text }]}>What I actually did</Text>
      {activities.length === 0 ? (
        <Text style={[actStyles.empty, { color: c.subtext }]}>
          Did something other than the plan? Log it so your training history stays accurate.
        </Text>
      ) : (
        activities.map((a) => (
          <View key={a.id} style={[actStyles.row, { borderColor: c.border }]}>
            <Text style={actStyles.rowEmoji}>{activityEmoji(a.activity_type)}</Text>
            <View style={{ flex: 1 }}>
              <Text style={[actStyles.rowLabel, { color: c.text }]}>
                {a.label ?? a.activity_type}
                {a.duration_min ? ` · ${a.duration_min} min` : ''}
              </Text>
              {a.estimate && (a.estimate.steps > 0 || a.estimate.kcal > 0) ? (
                <Text style={[actStyles.rowNote, { color: c.accent }]}>
                  ≈{a.estimate.steps > 0 ? ` ${a.estimate.steps.toLocaleString()} steps ·` : ''} {a.estimate.kcal.toLocaleString()} kcal
                </Text>
              ) : null}
              {a.note ? <Text style={[actStyles.rowNote, { color: c.subtext }]}>{a.note}</Text> : null}
            </View>
            <TouchableOpacity onPress={() => onDelete(a.id)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <Text style={[actStyles.rowDelete, { color: c.subtext }]}>✕</Text>
            </TouchableOpacity>
          </View>
        ))
      )}
      <TouchableOpacity onPress={onAdd} style={[actStyles.addBtn, { borderColor: c.accent }]} activeOpacity={0.7}>
        <Text style={[actStyles.addBtnTxt, { color: c.accent }]}>+ Log a different activity</Text>
      </TouchableOpacity>
    </View>
  );
}

const actStyles = StyleSheet.create({
  card: { borderRadius: radius.lg, padding: spacing.md, marginBottom: spacing.md, gap: spacing.sm },
  cardTitle: { fontSize: 14, fontWeight: '700', letterSpacing: -0.2 },
  empty: { fontSize: 13, lineHeight: 19 },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, borderBottomWidth: 1, paddingVertical: spacing.sm },
  rowEmoji: { fontSize: 20 },
  rowLabel: { fontSize: 14, fontWeight: '600' },
  rowNote: { fontSize: 12, marginTop: 1 },
  rowDelete: { fontSize: 14, fontWeight: '600' },
  addBtn: { borderWidth: 1, borderRadius: radius.md, paddingVertical: spacing.sm, alignItems: 'center', marginTop: spacing.xs },
  addBtnTxt: { fontSize: 13, fontWeight: '600' },
  typeGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginBottom: spacing.md },
  typeChip: { flexDirection: 'row', alignItems: 'center', gap: 5, borderWidth: 1, borderRadius: 20, paddingHorizontal: 12, paddingVertical: 7 },
  typeChipEmoji: { fontSize: 15 },
  typeChipLabel: { fontSize: 13, fontWeight: '600' },
  watchToggle: { flexDirection: 'row', alignItems: 'center', gap: 8, borderWidth: 1, borderRadius: radius.md, paddingVertical: 10, paddingHorizontal: 12, marginBottom: spacing.md },
  checkbox: { width: 18, height: 18, borderRadius: 5, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center' },
  checkboxTick: { color: '#FFF', fontSize: 12, fontWeight: '800' },
  watchToggleTxt: { fontSize: 13, fontWeight: '600', flex: 1 },
});

// Full day-by-day workout view (HRV-aware) — embedded in the Health tab.
export function WorkoutsPanel({ hrv, isDark, recoveryBand, recoveryScore }: Props) {
  const c = getColors(isDark);
  const todayDayIndex = getTodayDayIndex();

  const [selectedDayIndex, setSelectedDayIndex] = useState(todayDayIndex);
  const [completedExercises, setCompletedExercises] = useState<Set<string>>(new Set());
  const [expandedCues, setExpandedCues] = useState<Set<string>>(new Set());
  const [nonNegotiables, setNonNegotiables] = useState({
    chinTucks: false,
    walk: false,
    noLateTraining: false,
  });
  const [weeklyCompleted, setWeeklyCompleted] = useState<Record<string, boolean>>({});
  const [saveFailed, setSaveFailed] = useState(false);
  const [workoutLogs, setWorkoutLogs] = useState<Record<string, Array<{set_number: number; reps: number | null; weight_lbs: number | null}>>>({});
  const [workoutHistory, setWorkoutHistory] = useState<Record<string, Array<{set_number: number; reps: number | null; weight_lbs: number | null}>>>({});
  const [activities, setActivities] = useState<Activity[]>([]);
  const [showActivityModal, setShowActivityModal] = useState(false);
  const [useScheduledWorkout, setUseScheduledWorkout] = useState(false);
  // Manual per-day workout swaps (dateKey → workoutId), loaded for the visible week.
  const [swapByDay, setSwapByDay] = useState<Record<string, string>>({});
  const [showSwap, setShowSwap] = useState(false);

  const todayKey = getDateKey(todayDayIndex);
  const selectedKey = getDateKey(selectedDayIndex);

  // Rehydrate today's completion from the exercise habit so the workout shows as
  // done if it was already logged today (and resets at midnight, backend-side).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetchWithTimeout(`${API_BASE}/api/habits/today`, { headers: authHeaders() });
        if (!res.ok) return;
        const t = await res.json();
        if (cancelled || !t?.logged) return;
        if (t.exercise) setWeeklyCompleted((prev) => ({ ...prev, [todayKey]: true }));
      } catch {
        /* offline — leave blank */
      }
    })();
    return () => { cancelled = true; };
  }, [todayKey]);

  // Rehydrate the per-exercise + non-negotiable checks for the selected day, so
  // ticking off exercises survives tab switches / reopens (resets at midnight).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetchWithTimeout(`${API_BASE}/api/workout/checks?date=${selectedKey}`, { headers: authHeaders() });
        if (cancelled || !res.ok) return;
        const { checks } = await res.json();
        if (cancelled || !checks) return;
        const ex = new Set<string>();
        const nn = { chinTucks: false, walk: false, noLateTraining: false };
        for (const key of Object.keys(checks)) {
          if (key in nn) (nn as Record<string, boolean>)[key] = true;
          else ex.add(key);
        }
        setCompletedExercises(ex);
        setNonNegotiables(nn);
      } catch {
        /* offline — keep whatever's shown */
      }
    })();
    return () => { cancelled = true; };
  }, [selectedKey]);

  // Load manual workout swaps for the visible week (Mon..Sun around today).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const from = getDateKey(0), to = getDateKey(6);
        const res = await fetchWithTimeout(`${WORKOUT_OVERRIDES_URL}?from=${from}&to=${to}`, { headers: authHeaders() });
        if (cancelled || !res.ok) return;
        const { overrides } = await res.json();
        if (!cancelled) setSwapByDay(overrides ?? {});
      } catch { /* offline — no swaps */ }
    })();
    return () => { cancelled = true; };
  }, []);

  // Swap (or revert) the selected day's workout. Empty id reverts to scheduled.
  async function swapWorkout(workoutId: string | null) {
    const next = { ...swapByDay };
    if (workoutId) next[selectedKey] = workoutId; else delete next[selectedKey];
    setSwapByDay(next);
    setShowSwap(false);
    try {
      await fetchWithTimeout(WORKOUT_OVERRIDE_URL, {
        method: 'POST', headers: authHeaders(),
        body: JSON.stringify({ date: selectedKey, workoutId }),
      });
    } catch { setSaveFailed(true); }
  }

  // Load logged alternate activities for the selected day.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetchWithTimeout(`${ACTIVITY_URL}?date=${selectedKey}`, { headers: authHeaders() });
        if (cancelled || !res.ok) return;
        const { activities: rows } = await res.json();
        if (!cancelled) setActivities(rows ?? []);
      } catch {
        if (!cancelled) setActivities([]);
      }
    })();
    return () => { cancelled = true; };
  }, [selectedKey]);

  async function fetchLogsForDay(day: string, exercises: string[]) {
    try {
      const res = await fetchWithTimeout(`${WORKOUT_LOG_URL}?day=${day}`, { headers: authHeaders() });
      if (!res.ok) return;
      const data = await res.json();
      const grouped: Record<string, Array<{set_number: number; reps: number | null; weight_lbs: number | null}>> = {};
      for (const row of data.logs ?? []) {
        if (!grouped[row.exercise]) grouped[row.exercise] = [];
        grouped[row.exercise].push(row);
      }
      setWorkoutLogs(grouped);
    } catch {}
    for (const ex of exercises) {
      try {
        const res = await fetchWithTimeout(`${WORKOUT_LOG_URL}/history?exercise=${encodeURIComponent(ex)}&limit=1`, { headers: authHeaders() });
        if (!res.ok) continue;
        const data = await res.json();
        if (data.history?.[0]?.sets) {
          setWorkoutHistory(prev => ({ ...prev, [ex]: data.history[0].sets }));
        }
      } catch {}
    }
  }

  useEffect(() => {
    const day = getDateKey(selectedDayIndex);
    // Use the swapped id if the day was manually swapped, else the scheduled one,
    // so set-logging loads for a swapped-in Push/Pull session too.
    const effId = swapByDay[day] ?? getWeekDayWorkoutId(selectedDayIndex);
    setWorkoutLogs({});
    if (effId === 'push' || effId === 'pull') {
      fetchLogsForDay(day, []);
    }
  }, [selectedDayIndex, swapByDay]);

  // Persist a single check for the selected day. On failure we surface it and
  // roll the checkbox back, so the UI never claims something was saved when it
  // wasn't (which would then "vanish" on the next rehydrate).
  async function saveCheck(itemKey: string, itemType: 'exercise' | 'non_negotiable', done: boolean, rollback: () => void) {
    setSaveFailed(false);
    try {
      const res = await fetchWithTimeout(`${API_BASE}/api/workout/checks`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ date: selectedKey, itemKey, itemType, done }),
      });
      if (!res.ok) throw new Error(`Server ${res.status}`);
    } catch {
      rollback();
      setSaveFailed(true);
    }
  }

  const isViewingToday = selectedDayIndex === todayDayIndex;
  // Convert strip day index (Mon=0) to JS day-of-week (Sun=0) for the selected day
  const selectedJsDay = (selectedDayIndex + 1) % 7;
  // Only apply recovery logic for today — other days show the scheduled workout.
  // Prefer the baseline-relative recovery band; fall back to raw HRV if no band.
  const { workout: _autoWorkout, zone, override } = getTodaysWorkout(
    selectedJsDay,
    isViewingToday ? hrv : null,
    isViewingToday ? recoveryBand ?? null : null,
  );

  // Reset the scheduled-workout override whenever the user navigates to a different day.
  useEffect(() => { setUseScheduledWorkout(false); }, [selectedDayIndex]);

  // When recovery has auto-downgraded today's session, the user can tap a button to
  // restore the scheduled workout. We look up the original session directly so we
  // don't have to re-invoke getTodaysWorkout with artificial inputs.
  const SESSION_MAP: Record<string, AnySession> = {
    zone2: ZONE2, mobility: MOBILITY, push: SESSION_A, pull: SESSION_B, rest: REST, intervals: INTERVALS,
  };
  const scheduledId = WEEKLY_SCHEDULE[selectedJsDay] ?? 'rest';
  // A manual swap wins over everything (the scheduled split AND any recovery
  // auto-downgrade) — the user deliberately chose this day's session.
  const swappedId = swapByDay[selectedKey];
  const workout = swappedId
    ? SESSION_MAP[swappedId] ?? REST
    : useScheduledWorkout && !!override && isViewingToday
      ? SESSION_MAP[scheduledId] ?? REST
      : _autoWorkout;
  // Hide the recovery-downgrade note when a manual swap is in effect.
  const displayOverride = swappedId || (useScheduledWorkout && !!override && isViewingToday) ? undefined : override;

  function handleDayPress(dayIndex: number) {
    setSelectedDayIndex(dayIndex);
    setCompletedExercises(new Set());
    setExpandedCues(new Set());
  }

  function toggleExercise(name: string) {
    setCompletedExercises((prev) => {
      const next = new Set(prev);
      const done = !next.has(name);
      if (done) next.add(name);
      else next.delete(name);
      // On save failure, revert ONLY this item against the latest state (a stale
      // snapshot would clobber an unrelated exercise ticked off in the meantime).
      const rollback = () => setCompletedExercises((cur) => {
        const s = new Set(cur);
        if (done) s.delete(name); else s.add(name);
        return s;
      });
      saveCheck(name, 'exercise', done, rollback);
      return next;
    });
  }

  // Optimistically reflect a saved set in the chips (previously they only updated
  // on refetch). The child decides when it's the *last* set and calls the auto-check.
  function handleSetSaved(exercise: string, setNum: number, reps: number | null, weight: number | null) {
    setWorkoutLogs((prev) => {
      const cur = prev[exercise] ?? [];
      const next = cur.filter((s) => s.set_number !== setNum).concat([{ set_number: setNum, reps, weight_lbs: weight }]);
      return { ...prev, [exercise]: next };
    });
  }

  // Tick an exercise's circle when its final set is logged. Idempotent (only adds),
  // so it never un-checks something already done.
  function markExerciseComplete(name: string) {
    if (completedExercises.has(name)) return;
    setCompletedExercises((prev) => {
      if (prev.has(name)) return prev;
      const next = new Set(prev); next.add(name); return next;
    });
    const rollback = () => setCompletedExercises((cur) => { const s = new Set(cur); s.delete(name); return s; });
    saveCheck(name, 'exercise', true, rollback);
  }

  function toggleCue(name: string) {
    setExpandedCues((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  function toggleNonNeg(key: keyof typeof nonNegotiables) {
    setNonNegotiables((prev) => {
      const done = !prev[key];
      // Revert only this key against the latest state on failure.
      const rollback = () => setNonNegotiables((cur) => ({ ...cur, [key]: !done }));
      saveCheck(key, 'non_negotiable', done, rollback);
      return { ...prev, [key]: done };
    });
  }

  // All checkable exercise names for a workout (warmup + working for strength;
  // exercises for mobility). Used so "Mark complete" ticks the whole list.
  function exerciseNames(w: AnySession): string[] {
    if (w.id === 'push' || w.id === 'pull') {
      const s = w as StrengthSession;
      return [...s.warmup.map((e) => e.name), ...s.working.map((e) => e.name)];
    }
    if (w.id === 'mobility') {
      return (w as MobilitySession).exercises.map((e) => e.name);
    }
    return [];
  }

  async function handleMarkDone(dateKey: string) {
    const nextDone = !weeklyCompleted[dateKey];
    setWeeklyCompleted((prev) => ({ ...prev, [dateKey]: nextDone }));

    // Marking complete also checks (or unchecks) every exercise in the workout,
    // and persists each so it survives a reopen / matches the per-exercise state.
    const names = exerciseNames(workout);
    setCompletedExercises((prev) => {
      const next = new Set(prev);
      for (const n of names) { if (nextDone) next.add(n); else next.delete(n); }
      return next;
    });
    for (const n of names) {
      // Fire-and-forget per-exercise persistence; a failure just flags the banner.
      saveCheck(n, 'exercise', nextDone, () => setSaveFailed(true));
    }

    // Marking *today's* workout complete also logs the Exercise habit (and
    // unchecking clears it), so the Today tab and Insights stay in sync. Other
    // days are local-only — we can't backfill a habit for a past/future date here.
    if (dateKey === todayKey) {
      setSaveFailed(false);
      try {
        const res = await fetchWithTimeout(`${API_BASE}/api/habits`, {
          method: 'POST',
          headers: authHeaders(),
          body: JSON.stringify({ exercise: nextDone }),
        });
        if (!res.ok) throw new Error(`Server ${res.status}`);
      } catch {
        // Roll back so the button doesn't claim a completion that wasn't saved.
        setWeeklyCompleted((prev) => ({ ...prev, [dateKey]: !nextDone }));
        setSaveFailed(true);
      }
    }
  }

  // Log an alternate activity for the selected day. Optimistic insert with a
  // temp id; on success we swap in the server row. Logging a non-rest activity
  // for TODAY also marks the Exercise habit so streaks/insights stay in sync.
  async function addActivity(a: { activity_type: string; label: string; duration_min: number | null; note: string | null; no_watch: boolean }) {
    try {
      const res = await fetchWithTimeout(ACTIVITY_URL, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ date: selectedKey, planned_type: workout.label, ...a }),
      });
      if (!res.ok) throw new Error(`Server ${res.status}`);
      const { activity, estimate } = await res.json();
      setActivities((prev) => [...prev, { ...activity, estimate }]);

      if (selectedKey === todayKey && a.activity_type !== 'rest') {
        setWeeklyCompleted((prev) => ({ ...prev, [todayKey]: true }));
        fetchWithTimeout(`${API_BASE}/api/habits`, {
          method: 'POST',
          headers: authHeaders(),
          body: JSON.stringify({ exercise: true }),
        }).catch(() => {});
      }
    } catch {
      setSaveFailed(true);
    }
  }

  async function deleteActivity(id: number) {
    const prev = activities;
    setActivities((cur) => cur.filter((x) => x.id !== id));
    try {
      const res = await fetchWithTimeout(`${ACTIVITY_URL}/${id}`, { method: 'DELETE', headers: authHeaders() });
      if (!res.ok) throw new Error(`Server ${res.status}`);
    } catch {
      setActivities(prev); // restore on failure
      setSaveFailed(true);
    }
  }

  const duration = 'duration' in workout ? (workout as any).duration : undefined;
  const dateKey = getDateKey(selectedDayIndex);
  const done = !!weeklyCompleted[dateKey];

  return (
    <View>
      <WeeklyStrip
        c={c}
        isDark={isDark}
        weeklyCompleted={weeklyCompleted}
        selectedDayIndex={selectedDayIndex}
        onDayPress={handleDayPress}
        swapByDay={swapByDay}
      />

      <HRVHeaderCard
        c={c}
        isDark={isDark}
        hrv={hrv}
        zone={zone}
        workoutLabel={workout.label}
        workoutDuration={duration}
        override={displayOverride}
        recoveryScore={isViewingToday ? (recoveryScore ?? null) : null}
      />

      {/* Manual workout swap — choose a different session for this day and log it fully. */}
      <View style={swapStyles.wrap}>
        <TouchableOpacity
          onPress={() => setShowSwap((v) => !v)}
          style={[swapStyles.btn, { borderColor: swappedId ? '#0C447C' : c.border, backgroundColor: swappedId ? '#0C447C15' : 'transparent' }]}
          activeOpacity={0.7}
        >
          <Text style={[swapStyles.btnTxt, { color: swappedId ? '#0C447C' : c.subtext }]}>
            {swappedId ? `🔄 Swapped to ${getWorkoutShortLabel(swappedId)} · change` : '🔄 Swap this day’s workout'}
          </Text>
        </TouchableOpacity>

        {showSwap && (
          <View style={swapStyles.options}>
            {SWAP_CHOICES.map((id) => {
              const sel = swappedId === id;
              return (
                <TouchableOpacity
                  key={id}
                  onPress={() => swapWorkout(id)}
                  style={[swapStyles.chip, { borderColor: sel ? '#0C447C' : c.border, backgroundColor: sel ? '#0C447C15' : 'transparent' }]}
                  activeOpacity={0.7}
                >
                  <Text style={[swapStyles.chipTxt, { color: sel ? '#0C447C' : c.text }]}>{getWorkoutShortLabel(id)}</Text>
                </TouchableOpacity>
              );
            })}
            {swappedId && (
              <TouchableOpacity
                onPress={() => swapWorkout(null)}
                style={[swapStyles.chip, { borderColor: c.border }]}
                activeOpacity={0.7}
              >
                <Text style={[swapStyles.chipTxt, { color: c.subtext }]}>↺ Scheduled ({getWorkoutShortLabel(scheduledId)})</Text>
              </TouchableOpacity>
            )}
          </View>
        )}
      </View>

      {isViewingToday && !!override && !swappedId && (
        <TouchableOpacity
          onPress={() => setUseScheduledWorkout((v) => !v)}
          style={[
            schedOverrideStyles.btn,
            {
              borderColor: useScheduledWorkout ? '#1D9E75' : '#BA7517',
              backgroundColor: useScheduledWorkout ? '#1D9E7515' : 'transparent',
            },
          ]}
          activeOpacity={0.7}
        >
          <Text style={[schedOverrideStyles.txt, { color: useScheduledWorkout ? '#1D9E75' : '#BA7517' }]}>
            {useScheduledWorkout ? '✓ Showing scheduled workout' : 'Use scheduled workout anyway'}
          </Text>
        </TouchableOpacity>
      )}

      <TouchableOpacity
        onPress={() => handleMarkDone(dateKey)}
        style={[markDoneStyles.btn, { borderColor: done ? '#1D9E75' : c.border, backgroundColor: done ? '#1D9E7515' : 'transparent' }]}
        activeOpacity={0.7}
      >
        <Text style={[markDoneStyles.label, { color: done ? '#1D9E75' : c.subtext }]}>
          {done ? '✓ Marked complete' : 'Mark as complete'}
        </Text>
      </TouchableOpacity>

      {saveFailed && (
        <Text style={markDoneStyles.failed}>Couldn’t save — check your connection and try again.</Text>
      )}

      <ActivityLogSection
        activities={activities}
        c={c}
        isDark={isDark}
        onAdd={() => setShowActivityModal(true)}
        onDelete={deleteActivity}
      />

      <ActivityLogModal
        visible={showActivityModal}
        plannedType={workout.label}
        c={c}
        isDark={isDark}
        onClose={() => setShowActivityModal(false)}
        onSave={addActivity}
      />

      {renderWorkoutContent(
        workout,
        zone,
        completedExercises,
        expandedCues,
        toggleExercise,
        toggleCue,
        c,
        isDark,
        getDateKey(selectedDayIndex),
        workoutLogs,
        workoutHistory,
        handleSetSaved,
        markExerciseComplete,
      )}

    </View>
  );
}

const markDoneStyles = StyleSheet.create({
  btn: {
    alignSelf: 'center',
    borderWidth: 1,
    borderRadius: radius.lg,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    marginBottom: spacing.md,
  },
  label: {
    fontSize: 14,
    fontWeight: '500',
  },
  failed: {
    fontSize: 12,
    color: '#C0392B',
    textAlign: 'center',
    marginBottom: spacing.md,
  },
});

const schedOverrideStyles = StyleSheet.create({
  btn: {
    alignSelf: 'center',
    borderWidth: 1,
    borderRadius: radius.lg,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    marginBottom: spacing.md,
  },
  txt: {
    fontSize: 13,
    fontWeight: '600',
  },
});

const swapStyles = StyleSheet.create({
  wrap: { marginBottom: spacing.md },
  btn: {
    alignSelf: 'center',
    borderWidth: 1,
    borderRadius: radius.lg,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  btnTxt: { fontSize: 13, fontWeight: '600' },
  options: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    gap: spacing.sm,
    marginTop: spacing.sm,
  },
  chip: {
    borderWidth: 1,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs + 2,
  },
  chipTxt: { fontSize: 13, fontWeight: '600' },
});
