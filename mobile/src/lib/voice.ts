// Voice layer — guarded access to expo-av/expo-file-system so the SAME JS
// bundle runs on binaries with and without the native audio modules. The
// currently-installed 1.1.0 binary predates them: a top-level import would
// crash the whole app on OTA update, so everything loads via try/catch and
// callers hide voice UI when `voiceAvailable` is false. The next native build
// includes the modules and the UI lights up with no further JS change.
let AV: any = null;
let FS: any = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  AV = require('expo-av');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  FS = require('expo-file-system');
} catch {
  AV = null;
  FS = null;
}

export const voiceAvailable: boolean = !!(AV?.Audio && FS?.cacheDirectory);

let sound: any = null;

/** Stop + unload whatever is currently playing. Safe to call anytime. */
export async function stopPlayback(): Promise<void> {
  try {
    if (sound) {
      await sound.unloadAsync();
      sound = null;
    }
  } catch { sound = null; }
}

/**
 * Play a remote audio URL (with auth headers). onDone fires when playback
 * finishes or fails. Returns false if voice isn't available.
 */
export async function playRemote(uri: string, headers: Record<string, string>, onDone?: () => void): Promise<boolean> {
  if (!voiceAvailable) return false;
  await stopPlayback();
  await AV.Audio.setAudioModeAsync({ playsInSilentModeIOS: true, staysActiveInBackground: true, allowsRecordingIOS: false });
  const created = await AV.Audio.Sound.createAsync({ uri, headers }, { shouldPlay: true });
  sound = created.sound;
  sound.setOnPlaybackStatusUpdate((st: any) => {
    if (st?.didJustFinish || st?.error) {
      stopPlayback();
      onDone?.();
    }
  });
  return true;
}

/** Play base64 audio (the voice-ask reply) by writing it to a cache file. */
export async function playBase64(base64: string, mime = 'audio/wav', onDone?: () => void): Promise<boolean> {
  if (!voiceAvailable) return false;
  const ext = mime.includes('wav') ? 'wav' : 'm4a';
  const path = `${FS.cacheDirectory}voice-answer.${ext}`;
  await FS.writeAsStringAsync(path, base64, { encoding: FS.EncodingType.Base64 });
  return playRemote(path, {}, onDone);
}

let recording: any = null;

// 16kHz mono 16-bit WAV: small enough to upload fast (~32KB/s), directly
// supported by the transcription API, no transcoding anywhere.
const WAV_OPTIONS = {
  isMeteringEnabled: false,
  android: {
    extension: '.wav',
    sampleRate: 16000,
    numberOfChannels: 1,
    bitRate: 256000,
    outputFormat: 0, // DEFAULT container; Android fallback (app is iOS-first)
    audioEncoder: 0,
  },
  ios: {
    extension: '.wav',
    outputFormat: 'lpcm' as const,
    audioQuality: 96, // HIGH
    sampleRate: 16000,
    numberOfChannels: 1,
    bitDepth: 16,
    linearPCMBitDepth: 16,
    linearPCMIsBigEndian: false,
    linearPCMIsFloat: false,
  },
  web: {},
};

/** Ask for mic permission; true when granted. */
export async function ensureMicPermission(): Promise<boolean> {
  if (!voiceAvailable) return false;
  const res = await AV.Audio.requestPermissionsAsync();
  return !!res?.granted;
}

export async function startRecording(): Promise<boolean> {
  if (!voiceAvailable) return false;
  await stopPlayback();
  await AV.Audio.setAudioModeAsync({ allowsRecordingIOS: true, playsInSilentModeIOS: true });
  recording = new AV.Audio.Recording();
  await recording.prepareToRecordAsync(WAV_OPTIONS);
  await recording.startAsync();
  return true;
}

/** Stop and return the recording as base64 WAV (null if nothing captured). */
export async function stopRecording(): Promise<{ base64: string; mime: string } | null> {
  if (!recording) return null;
  const rec = recording;
  recording = null;
  try {
    await rec.stopAndUnloadAsync();
  } catch { /* stopped too fast — fall through to read whatever exists */ }
  await AV.Audio.setAudioModeAsync({ allowsRecordingIOS: false, playsInSilentModeIOS: true });
  const uri = rec.getURI();
  if (!uri) return null;
  const base64 = await FS.readAsStringAsync(uri, { encoding: FS.EncodingType.Base64 });
  FS.deleteAsync(uri, { idempotent: true }).catch(() => {});
  if (!base64 || base64.length < 4000) return null; // sub-⅛-second tap — ignore
  return { base64, mime: 'audio/wav' };
}

export function isRecording(): boolean {
  return recording != null;
}
