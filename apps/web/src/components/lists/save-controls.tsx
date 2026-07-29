'use client';

import { useId, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  EMPTY_SAVE_STATE,
  LIST_NAME_MAX,
  formatDateLabel,
  plural,
  todayLocal,
} from '@switchback/core';
import { askAgain } from '../../lib/after-write';
import { useTRPC } from '../../trpc/react';
import { Mark, type MarkShape } from './marks';
import { BUTTON_COLLAR, DANGER, GHOST, HEIGHT, OUTLINE } from '../controls';

/**
 * What this trail is to you.
 *
 * Three marks and a shelf. The marks are a hiker's own annotations on a printed sheet —
 * ring the ones worth returning to, flag the ones still ahead, tick the ones done — and the
 * shelf is the lists those marks are not specific enough for.
 *
 * **Two of the three are toggles and the third is not, and the row does not pretend
 * otherwise.** Ring and flag are opinions, revisable at no cost. A tick is a claim about a
 * day you were somewhere, and it carries a date whether or not anyone asked for one, so the
 * first tap logs today and a line appears underneath saying which day it recorded and
 * offering to correct it. Un-ticking with several hikes on the record asks first, because
 * "no I haven't" quietly deleting three dated entries is not what the gesture means.
 *
 * **Ink, not survey.** Every pressed control in this product is ink-on-canvas — the chips in
 * the index, the conditions in a report, and these. Red stays where the sign-in page put it:
 * the reader and their safety. Three filled red buttons on a trail page is how a colour that
 * has to still mean something on a ridge stops meaning anything.
 *
 * Signed out the row renders the same three shapes at the same size, as links to sign in.
 * Nothing shifts when the page comes back, and the controls themselves say what an account
 * is for better than a banner above them would.
 */

export interface SaveControlsProps {
  trailId: string;
  /** Where to return after signing in. */
  trailPath: string;
  /** Null when signed out — drives the whole row, not just its disabled state. */
  viewerId: string | null;
}

interface MarkDef {
  shape: MarkShape;
  label: string;
  /** Said in place of the label when the mark is set, for the screen reader. */
  pressedLabel: string;
}

const RING: MarkDef = { shape: 'ring', label: 'Favourite', pressedLabel: 'Favourited' };
const FLAG: MarkDef = {
  shape: 'flag',
  label: 'Want to do',
  pressedLabel: 'On your want-to-do list',
};
const TICK: MarkDef = { shape: 'tick', label: 'Done', pressedLabel: 'Marked done' };

const BASE_BUTTON = `inline-flex ${HEIGHT.panel} items-center gap-xs rounded-hair border px-md text-caption font-medium transition-colors duration-quick ease-standard`;
const PRESSED = 'border-ink bg-ink text-canvas';
const UNPRESSED = 'border-bezel text-ink-muted hover:border-ink-muted hover:text-ink';

