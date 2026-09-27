/** User-started reply reading. Playback completion is observable; actual hearing is not. */
export interface VoiceTurnSnapshot {
  sessionPath: string;
  turnId: string;
  generation: number;
  generatedText: string;
  requestedSegments: number;
  completedSegments: number;
  completedPlaybackText: string;
  totalSegments: number;
  status: 'speaking' | 'completed' | 'interrupted' | 'failed';
  error?: string;
}

type VoiceSynth = Pick<SpeechSynthesis, 'speak' | 'cancel'>;
type UtteranceFactory = (text: string) => SpeechSynthesisUtterance;

export function splitVoiceSegments(text: string, maxCharacters = 160): string[] {
  const sentences = text.match(/[^。！？.!?；;\n]+[。！？.!?；;\n]*|[。！？.!?；;\n]+/gu) || [];
  const segments: string[] = [];
  for (const sentence of sentences) {
    const chars = Array.from(sentence);
    for (let index = 0; index < chars.length; index += maxCharacters) {
      const part = chars.slice(index, index + maxCharacters).join('');
      if (part.trim()) segments.push(part);
    }
  }
  return segments;
}

export class VoiceTurnController {
  private static readonly MAX_SNAPSHOTS = 100;
  private generation = 0;
  private active: VoiceTurnSnapshot | null = null;
  private snapshots = new Map<string, VoiceTurnSnapshot>();
  private listeners = new Set<() => void>();

  constructor(
    private readonly getSynth: () => VoiceSynth | undefined = () => globalThis.speechSynthesis,
    private readonly createUtterance: UtteranceFactory = text => new SpeechSynthesisUtterance(text),
  ) {}

  private key(sessionPath: string, turnId: string): string {
    return `${sessionPath}\u0000${turnId}`;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  getTurn = (sessionPath: string, turnId: string): VoiceTurnSnapshot | null =>
    this.snapshots.get(this.key(sessionPath, turnId)) || null;

  getActive = (): VoiceTurnSnapshot | null => this.active;

  isAvailable(): boolean {
    return !!this.getSynth() && typeof globalThis.SpeechSynthesisUtterance === 'function';
  }

  private publish(next: VoiceTurnSnapshot): void {
    const key = this.key(next.sessionPath, next.turnId);
    // Refresh insertion order so the last 100 interacted-with turns remain inspectable.
    this.snapshots.delete(key);
    this.snapshots.set(key, next);
    while (this.snapshots.size > VoiceTurnController.MAX_SNAPSHOTS) {
      const oldest = this.snapshots.keys().next().value;
      if (oldest === undefined) break;
      this.snapshots.delete(oldest);
    }
    this.active = next.status === 'speaking' ? next : null;
    for (const listener of this.listeners) listener();
  }

  interrupt(sessionPath?: string): void {
    const active = this.active;
    if (!active || (sessionPath && active.sessionPath !== sessionPath)) return;
    this.generation += 1;
    this.publish({ ...active, status: 'interrupted' });
    // Invalidating the generation first also rejects synchronous cancel callbacks.
    this.getSynth()?.cancel();
  }

  interruptExceptSession(sessionPath: string | null): void {
    if (this.active && this.active.sessionPath !== sessionPath) this.interrupt();
  }

  start(sessionPath: string, turnId: string, generatedText: string): boolean {
    const synth = this.getSynth();
    if (!synth || !sessionPath || !turnId || !generatedText.trim()) return false;
    this.interrupt();
    const generation = ++this.generation;
    const segments = splitVoiceSegments(generatedText);
    if (!segments.length) return false;
    let index = 0;
    let next: VoiceTurnSnapshot = {
      sessionPath, turnId, generation, generatedText, requestedSegments: 0,
      completedSegments: 0, completedPlaybackText: '', totalSegments: segments.length,
      status: 'speaking',
    };
    const isCurrent = () => this.generation === generation
      && this.active?.sessionPath === sessionPath && this.active?.turnId === turnId
      && this.active.status === 'speaking';
    const playNext = () => {
      if (!isCurrent()) return;
      if (index >= segments.length) {
        next = { ...next, status: 'completed' };
        this.publish(next);
        return;
      }
      const segment = segments[index];
      let utterance: SpeechSynthesisUtterance;
      try {
        utterance = this.createUtterance(segment);
        utterance.lang = 'zh-CN';
        utterance.onend = () => {
          if (!isCurrent()) return;
          next = {
            ...next,
            completedSegments: index + 1,
            completedPlaybackText: next.completedPlaybackText + segment,
          };
          index += 1;
          this.publish(next);
          playNext();
        };
        utterance.onerror = (event) => {
          if (!isCurrent()) return;
          next = { ...next, status: 'failed', error: event.error || '语音播放失败' };
          this.generation += 1;
          this.publish(next);
          synth.cancel();
        };
        next = { ...next, requestedSegments: index + 1 };
        this.publish(next);
        synth.speak(utterance);
      } catch (error) {
        if (!isCurrent()) return;
        next = { ...next, status: 'failed', error: error instanceof Error ? error.message : String(error) };
        this.generation += 1;
        this.publish(next);
        synth.cancel();
      }
    };
    this.publish(next);
    playNext();
    return true;
  }
}

export const voiceTurns = new VoiceTurnController();
