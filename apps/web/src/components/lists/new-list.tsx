'use client';

import { useId, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { LIST_NAME_MAX, MAX_CUSTOM_LISTS } from '@switchback/core';
import { askAgain } from '../../lib/after-write';
import { useTRPC } from '../../trpc/react';
import { BUTTON_COLLAR, GHOST, HEIGHT, OUTLINE, PRIMARY } from '../controls';

/**
 * Starting a list.
 *
 * Closed until asked for. The page is for reading the lists that exist; a permanently open
 * form at the top of it would make making one look like the main event, and it is the thing
 * you do once every few months.
 *
 * A name and nothing else. Description and visibility are on the list's own page, where
 * there is something to describe — asking for a description of an empty list is asking a
 * question the person cannot answer yet.
 */

export function NewList({ count }: { count: number }) {
  const trpc = useTRPC();
  const router = useRouter();
  const queryClient = useQueryClient();

  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const nameId = useId();

  const create = useMutation(
    trpc.lists.create.mutationOptions({
      onSuccess: (list) => {
        setName('');
        setOpen(false);
        void askAgain(queryClient, trpc.lists.pathFilter());
        // Straight into it: a list made and then left on the index is a list you now have to
        // find. The next thing anyone does is put something in it.
        router.push(`/lists/${list.slug}`);
      },
    }),
  );

  const full = count >= MAX_CUSTOM_LISTS;

  if (!open) {
    return (
      <button
        type="button"
        disabled={full}
        onClick={() => setOpen(true)}
        title={full ? `You can keep up to ${MAX_CUSTOM_LISTS} lists.` : undefined}
        className={`${BUTTON_COLLAR} ${OUTLINE} ${HEIGHT.panel} px-md`}
      >
        New list
      </button>
    );
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (!name.trim()) return;
        create.mutate({ name: name.trim(), isPublic: false });
      }}
      className="flex flex-wrap items-center gap-sm"
    >
      <label htmlFor={nameId} className="sr-only">
        Name the list
      </label>
      <input
        id={nameId}
        // The control that opened this form is gone from the page; focus has to land
        // somewhere, and the field it was replaced by is the only honest place for it.
        autoFocus
        value={name}
        maxLength={LIST_NAME_MAX}
        placeholder="Winter scrambles"
        onChange={(event) => setName(event.target.value)}
        className="min-w-[16ch] rounded-hair border border-bezel bg-canvas px-sm py-xs text-caption text-ink placeholder:text-ink-muted"
      />
      <button
        type="submit"
        disabled={!name.trim() || create.isPending}
        className={`${BUTTON_COLLAR} ${PRIMARY} ${HEIGHT.panel} px-md`}
      >
        {create.isPending ? 'Making…' : 'Make it'}
      </button>
      <button
        type="button"
        onClick={() => {
          setOpen(false);
          setName('');
        }}
        className={`${BUTTON_COLLAR} ${GHOST} ${HEIGHT.panel} px-sm`}
      >
        Cancel
      </button>
      {create.isError ? (
        <p className="w-full text-caption text-survey">{create.error.message}</p>
      ) : null}
    </form>
  );
}