export function SaveControls({ trailId, trailPath, viewerId }: SaveControlsProps) {
  const trpc = useTRPC();
  const router = useRouter();
  const queryClient = useQueryClient();

  const [listsOpen, setListsOpen] = useState(false);
  const [loggingOpen, setLoggingOpen] = useState(false);
  const [logDate, setLogDate] = useState(todayLocal);
  const [confirmingForget, setConfirmingForget] = useState(false);
  const [newListName, setNewListName] = useState('');

  const dateId = useId();
  const newListId = useId();

  const state = useQuery(
    trpc.lists.saveState.queryOptions({ trailId }, { enabled: viewerId !== null }),
  );
  // The panel's contents are only ever read while it is open, so the query is too. Opening it
  // is the one moment in this component where a spinner is honest.
  const lists = useQuery(trpc.lists.mine.queryOptions(undefined, { enabled: listsOpen }));

  /** Every write here moves something `lists.*` answers, so they all settle the same way. */
  function settle(): void {
    void askAgain(queryClient, trpc.lists.pathFilter());
    // The title block is server rendered and carries the popularity a logged hike just moved.
    router.refresh();
  }

  const toggle = useMutation(trpc.lists.toggle.mutationOptions({ onSuccess: settle }));
  const record = useMutation(
    trpc.lists.recordCompletion.mutationOptions({
      onSuccess: () => {
        setLoggingOpen(false);
        settle();
      },
    }),
  );
  const forget = useMutation(
    trpc.lists.forgetCompletion.mutationOptions({
      onSuccess: () => {
        setConfirmingForget(false);
        settle();
      },
    }),
  );
  const addTrail = useMutation(trpc.lists.addTrail.mutationOptions({ onSuccess: settle }));
  const removeTrail = useMutation(trpc.lists.removeTrail.mutationOptions({ onSuccess: settle }));
  const createList = useMutation(
    trpc.lists.create.mutationOptions({
      onSuccess: async (list) => {
        setNewListName('');
        // Made and filled in one gesture: nobody creates a list from a trail page and then
        // means to leave that trail out of it.
        await addTrail.mutateAsync({ listId: list.id, trailId });
        settle();
      },
    }),
  );

  const error =
    toggle.error ??
    record.error ??
    forget.error ??
    addTrail.error ??
    removeTrail.error ??
    createList.error;

  if (viewerId === null) {
    const href = `/signin?callbackUrl=${encodeURIComponent(trailPath)}`;
    return (
      <div className="flex flex-wrap items-center gap-sm">
        {[RING, FLAG, TICK].map((mark) => (
          <Link key={mark.shape} href={href} className={`${BASE_BUTTON} ${UNPRESSED}`}>
            <Mark shape={mark.shape} />
            {mark.label}
          </Link>
        ))}
        <p className="text-caption text-ink-muted">
          <Link
            href={href}
            className="underline decoration-bezel underline-offset-4 hover:decoration-ink"
          >
            Sign in
          </Link>{' '}
          to keep this one.
        </p>
      </div>
    );
  }

  const saved = state.data ?? EMPTY_SAVE_STATE;
  const customLists = (lists.data ?? []).filter((list) => list.kind === 'custom');
  const busy = toggle.isPending || record.isPending || forget.isPending;

  function markDone(): void {
    if (saved.completedCount === 0) {
      record.mutate({ trailId, completedAt: todayLocal() });
      return;
    }
    // More than one hike on the record is more than one thing to lose, so it asks.
    if (saved.completedCount > 1 && !confirmingForget) {
      setConfirmingForget(true);
      return;
    }
    forget.mutate({ trailId });
  }

  return (
    <div>
      <div className="flex flex-wrap items-center gap-sm">
        <MarkButton
          def={RING}
          pressed={saved.favorite}
          disabled={busy}
          onClick={() => toggle.mutate({ trailId, kind: 'favorites' })}
        />
        <MarkButton
          def={FLAG}
          pressed={saved.wantToDo}
          disabled={busy}
          onClick={() => toggle.mutate({ trailId, kind: 'want_to_do' })}
        />
        <MarkButton
          def={TICK}
          pressed={saved.completedCount > 0}
          disabled={busy}
          onClick={markDone}
        />

        <button
          type="button"
          aria-expanded={listsOpen}
          onClick={() => setListsOpen((open) => !open)}
          className={`${BASE_BUTTON} ${
            saved.listIds.length > 0 ? 'border-ink-muted text-ink' : UNPRESSED
          }`}
        >
          {saved.listIds.length > 0
            ? `In ${saved.listIds.length} ${plural(saved.listIds.length, 'list')}`
            : 'Add to a list'}
        </button>
      </div>

      {/* ── The hike, once there is one ─────────────────────────────────────────────── */}
      {saved.completedCount > 0 ? (
        <p className="mt-sm flex flex-wrap items-baseline gap-x-sm gap-y-xs font-mono text-micro text-ink-muted">
          <span>
            Hiked {saved.lastCompletedAt ? formatDateLabel(saved.lastCompletedAt) : 'once'}
            {saved.completedCount > 1 ? ` · ${saved.completedCount} times` : ''}
          </span>
          {/*
           * A separator, because the line is one type treatment end to end — mono, micro,
           * muted — and without it "Hiked 27 Jul 2026" and the control after it read as a
           * single run-on phrase. The same middot the count above already uses.
           */}
          <span aria-hidden="true">·</span>
          {loggingOpen ? (
            <>
              <label htmlFor={dateId} className="sr-only">
                Another day you hiked this
              </label>
              <input
                id={dateId}
                type="date"
                value={logDate}
                max={todayLocal()}
                onChange={(event) => setLogDate(event.target.value)}
                className="dial"
              />
              <button
                type="button"
                disabled={!logDate || record.isPending}
                onClick={() => record.mutate({ trailId, completedAt: logDate })}
                className="uppercase text-ink underline decoration-bezel underline-offset-4 hover:decoration-ink disabled:opacity-40"
              >
                {record.isPending ? 'Adding…' : 'Add'}
              </button>
              <button
                type="button"
                onClick={() => setLoggingOpen(false)}
                className="uppercase hover:text-ink"
              >
                Cancel
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => setLoggingOpen(true)}
              className="uppercase hover:text-ink"
            >
              Log another day
            </button>
          )}
        </p>
      ) : null}

      {confirmingForget ? (
        <p className="mt-sm flex flex-wrap items-center gap-sm text-caption text-ink-muted">
          {saved.completedCount > 1
            ? `Forget all ${saved.completedCount} hikes on this trail?`
            : 'Forget that you hiked this?'}
          <button
            type="button"
            onClick={() => forget.mutate({ trailId })}
            className={`${BUTTON_COLLAR} ${DANGER} ${HEIGHT.panel} px-md`}
          >
            {forget.isPending
              ? 'Forgetting…'
              : saved.completedCount > 1
                ? 'Forget them'
                : 'Forget it'}
          </button>
          <button
            type="button"
            onClick={() => setConfirmingForget(false)}
            className={`${BUTTON_COLLAR} ${GHOST} ${HEIGHT.panel} px-sm`}
          >
            Keep them
          </button>
        </p>
      ) : null}

      {/* ── The shelf ───────────────────────────────────────────────────────────────── */}
      {listsOpen ? (
        <div className="mt-md rounded-hair border border-bezel bg-surface p-md">
          <p className="collar">Your lists</p>

          {lists.isPending ? (
            <p className="mt-sm text-caption text-ink-muted">Fetching…</p>
          ) : customLists.length === 0 ? (
            <p className="mt-sm max-w-measure text-caption text-ink-muted">
              Nothing beyond the three you start with. A list is for a set with a reason — winter
              scrambles, hikes the dog can do, everything within an hour of home.
            </p>
          ) : (
            <ul className="mt-sm flex flex-col gap-xs">
              {customLists.map((list) => {
                const inIt = saved.listIds.includes(list.id);
                return (
                  <li key={list.id}>
                    <button
                      type="button"
                      aria-pressed={inIt}
                      disabled={addTrail.isPending || removeTrail.isPending}
                      onClick={() =>
                        inIt
                          ? removeTrail.mutate({ listId: list.id, trailId })
                          : addTrail.mutate({ listId: list.id, trailId })
                      }
                      className={`flex w-full items-center gap-sm rounded-hair border px-sm py-xs text-left text-caption transition-colors duration-quick ease-standard ${
                        inIt ? 'border-ink text-ink' : UNPRESSED
                      }`}
                    >
                      {/*
                       * The tick is the mark, not a checkbox glyph — the same shape the row
                       * above uses for "done", because both answer "is it in".
                       */}
                      <span
                        aria-hidden
                        className={`flex h-[16px] w-[16px] shrink-0 items-center justify-center rounded-hair border ${
                          inIt ? 'border-ink bg-ink text-canvas' : 'border-bezel'
                        }`}
                      >
                        {inIt ? <Mark shape="tick" size={11} /> : null}
                      </span>
                      <span className="min-w-0 flex-1 truncate">{list.name}</span>
                      <span className="shrink-0 font-mono text-micro text-ink-muted">
                        {list.trailCount}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}

          <div className="mt-md flex flex-wrap items-center gap-sm border-t border-bezel pt-md">
            <label htmlFor={newListId} className="collar">
              New list
            </label>
            <input
              id={newListId}
              value={newListName}
              maxLength={LIST_NAME_MAX}
              placeholder="Winter scrambles"
              onChange={(event) => setNewListName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' || !newListName.trim()) return;
                event.preventDefault();
                createList.mutate({ name: newListName.trim(), isPublic: false });
              }}
              className="min-w-0 flex-1 rounded-hair border border-bezel bg-canvas px-sm py-xs text-caption text-ink placeholder:text-ink-muted"
            />
            <button
              type="button"
              disabled={!newListName.trim() || createList.isPending}
              onClick={() => createList.mutate({ name: newListName.trim(), isPublic: false })}
              className={`${BUTTON_COLLAR} ${OUTLINE} ${HEIGHT.panel} px-md`}
            >
              {createList.isPending ? 'Making…' : 'Make it'}
            </button>
          </div>

          <p className="mt-md">
            <Link
              href="/lists"
              className="collar underline decoration-bezel underline-offset-4 hover:decoration-ink"
            >
              All your lists
            </Link>
          </p>
        </div>
      ) : null}

      {error ? <p className="mt-sm text-caption text-survey">{error.message}</p> : null}
    </div>
  );
}

function MarkButton({
  def,
  pressed,
  disabled,
  onClick,
}: {
  def: MarkDef;
  pressed: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
      className={`${BASE_BUTTON} ${pressed ? PRESSED : UNPRESSED} disabled:opacity-50`}
    >
      <Mark shape={def.shape} />
      {def.label}
      <span className="sr-only">{pressed ? ` — ${def.pressedLabel}` : ''}</span>
    </button>
  );
}
