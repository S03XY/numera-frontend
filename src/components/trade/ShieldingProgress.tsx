'use client';

import * as React from 'react';
import { TRADE_STATUS } from '@/lib/execution/trading';
import { SETTLED_AT, Waiting } from '@/components/ui/Waiting';

/**
 * What a shielded bet looks like while it is happening.
 *
 * A private bet is not fast: the stake is proven and withdrawn from the shielded
 * pool, then signed and relayed to the market. That is tens of seconds on a good
 * run and longer under load — long enough that a bare "Confirming…" reads as a
 * hang, which is exactly the report we got.
 *
 * So this shows the real thing rather than a spinner. Every stage is driven by an
 * actual status the execution layer reports (`onStatus`), never by a timer, so the
 * progress cannot lie: if the pool stalls, the panel visibly stays there instead
 * of animating on to a step that has not happened.
 *
 * The statuses are {TRADE_STATUS} constants shared with the layer that emits them.
 * They used to be Unlink's session statuses — `prepared`, `user_op_sponsored` and
 * so on — matched as loose strings. None of those exist now that trades are signed
 * and relayed rather than run as vendor sessions, and an unrecognised status holds
 * the stage where it is: the panel would have sat at step one for the whole trade
 * while the trade completed behind it.
 *
 * The mark is the one piece of theatre, and it earns its place by being *honest
 * theatre*: the arc grows as stages complete, so how far round the loop has been
 * drawn is a real progress reading. It stops three quarters of the way round on
 * purpose. See {@link SETTLED_AT} — the receipt that replaces this panel closes
 * the last quarter, so a placed bet is one continuous gesture rather than two
 * unrelated animations.
 */

export type ShieldStage = 'shielding' | 'placing' | 'returning' | 'settled';

interface StageDef {
  key: ShieldStage;
  label: string;
  detail: string;
  /** Session statuses that put the flow at this stage. */
  statuses: readonly string[];
}

/**
 * Ordered, and matched by exact status rather than prefix.
 *
 * An unknown status leaves the stage where it was instead of guessing — the
 * vendor adds statuses without notice, and silently mapping a new one to
 * "settled" would tell the user their money moved when it had not.
 */
export const SHIELD_STAGES: readonly StageDef[] = [
  {
    key: 'shielding',
    label: 'Shielding your stake',
    detail: 'Moving it out of your private balance without revealing which funds are yours.',
    statuses: [TRADE_STATUS.funding],
  },
  {
    key: 'placing',
    label: 'Placing on-chain',
    detail: 'Signed by an address that is only ever used for this market, and sent by our relayer.',
    statuses: [TRADE_STATUS.placing, TRADE_STATUS.closing, TRADE_STATUS.claiming],
  },
  {
    key: 'returning',
    label: 'Shielding the proceeds',
    detail: 'Returning what came back to your private balance.',
    statuses: [TRADE_STATUS.returning],
  },
  {
    key: 'settled',
    label: 'Settled',
    detail: 'Filled privately.',
    statuses: [],
  },
];

/**
 * Which stage a session status belongs to, or `null` if we do not recognise it.
 *
 * Callers keep their previous stage on `null`. Progress must never run backwards
 * either: statuses can arrive out of order across two operations (a trade then
 * its sweep), and a panel that jumped back to step one mid-flight would look
 * like the bet had restarted.
 */
export function stageIndexFor(status: string): number | null {
  const index = SHIELD_STAGES.findIndex((s) => s.statuses.includes(status));
  return index === -1 ? null : index;
}

export interface ShieldingProgressProps {
  /** Latest session status, or `null` before the first one arrives. */
  status: string | null;
  /** What the user is doing, for the headline. */
  action: string;
  /**
   * The operation finished — fill the veil before the panel is replaced.
   *
   * Without it the animation is cut off wherever it happened to be, which reads as the bet being
   * abandoned rather than completed. The caller holds this true for a beat, then swaps the panel.
   */
  done?: boolean;
}

/**
 * Stages a status can actually put the panel in.
 *
 * `settled` carries no statuses: it is the state the panel is *replaced by*, not one it reports.
 * Counting it in the denominator is what made a finished bet read as three-quarters done — and a
 * buy, which never emits `returning`, stopped at half and then vanished.
 */
const REACHABLE_STAGES = SHIELD_STAGES.filter((stage) => stage.statuses.length > 0).length;

