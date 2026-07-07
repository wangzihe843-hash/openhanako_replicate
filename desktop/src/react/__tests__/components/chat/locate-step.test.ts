import { describe, expect, it } from 'vitest';
import { resolveLocateStep } from '../../../components/chat/locate-step';

describe('resolveLocateStep', () => {
  it('目标元素已注册 → scroll', () => {
    expect(resolveLocateStep({ targetIndex: 5, elementPresent: true, itemPresent: true, oldestId: '3', hasMore: true, loadingMore: false }))
      .toBe('scroll');
  });
  it('目标早于已加载窗口且可翻页 → load-more', () => {
    expect(resolveLocateStep({ targetIndex: 1, elementPresent: false, itemPresent: false, oldestId: '10', hasMore: true, loadingMore: false }))
      .toBe('load-more');
  });
  it('翻页在途 → wait', () => {
    expect(resolveLocateStep({ targetIndex: 1, elementPresent: false, itemPresent: false, oldestId: '10', hasMore: true, loadingMore: true }))
      .toBe('wait');
  });
  it('翻页耗尽仍未加载 → give-up', () => {
    expect(resolveLocateStep({ targetIndex: 1, elementPresent: false, itemPresent: false, oldestId: '10', hasMore: false, loadingMore: false }))
      .toBe('give-up');
  });
  it('在窗口内但 items 中无该 id（前端不可渲染的消息）→ give-up', () => {
    expect(resolveLocateStep({ targetIndex: 12, elementPresent: false, itemPresent: false, oldestId: '10', hasMore: false, loadingMore: false }))
      .toBe('give-up');
  });
  it('items 有该 id 但元素未注册（commit 间隙或不可渲染）→ wait-element（消费方有界等待）', () => {
    expect(resolveLocateStep({ targetIndex: 12, elementPresent: false, itemPresent: true, oldestId: '10', hasMore: false, loadingMore: false }))
      .toBe('wait-element');
  });
  it('items 有该 id 且翻页在途 → 仍是 wait-element（loadingMore 不影响该分支）', () => {
    expect(resolveLocateStep({ targetIndex: 12, elementPresent: false, itemPresent: true, oldestId: '10', hasMore: true, loadingMore: true }))
      .toBe('wait-element');
  });
  it('oldestId 缺失（尚未初始化）→ wait', () => {
    expect(resolveLocateStep({ targetIndex: 3, elementPresent: false, itemPresent: false, oldestId: undefined, hasMore: false, loadingMore: false }))
      .toBe('wait');
  });
});
