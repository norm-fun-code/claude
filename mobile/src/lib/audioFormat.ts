// Pure, dependency-free mime -> file-extension mapping for locally-cached
// narration audio (mobile/src/lib/voice.ts's playBase64). Extracted so it's
// unit-testable under this project's plain-Node test runner, which cannot
// import voice.ts itself (it pulls in expo-av/expo-file-system).
//
// Why this exists: the backend's TTS provider is now configurable
// (NORMOS_TTS_PROVIDER=auto|openai|gemini — see backend/src/services/
// ttsProvider.js) and providers don't all default to the same audio
// container. Gemini's synthesize() always returns WAV; OpenAI's
// /v1/audio/speech supports wav/mp3/aac/flac/opus via OPENAI_TTS_FORMAT.
// Writing the wrong extension for the actual bytes (e.g. mp3 data saved as
// ".m4a") can fail to play on-device even though the mime the server sent
// was correct — this must recognize every format either provider can
// return, not just "wav vs. everything else".
export function extensionForMime(mime: string | undefined | null): string {
  const m = String(mime || '').toLowerCase();
  if (m.includes('wav')) return 'wav';
  if (m.includes('mpeg') || m.includes('mp3')) return 'mp3';
  if (m.includes('aac')) return 'aac';
  if (m.includes('flac')) return 'flac';
  if (m.includes('opus') || m.includes('ogg')) return 'opus';
  if (m.includes('mp4') || m.includes('m4a')) return 'm4a';
  // Unrecognized/absent mime: m4a matches this function's prior fallback
  // behavior (voice.ts used to treat "anything not wav" as m4a).
  return 'm4a';
}
