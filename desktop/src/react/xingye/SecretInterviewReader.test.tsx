/**
 * @vitest-environment jsdom
 */
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SecretInterviewReader } from './SecretInterviewReader';
import type {
  SecretInterviewMetadata,
  SecretInterviewProp,
} from './xingye-secret-space-interview-types';

function makeQuestion(qPrefix: string) {
  return {
    q: `${qPrefix} 一个问题？`,
    a: `这是 ${qPrefix} 的答案。`.padEnd(80, 'A'),
    danmaku: [
      { text: '弹幕', tag: 'audience' as const },
      { text: '另一条', tag: 'editor' as const },
      { text: '第三条', tag: 'fan' as const },
    ],
  };
}

function makeMeta(overrides?: Partial<SecretInterviewMetadata>): SecretInterviewMetadata {
  return {
    recordedAt: '2026-05-20T10:00:00.000Z',
    title: '专访 · 林雾：边境医者的沉默与信诺',
    hostName: '程砚',
    hostIntro: '演播室的灯光打下来——'.repeat(8) + '主持人朝 TA 点了点头。',
    questions: [
      makeQuestion('Q1'),
      makeQuestion('Q2'),
      makeQuestion('Q3'),
      makeQuestion('Q4'),
      makeQuestion('Q5'),
    ],
    backstage: '相机关了之后，TA 站起身——'.repeat(8) + '走到门边，没回头。',
    ...overrides,
  };
}

function sampleProps(): SecretInterviewProp[] {
  return [
    { id: 'button', label: '黄铜纽扣', icon: 'button', x: 72, y: 42, snippet: '岑姨给的。' },
    { id: 'cup', label: '没动过的水', icon: 'cup', x: 20, y: 64, snippet: '一口没喝。' },
    { id: 'cable', label: '麦克风线', icon: 'cable', x: 56, y: 80, snippet: '其实没真关。' },
  ];
}

/** 把 Reader 翻到 backstage 页：依次点 next → ...直到点 backstage reveal。 */
function gotoBackstage() {
  // intro → q0..q4 共 6 次 next，最后点 backstage reveal
  for (let i = 0; i < 5; i++) {
    fireEvent.click(screen.getByTestId('interview-next'));
  }
  fireEvent.click(screen.getByTestId('interview-reveal-backstage'));
}

