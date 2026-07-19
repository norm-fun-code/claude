// Unit coverage for extensionForMime — must correctly route every audio
// format either TTS provider (Gemini or OpenAI, see backend's
// services/ttsProvider.js) can return to a file extension expo-av can
// actually play, not just "wav vs. everything else".
//
//   node --experimental-strip-types --test src/lib/audioFormat.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { extensionForMime } from './audioFormat.ts';

test('extensionForMime: audio/wav -> wav (Gemini\'s format, and OpenAI\'s default)', () => {
  assert.equal(extensionForMime('audio/wav'), 'wav');
});

test('extensionForMime: audio/mpeg -> mp3 (OpenAI response_format=mp3)', () => {
  assert.equal(extensionForMime('audio/mpeg'), 'mp3');
});

test('extensionForMime: audio/aac -> aac', () => {
  assert.equal(extensionForMime('audio/aac'), 'aac');
});

test('extensionForMime: audio/flac -> flac', () => {
  assert.equal(extensionForMime('audio/flac'), 'flac');
});

test('extensionForMime: audio/opus -> opus', () => {
  assert.equal(extensionForMime('audio/opus'), 'opus');
});

test('extensionForMime: is case-insensitive', () => {
  assert.equal(extensionForMime('AUDIO/WAV'), 'wav');
  assert.equal(extensionForMime('Audio/Mpeg'), 'mp3');
});

test('extensionForMime: absent/unrecognized mime falls back to m4a (matches prior behavior)', () => {
  assert.equal(extensionForMime(undefined), 'm4a');
  assert.equal(extensionForMime(null), 'm4a');
  assert.equal(extensionForMime(''), 'm4a');
  assert.equal(extensionForMime('application/octet-stream'), 'm4a');
});
