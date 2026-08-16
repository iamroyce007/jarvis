import { contextBridge, ipcRenderer } from 'electron'
import type { SessionInfo, JarvisState, TranscriptEntry, ActivityStep } from '../../shared/types.js'
import type { ErrorRecord } from '../main/store/errors.js'
import type { Turn } from '../main/store/conversations.js'

const api = {
  getSession: (): Promise<SessionInfo> => ipcRenderer.invoke('session:info'),
  getState: (): Promise<JarvisState> => ipcRenderer.invoke('jarvis:state'),

  ask: (text: string): Promise<void> => ipcRenderer.invoke('jarvis:ask', text),
  interrupt: (): Promise<void> => ipcRenderer.invoke('jarvis:interrupt'),
  setConversation: (on: boolean): Promise<void> => ipcRenderer.invoke('jarvis:conversation', on),

  setListening: (on: boolean): Promise<void> => ipcRenderer.invoke('voice:listen', on),
  setMuted: (on: boolean): Promise<void> => ipcRenderer.invoke('voice:mute', on),
  requestVoiceAuth: (): Promise<void> => ipcRenderer.invoke('voice:auth'),
  openVoiceSettings: (pane: 'SpeechRecognition' | 'Microphone' | 'Dictation'): Promise<void> =>
    ipcRenderer.invoke('voice:open-settings', pane),

  newSession: (): Promise<SessionInfo> => ipcRenderer.invoke('claude:new-session'),
  setPersonality: (p: string): Promise<SessionInfo> =>
    ipcRenderer.invoke('claude:set-personality', p),

  getHistory: (limit?: number): Promise<Turn[]> => ipcRenderer.invoke('history:recent', limit),
  searchHistory: (q: string, limit?: number): Promise<Turn[]> =>
    ipcRenderer.invoke('history:search', q, limit),
  clearHistory: (): Promise<void> => ipcRenderer.invoke('history:clear'),
  exportHistory: (): Promise<string> => ipcRenderer.invoke('history:export'),

  getErrors: (limit?: number): Promise<ErrorRecord[]> =>
    ipcRenderer.invoke('errors:recent', limit),
  clearErrors: (): Promise<void> => ipcRenderer.invoke('errors:clear'),
  exportErrors: (): Promise<string> => ipcRenderer.invoke('errors:export'),

  onListening: (cb: (on: boolean) => void) => sub('listening', cb),
  onState: (cb: (s: JarvisState) => void) => sub('state', cb),
  onTranscript: (cb: (t: TranscriptEntry) => void) => sub('transcript', cb),
  onActivity: (cb: (a: ActivityStep) => void) => sub('activity', cb),
  onLevel: (cb: (l: number) => void) => sub('level', cb),
  onSession: (cb: (s: SessionInfo) => void) => sub('session', cb),
  onError: (cb: (m: string) => void) => sub('jarvis-error', cb),
  onVoiceError: (cb: (m: string) => void) => sub('voice-error', cb),
  onVoiceAuth: (cb: (a: { ok: boolean; status: string }) => void) => sub('voice-auth', cb)
}

function sub<T>(channel: string, cb: (v: T) => void): () => void {
  const handler = (_e: unknown, value: T): void => cb(value)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

contextBridge.exposeInMainWorld('jarvis', api)

export type JarvisAPI = typeof api
