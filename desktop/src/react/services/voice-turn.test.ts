import { describe, expect, it, vi } from 'vitest';
import { splitVoiceSegments, VoiceTurnController } from './voice-turn';

function makeHarness() {
  const utterances: SpeechSynthesisUtterance[] = [];
  const synth = {
    speak: vi.fn((utterance: SpeechSynthesisUtterance) => { utterances.push(utterance); }),
    cancel: vi.fn(),
  };
  const turns = new VoiceTurnController(
    () => synth,
    text => ({ text, lang: '', onend: null, onerror: null } as unknown as SpeechSynthesisUtterance),
  );
  const finish = (index: number) => { (utterances[index].onend as () => void)?.(); };
  const fail = (index: number) => { (utterances[index].onerror as (event: { error: string }) => void)?.({ error: 'synthesis-failed' }); };
  return { turns, synth, utterances, finish, fail };
}

describe('button-driven voice turns', () => {
  it('queues one sentence at a time, and records only completed playback callbacks', () => {
    const { turns, synth, utterances, finish } = makeHarness();
    const text = '第一句。第二句！第三句。';
    expect(splitVoiceSegments(text).join('')).toBe(text);
    expect(turns.start('/session', 'turn-1', text)).toBe(true);
    expect(synth.speak).toHaveBeenCalledTimes(1);
    expect(turns.getTurn('/session', 'turn-1')).toMatchObject({
      generatedText: text, requestedSegments: 1, completedSegments: 0, completedPlaybackText: '',
    });
    finish(0);
    expect(utterances).toHaveLength(2);
    expect(turns.getTurn('/session', 'turn-1')).toMatchObject({ completedSegments: 1, completedPlaybackText: '第一句。' });
    finish(1);
    finish(2);
    expect(turns.getTurn('/session', 'turn-1')).toMatchObject({ status: 'completed', completedSegments: 3, completedPlaybackText: text });
  });

  it('drops late callbacks after two interruptions and does not queue old audio into a new turn', () => {
    const { turns, synth, utterances, finish, fail } = makeHarness();
    turns.start('/session', 'turn-1', '旧一。旧二。');
    finish(0);
    turns.interrupt('/session');
    expect(turns.getTurn('/session', 'turn-1')).toMatchObject({ status: 'interrupted', completedPlaybackText: '旧一。' });
    finish(1);
    fail(1);
    expect(utterances).toHaveLength(2);
    turns.start('/session', 'turn-2', '新一。新二。');
    turns.interrupt('/session');
    finish(2);
    turns.start('/session', 'turn-3', '最后。');
    finish(3);
    expect(synth.cancel).toHaveBeenCalledTimes(2);
    expect(utterances.map(utterance => utterance.text)).toEqual(['旧一。', '旧二。', '新一。', '最后。']);
    expect(turns.getTurn('/session', 'turn-2')).toMatchObject({ status: 'interrupted', completedPlaybackText: '' });
    expect(turns.getTurn('/session', 'turn-3')).toMatchObject({ status: 'completed', completedPlaybackText: '最后。' });
  });

  it('stops on session switch and leaves failed segments unconfirmed', () => {
    const { turns, synth, utterances, fail, finish } = makeHarness();
    turns.start('/old', 'turn', '未完成。下一句。');
    turns.interruptExceptSession('/new');
    finish(0);
    expect(utterances).toHaveLength(1);
    expect(turns.getTurn('/old', 'turn')).toMatchObject({ status: 'interrupted', completedPlaybackText: '' });
    turns.start('/new', 'turn', '失败。');
    fail(1);
    expect(turns.getTurn('/new', 'turn')).toMatchObject({ status: 'failed', completedPlaybackText: '', error: 'synthesis-failed' });
    expect(synth.cancel).toHaveBeenCalledTimes(2);
  });

  it('bounds retained playback snapshots without reviving callbacks from evicted turns', () => {
    const { turns, utterances, finish } = makeHarness();
    for (let index = 0; index < 105; index += 1) {
      turns.start('/session', `turn-${index}`, '一。二。');
      turns.interrupt();
    }
    expect(turns.getTurn('/session', 'turn-0')).toBeNull();
    expect(turns.getTurn('/session', 'turn-104')?.status).toBe('interrupted');
    finish(0);
    expect(utterances).toHaveLength(105);
  });
});
