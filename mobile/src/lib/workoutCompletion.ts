// Pure decision logic for explicit workout-level completion — the mobile
// counterpart to backend's services/workout.js's resolveTrainingOutcome.
// Extracted out of WorkoutsPanel.tsx so the core "is THIS workout marked
// complete" and "should unmarking clear the Exercise habit" decisions are
// directly unit-testable under plain Node (see workoutCompletion.test.ts) —
// the production bug this file exists to prevent regressing: logging an
// unrelated activity (a walk) on a scheduled Intervals day must never read
// as completing Intervals, and unmarking one scheduled workout must never
// wipe out Exercise-habit credit a separate, still-logged activity earned.

export interface WorkoutCompletionEntry {
  workoutId: string;
  source: string;
}

export interface LoggedActivity {
  activity_type: string;
}

/** Is the workout with id `workoutId` explicitly marked complete for this
 *  day? Only true when the completion record's OWN workoutId matches — a
 *  completion recorded for a DIFFERENT workout (before a swap, or a
 *  recovery downgrade that changed the effective session since) never
 *  counts as completing the one currently displayed. */
export function isWorkoutMarkedComplete(entry: WorkoutCompletionEntry | undefined, workoutId: string): boolean {
  return entry?.workoutId === workoutId;
}

/** After toggling a workout's completion to `nextDone`, should the generic
 *  Exercise habit be written this call? Marking complete always writes it
 *  (true — a completed workout is unambiguous exercise evidence). Unmarking
 *  only clears it when NO OTHER non-rest activity remains logged for the
 *  day — otherwise unmarking one scheduled workout would wrongly erase
 *  habit credit a separate, still-logged activity already earned. */
export function shouldWriteExerciseHabit(nextDone: boolean, otherActivitiesToday: LoggedActivity[]): boolean {
  if (nextDone) return true;
  return !otherActivitiesToday.some((a) => a.activity_type !== 'rest');
}
