import { describe, expect, it } from 'vitest';
import {
  normalizeCpAltResolutionSpec,
  normalizeCpBoardResult,
  normalizeCpDraftSpec,
  normalizeCpPostSpec,
} from './xingye-cp-types';

describe('normalizeCpPostSpec', () => {
  it('keeps a valid NPC post and normalizes genre', () => {
    const spec = normalizeCpPostSpec({
      genre: 'fic',
      board: 'CP·糖',
      title: '无人知晓的午后',
      body: '一段同人节选',
      authorName: '嗑学家本家',
      comments: [{ authorName: '路人', isAgent: false, body: '磕到了', replies: [] }],
    });
    expect(spec).not.toBeNull();
    expect(spec?.genre).toBe('fic');
    expect(spec?.authorName).toBe('嗑学家本家');
  });

  it('drops a post missing the NPC authorName', () => {
    expect(
      normalizeCpPostSpec({ genre: 'squee', board: 'b', title: 't', body: 'x', comments: [] }),
    ).toBeNull();
  });

  it('drops a post missing title or body', () => {
    expect(normalizeCpPostSpec({ genre: 'fic', board: 'b', title: '', body: 'x', authorName: 'n' })).toBeNull();
    expect(normalizeCpPostSpec({ genre: 'fic', board: 'b', title: 't', body: '', authorName: 'n' })).toBeNull();
  });

  it('falls back to discuss for an unknown genre and reads isAgent on comments', () => {
    const spec = normalizeCpPostSpec({
      genre: 'whatever',
      board: 'b',
      title: 't',
      body: 'x',
      authorName: 'n',
      comments: [{ authorName: '', isAgent: true, body: 'TA 冒泡', replies: [] }],
    });
    expect(spec?.genre).toBe('discuss');
    expect(spec?.comments[0].authorIsAgent).toBe(true);
  });
});

describe('normalizeCpDraftSpec', () => {
  it('keeps a post draft with title and applies reaction fallbacks', () => {
    const d = normalizeCpDraftSpec({ kind: 'post', genre: 'squee', board: 'b', title: '想匿名投稿', body: '正文' });
    expect(d?.kind).toBe('post');
    expect(d?.title).toBe('想匿名投稿');
    expect(d?.sendReaction.length).toBeGreaterThan(0);
    expect(d?.hesitation.length).toBeGreaterThan(0);
  });

  it('drops a post draft without title', () => {
    expect(normalizeCpDraftSpec({ kind: 'post', body: '正文' })).toBeNull();
  });

  it('keeps a reply draft only when targetPostTitle is present', () => {
    expect(normalizeCpDraftSpec({ kind: 'reply', body: '澄清一下' })).toBeNull();
    const d = normalizeCpDraftSpec({ kind: 'reply', body: '别瞎磕', targetPostTitle: '某条帖' });
    expect(d?.kind).toBe('reply');
    expect(d?.targetPostTitle).toBe('某条帖');
  });
});

describe('normalizeCpAltResolutionSpec', () => {
  it('reads pickUsername and newAlt', () => {
    expect(normalizeCpAltResolutionSpec({ pickUsername: '夜行猫', newAlt: null })).toEqual({
      pickUsername: '夜行猫',
      newAlt: null,
    });
    const res = normalizeCpAltResolutionSpec({ pickUsername: null, newAlt: { username: '潜水员', bio: 'b', themeLabel: 't' } });
    expect(res.pickUsername).toBeNull();
    expect(res.newAlt?.username).toBe('潜水员');
  });
});

describe('normalizeCpBoardResult', () => {
  const validPost = {
    genre: 'fic',
    board: 'CP·糖',
    title: 'T',
    body: 'B',
    authorName: 'NPC',
    comments: [{ authorName: 'x', isAgent: false, body: 'c', replies: [] }],
  };

  it('returns null when there are no usable posts', () => {
    expect(normalizeCpBoardResult({ posts: [], drafts: [], followReaction: 'r' })).toBeNull();
    expect(normalizeCpBoardResult({ posts: [{ title: '' }] })).toBeNull();
  });

  it('normalizes a full result and applies followReaction fallback', () => {
    const res = normalizeCpBoardResult({
      cpName: '博君一肖',
      alt: { pickUsername: '夜行猫' },
      posts: [validPost],
      drafts: [{ kind: 'reply', body: 'b', targetPostTitle: 'T', sendReaction: '哎', hesitation: '怂了' }],
      followReaction: '',
    });
    expect(res).not.toBeNull();
    expect(res?.cpName).toBe('博君一肖');
    expect(res?.posts.length).toBe(1);
    expect(res?.drafts.length).toBe(1);
    expect(res?.alt.pickUsername).toBe('夜行猫');
    expect(res?.followReaction.length).toBeGreaterThan(0); // 空串走兜底
  });

  it('leaves cpName empty when absent (ai layer fills the fallback)', () => {
    const res = normalizeCpBoardResult({ posts: [validPost] });
    expect(res?.cpName).toBe('');
  });
});
