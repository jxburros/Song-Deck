/**
 * Serialization (spec §55, §56): MIDI (SMF type 0/1, import & export), MusicXML 4.0,
 * chord & lyric sheets, notation (lead sheet) PDF, DAWproject, Reaper .RPP, tempo map and
 * marker files. All functions are pure and return strings/bytes.
 */
export {
  songToMidi,
  trackToMidi,
  midiToSong,
  parseMidiFile,
  writeMidiFile,
  estimateKeyFromNotes,
} from './midi';
export type { MidiEvent, MidiTrack, MidiFile, SongToMidiOptions, MidiToSongOptions } from './midi';
export { songToMusicXML } from './musicxml';
export type { MusicXmlOptions } from './musicxml';
export { songToChordSheet, songToLyricSheet } from './sheets';
export { songToNotationPdf } from './pdf';
export type { NotationPdfOptions } from './pdf';
export { songToDawProject } from './dawproject';
export type { DawProjectOptions, DawAudioFile } from './dawproject';
export { songToReaperProject } from './reaper';
export type { ReaperOptions, ReaperAudioFile } from './reaper';
export { tempoMapCsv, markersCsv, audacityLabels } from './markers';
export { trackMidiEvents, pluginRenderKey, pluginRenderIsCurrent } from './plugin-midi';
export type { PluginMidiEvent, PluginMidiOptions } from './plugin-midi';