/** How quickly the veil creeps toward the next stage, in seconds. */
const CREEP_SECONDS = 6;

/**
 * Said in full, because "waiting" alone is the reading that produced the bug report.
 *
 * A trader who sees a pause after pressing Trade assumes their money is somewhere in between.
 * It is not: the rejection happens before anything is signed. Both facts have to be on screen,
 * or the sensible response is to press Trade again.
 */

/**
 * How long a healthy operation takes before "still going" needs saying out loud.
 *
 * Around thirty seconds is normal and around sixty is unremarkable. Past that the honest thing is
 * to say so, because the alternative — a panel that has looked identical for four minutes — is
 * what "it's stuck forever" describes. We wait up to seven minutes on purpose: abandoning a
 * UserOperation that is still in flight is the one outcome worse than waiting.
 */
const SLOW_AFTER_SECONDS = 60;

/**
 * How long a finished animation stays up before the panel it lives in is replaced.
 *
 * Long enough to read as completion, short enough that nobody waits on it.
 */
export const SETTLE_BEAT = 700;

/** Seconds since mount, ticking once a second. */
function useElapsed(): number {
  const [seconds, setSeconds] = React.useState(0);
  React.useEffect(() => {
    const id = setInterval(() => setSeconds((s) => s + 1), 1_000);
    return () => clearInterval(id);
  }, []);
  return seconds;
}


export function ShieldingProgress({ status, action, done = false }: ShieldingProgressProps) {
  const elapsed = useElapsed();
  const slow = elapsed >= SLOW_AFTER_SECONDS;
  // Highest stage reached, so a late status from a prior operation cannot walk
  // the panel backwards.
  //
  // Adjusted during render rather than in an effect: this is derived from the
  // status prop, and an effect would commit an extra paint at the old stage
  // before correcting itself — visible as a flicker on every step. Taking a max
  // is idempotent, so re-running it under StrictMode's double render is safe.
  const [reached, setReached] = React.useState(0);
  const [seenStatus, setSeenStatus] = React.useState<string | null>(null);
  const [stageStart, setStageStart] = React.useState(0);

  if (status !== seenStatus) {
    setSeenStatus(status);
    const next = status === null ? null : stageIndexFor(status);
    if (next !== null && next > reached) {
      setReached(next);
      setStageStart(elapsed);
    }
  }

  const current = SHIELD_STAGES[reached];

  /**
   * How far round the loop the wait has drawn.
   *
   * A stage owns a band, and within its band the arc creeps toward the top asymptotically — so it
   * is never quite still even while a stage sits for a minute, and it can never claim a stage that
   * has not happened.
   *
   * Everything is scaled into {@link SETTLED_AT} rather than into a full turn. `done` therefore
   * fills to three quarters, not to the end, and that is not the animation being cut short: the
   * receipt that replaces this panel opens on exactly that offset and shuts the last quarter. A
   * wait that ran to 1 would make the mark jump backwards at the moment of success.
   */
  const band = 1 / REACHABLE_STAGES;
  const base = Math.min(1, reached * band);
  const creep = 1 - Math.exp(-Math.max(0, elapsed - stageStart) / CREEP_SECONDS);
  const progress = (done ? 1 : Math.min(1, base + band * creep)) * SETTLED_AT;

  return (
    <div className="border border-accent-dim bg-accent-wash p-3.5">
      {/*
        The animation, and nothing else.

        This panel used to carry a headline, a running clock, a four-step list with a description
        under the active step, and two closing paragraphs. Every one of them was written to answer
        "is this stuck?", and five answers to one question is what made it feel like a system
        apologising for itself. The arc grows as the stages complete, so it answers that question
        by moving.
      */}
      <Waiting progress={progress} label={action} />

      {/*
        The only announced text, and the only text at all on a healthy run. One live message per
        stage change is what a screen reader can actually use.
      */}
      <p role="status" aria-live="polite" className="sr-only">
        {`${action}. ${current.label}. ${current.detail}`}
      </p>

      {slow && (
        // The one sentence kept, and only once the wait is genuinely long. Silence here is not
        // calm, it is the thing that makes people reload mid-bet or press the button a second
        // time — and a second bet is real money.
        <p className="mt-3 border-l-2 border-line-2 pl-2.5 text-[11.5px] leading-relaxed text-ink-dim">
          Still going, and nothing has been lost. Keep this tab open and do not start another.
        </p>
      )}
    </div>
  );
}
