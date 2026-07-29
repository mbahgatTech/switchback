import { describe, expect, it } from 'vitest';
import {
  EMPTY_SAVE_STATE,
  LIST_KINDS,
  LIST_NAME_MAX,
  SYSTEM_LIST_EMPTY,
  SYSTEM_LIST_KINDS,
  completionWriteSchema,
  isSystemList,
  listCreateSchema,
  listSlug,
  listUpdateSchema,
} from '../src/lists';

describe('the list vocabulary', () => {
  it('puts favourites first, then want-to-do, then completed', () => {
    expect([...SYSTEM_LIST_KINDS]).toEqual(['favorites', 'want_to_do', 'completed']);
  });

  it('carries custom last so the system lists sort ahead of it by index', () => {
    expect(LIST_KINDS.at(-1)).toBe('custom');
  });

  it('has an empty-state line for every system list and no others', () => {
    expect(Object.keys(SYSTEM_LIST_EMPTY).sort()).toEqual([...SYSTEM_LIST_KINDS].sort());
  });

  it('treats every kind but custom as a system list', () => {
    for (const kind of SYSTEM_LIST_KINDS) expect(isSystemList(kind)).toBe(true);
    expect(isSystemList('custom')).toBe(false);
  });

  it('starts a signed-out viewer with nothing saved', () => {
    expect(EMPTY_SAVE_STATE).toEqual({
      favorite: false,
      wantToDo: false,
      completedCount: 0,
      lastCompletedAt: null,
      listIds: [],
    });
  });
});

describe('listSlug', () => {
  it('lowercases and hyphenates', () => {
    expect(listSlug('Lake District Weekends')).toBe('lake-district-weekends');
  });

  it('folds accents so two spellings of one place share a URL', () => {
    expect(listSlug('Cadaïr Idris')).toBe(listSlug('Cadair Idris'));
  });

  it('collapses runs of punctuation into a single hyphen', () => {
    expect(listSlug('Snowdon — the *good* ones!!')).toBe('snowdon-the-good-ones');
  });

  it('never leaves a leading or trailing hyphen', () => {
    expect(listSlug('  ...Scrambles...  ')).toBe('scrambles');
  });

  it('trims to 60 characters without leaving a dangling hyphen', () => {
    // The 60-character cut lands mid-word here; the trailing hyphen must not survive it.
    const slug = listSlug(`${'a'.repeat(59)} tail`);
    expect(slug.length).toBeLessThanOrEqual(60);
    expect(slug.endsWith('-')).toBe(false);
  });

  it.each([
    ['🥾🥾🥾', 'emoji only'],
    ['???', 'punctuation only'],
    ['山歩き', 'no ASCII at all'],
    ['', 'empty'],
    ['   ', 'whitespace'],
  ])('falls back to "list" for %s (%s)', (name) => {
    expect(listSlug(name)).toBe('list');
  });
});

describe('listCreateSchema', () => {
  it('defaults a new list to private', () => {
    const parsed = listCreateSchema.parse({ name: 'Scrambles' });
    expect(parsed.isPublic).toBe(false);
  });

  it('trims the name', () => {
    expect(listCreateSchema.parse({ name: '  Scrambles  ' }).name).toBe('Scrambles');
  });

  it('rejects a name that is only whitespace', () => {
    expect(listCreateSchema.safeParse({ name: '   ' }).success).toBe(false);
  });

  it('rejects a name past the cap', () => {
    expect(listCreateSchema.safeParse({ name: 'x'.repeat(LIST_NAME_MAX + 1) }).success).toBe(false);
  });
});

describe('listUpdateSchema', () => {
  it('distinguishes an absent field from an explicit null', () => {
    const absent = listUpdateSchema.parse({ listId: 'a' });
    expect('description' in absent).toBe(false);

    const cleared = listUpdateSchema.parse({ listId: 'a', description: null });
    expect(cleared.description).toBeNull();
  });

  it('allows a rename on its own', () => {
    expect(listUpdateSchema.parse({ listId: 'a', name: 'Ridges' }).name).toBe('Ridges');
  });
});

describe('completionWriteSchema', () => {
  it('accepts a calendar date', () => {
    const parsed = completionWriteSchema.parse({ trailId: 't', completedAt: '2025-04-06' });
    expect(parsed.completedAt).toBe('2025-04-06');
  });

  it.each(['2025-02-31', '2025-13-01', '06/04/2025', '2025-4-6', 'yesterday'])(
    'rejects %s',
    (completedAt) => {
      expect(completionWriteSchema.safeParse({ trailId: 't', completedAt }).success).toBe(false);
    },
  );

  it('rejects a hike logged in the future', () => {
    const ahead = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
    expect(completionWriteSchema.safeParse({ trailId: 't', completedAt: ahead }).success).toBe(
      false,
    );
  });
});