beforeEach(() => {
  vi.useFakeTimers();
  // jsdom 没 localStorage 实现差异；清掉避免污染
  try {
    window.localStorage.removeItem('xingye.interview.danmakuOn');
  } catch {
    // ignore
  }
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe('SecretInterviewReader · 基本翻页 & data-testid', () => {
  it('保留所有现有 data-testid（防止快照式回归）', () => {
    render(<SecretInterviewReader meta={makeMeta()} />);
    expect(screen.getByTestId('secret-interview-reader')).toBeInTheDocument();
    expect(screen.getByTestId('interview-stage-intro')).toBeInTheDocument();
    expect(screen.getByTestId('interview-prev')).toBeInTheDocument();
    expect(screen.getByTestId('interview-next')).toBeInTheDocument();
    expect(screen.getByTestId('interview-toggle-danmaku')).toBeInTheDocument();
  });

  it('intro → q0 → q1 ... → q4 → backstage 翻页路径', () => {
    render(<SecretInterviewReader meta={makeMeta()} />);
    expect(screen.getByTestId('interview-stage-intro')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('interview-next'));
    expect(screen.getByTestId('interview-stage-q0')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('interview-next'));
    fireEvent.click(screen.getByTestId('interview-next'));
    fireEvent.click(screen.getByTestId('interview-next'));
    fireEvent.click(screen.getByTestId('interview-next'));
    expect(screen.getByTestId('interview-stage-q4')).toBeInTheDocument();
    // 最后一题应当出现 backstage reveal 入口（next 已被替换）
    expect(screen.getByTestId('interview-reveal-backstage')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('interview-reveal-backstage'));
    expect(screen.getByTestId('interview-stage-backstage')).toBeInTheDocument();
  });
});

describe('SecretInterviewReader · Backstage phase 状态机', () => {
  it('进 backstage 时初始 phase=idle；物件不挂载', () => {
    render(<SecretInterviewReader meta={makeMeta({ backstageProps: sampleProps() })} />);
    gotoBackstage();
    const reader = screen.getByTestId('secret-interview-reader');
    expect(reader.getAttribute('data-backstage-phase')).toBe('idle');
    // 物件按钮还没出现（phase 推到 text 才挂载）
    expect(screen.queryByTestId('interview-backstage-prop-button')).toBeNull();
  });

  it('推进 timer：phase 依次过 recBlinking → recOff → dim → text → done', () => {
    render(<SecretInterviewReader meta={makeMeta({ backstageProps: sampleProps() })} />);
    gotoBackstage();
    const reader = screen.getByTestId('secret-interview-reader');
    expect(reader.getAttribute('data-backstage-phase')).toBe('idle');

    act(() => { vi.advanceTimersByTime(150); });
    expect(reader.getAttribute('data-backstage-phase')).toBe('recBlinking');

    act(() => { vi.advanceTimersByTime(800); });
    expect(reader.getAttribute('data-backstage-phase')).toBe('recOff');

    act(() => { vi.advanceTimersByTime(700); });
    expect(reader.getAttribute('data-backstage-phase')).toBe('dim');

    act(() => { vi.advanceTimersByTime(800); });
    expect(reader.getAttribute('data-backstage-phase')).toBe('text');

    act(() => { vi.advanceTimersByTime(1600); });
    expect(reader.getAttribute('data-backstage-phase')).toBe('done');
  });

  it('phase 推到 text 才挂载物件按钮（fake timers）', () => {
    render(<SecretInterviewReader meta={makeMeta({ backstageProps: sampleProps() })} />);
    gotoBackstage();

    // phase=idle / recBlinking / recOff / dim：还没挂物件
    expect(screen.queryByTestId('interview-backstage-prop-button')).toBeNull();
    act(() => { vi.advanceTimersByTime(2300); });
    // 应当尚未到 text（2400ms）
    expect(screen.queryByTestId('interview-backstage-prop-button')).toBeNull();

    act(() => { vi.advanceTimersByTime(200); }); // 总 2500ms，越过 text 边界
    expect(screen.getByTestId('interview-backstage-prop-button')).toBeInTheDocument();
    expect(screen.getByTestId('interview-backstage-prop-cup')).toBeInTheDocument();
    expect(screen.getByTestId('interview-backstage-prop-cable')).toBeInTheDocument();
  });

  it('离开 backstage 再回来 → phase 重置为 idle 并重新跑（不残留 done 态）', () => {
    render(<SecretInterviewReader meta={makeMeta({ backstageProps: sampleProps() })} />);
    gotoBackstage();
    act(() => { vi.advanceTimersByTime(5000); });
    const reader = screen.getByTestId('secret-interview-reader');
    expect(reader.getAttribute('data-backstage-phase')).toBe('done');

    fireEvent.click(screen.getByTestId('interview-back-to-qna'));
    expect(reader.getAttribute('data-backstage-phase')).toBe('idle');

    fireEvent.click(screen.getByTestId('interview-reveal-backstage'));
    // 重新进 backstage：phase 重新从 idle 起跑
    expect(reader.getAttribute('data-backstage-phase')).toBe('idle');
    expect(screen.queryByTestId('interview-backstage-prop-button')).toBeNull();
  });

  it('meta.backstageProps 缺失时：到 done 也不会挂物件按钮（优雅降级）', () => {
    render(<SecretInterviewReader meta={makeMeta()} />); // 不带 props
    gotoBackstage();
    act(() => { vi.advanceTimersByTime(5000); });
    expect(screen.queryByTestId('interview-backstage-prop-button')).toBeNull();
  });
});

describe('SecretInterviewReader · 物件 click 浮卡', () => {
  function setupAtDone(meta?: Partial<SecretInterviewMetadata>) {
    render(<SecretInterviewReader meta={makeMeta({ backstageProps: sampleProps(), ...meta })} />);
    gotoBackstage();
    act(() => { vi.advanceTimersByTime(5000); });
  }

  it('点物件 → 浮卡出现（含 label / snippet）', () => {
    setupAtDone();
    const btn = screen.getByTestId('interview-backstage-prop-button');
    fireEvent.click(btn);
    const snippet = screen.getByTestId('interview-backstage-snippet-button');
    expect(snippet).toBeInTheDocument();
    expect(within(snippet).getByText(/黄铜纽扣/)).toBeInTheDocument();
    expect(within(snippet).getByText('岑姨给的。')).toBeInTheDocument();
  });

  it('再点同一物件 → 浮卡消失；物件保留"已揭开"描边 (data-revealed=true)', () => {
    setupAtDone();
    const btn = screen.getByTestId('interview-backstage-prop-button');
    fireEvent.click(btn);
    expect(screen.getByTestId('interview-backstage-snippet-button')).toBeInTheDocument();

    fireEvent.click(btn);
    expect(screen.queryByTestId('interview-backstage-snippet-button')).toBeNull();
    expect(btn.getAttribute('data-revealed')).toBe('true');
    expect(btn.getAttribute('data-active')).toBe('false');
  });

  it('点 A → 点 B → 浮卡切到 B；A 保留 revealed 描边', () => {
    setupAtDone();
    const a = screen.getByTestId('interview-backstage-prop-button');
    const b = screen.getByTestId('interview-backstage-prop-cup');
    fireEvent.click(a);
    fireEvent.click(b);
    expect(screen.queryByTestId('interview-backstage-snippet-button')).toBeNull();
    expect(screen.getByTestId('interview-backstage-snippet-cup')).toBeInTheDocument();
    expect(a.getAttribute('data-revealed')).toBe('true');
    expect(b.getAttribute('data-revealed')).toBe('true');
    expect(b.getAttribute('data-active')).toBe('true');
  });

  it('Esc 键关闭浮卡', () => {
    setupAtDone();
    fireEvent.click(screen.getByTestId('interview-backstage-prop-button'));
    expect(screen.getByTestId('interview-backstage-snippet-button')).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByTestId('interview-backstage-snippet-button')).toBeNull();
  });
});

describe('SecretInterviewReader · 弹幕开关', () => {
  it('默认 ON；点 toggle → OFF；持久化 localStorage', () => {
    render(<SecretInterviewReader meta={makeMeta()} />);
    const toggle = screen.getByTestId('interview-toggle-danmaku');
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    expect(window.localStorage.getItem('xingye.interview.danmakuOn')).toBe('0');
  });

  it('挂载时读取 localStorage：之前关过 → 初始 OFF', () => {
    window.localStorage.setItem('xingye.interview.danmakuOn', '0');
    render(<SecretInterviewReader meta={makeMeta()} />);
    const toggle = screen.getByTestId('interview-toggle-danmaku');
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
  });
});
