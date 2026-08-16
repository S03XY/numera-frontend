'use client';

import * as React from 'react';
import Link from 'next/link';
import { cn } from '@/lib/cn';
import { useSession } from '@/lib/auth/useSession';
import { useRelayStatus } from '@/lib/relay/useRelayStatus';
import { ExternalLinkIcon, InfoIcon } from '@/components/ui/icons';
import { MONAD_FAUCET_URL } from '@/lib/chain/collateral';

/**
 * The network, said in one line, with the rest of it one press away.
 *
 * ## Why the line is not enough on its own
 *
 * "Monad testnet · Test funds, no real value" answers the question that matters most and none of
 * the ones that come next. A first-time tester still has to discover, in this order, that a
 * transaction needs MON they do not have, that the collateral comes from a faucet inside the app,
 * and that neither of those is a fault. Before this they discovered it by pressing a button and
 * reading a failure.
 *
 * ## Why it expands here rather than floating
 *
 * A panel pinned to a side of the viewport covers the thing it is explaining. On a market page the
 * right column is the funding panel and the ticket, the left is the chart and the tape, and below
 * `lg` the two stack into one — so there is no side that is not somebody's content. The bottom
 * right corner is worse still: the toast stack lives there, and those toasts report money landing.
 *
 * The strip has none of those problems. It already exists, it is already sticky, it already owns
 * this subject, and it pushes the page down rather than sitting on top of it.
 *
 * ## Why it opens itself, and only until it is answered
 *
 * A notice that is always open is one people learn to look past, which is the failure the strip
 * itself was written to avoid. A notice that never opens is one nobody presses. So it starts open
 * on a browser that has not dismissed it, and the first dismissal of any kind is permanent.
 *
 * Scrolling counts as a dismissal. The header is sticky, so an open panel would otherwise follow
 * the reader down the page holding a third of a phone screen, and somebody who has started
 * scrolling has finished with it.
 */

const STORAGE_KEY = 'numera.testnetNotice';

/**
 * Whether this browser has dismissed the panel already.
 *
 * Both directions are guarded: Safari in private mode throws on `localStorage` rather than
 * answering, and a notice must not be the thing that takes the masthead down. An unreadable flag
 * means the panel opens again, which is the harmless direction to fail in.
 */
const dismissed = {
  read(): boolean {
    try {
      return window.localStorage?.getItem(STORAGE_KEY) === 'seen';
    } catch {
      return false;
    }
  },
  write(): void {
    try {
      window.localStorage?.setItem(STORAGE_KEY, 'seen');
    } catch {
      // Nothing to do. The panel is still dismissible for this visit.
    }
  },
};

/** How far the page has to move before an open panel takes it as "moved on". */
const SCROLL_SLACK = 24;

/** A store that never changes, read for one bit: has this rendered on a browser yet? */
const NEVER = () => () => {};

export function TestnetNotice() {
  const { status } = useSession();
  /*
    The one thing here that is not a standing fact about the network.

    Numera pays the network fee on every bet, so when the relayer stops, betting stops for
    everybody at once — and before this the only way to find that out was to sign a bet and read
    the failure. It belongs in the strip because the strip is the one line already on every page
    and already about the state of the chain underneath.

    A state, never a figure: see `lib/relay/useRelayStatus`. What is deliberately absent is the
    relayer's balance, which nobody reading this could act on and which, published beside a daily
    cap, would tell whoever is draining us how close they are.
  */
  const relay = useRelayStatus();
  const paused = !relay.available;
  /*
    What the reader has decided, or `null` while they have not decided anything.

    Split from "is it open" on purpose, so the resting state can be *derived* rather than pushed
    into state by an effect. Reading `localStorage` during render would be a lie on the server,
    where there is none — hence `hydrated`, which `useSyncExternalStore` answers `false` for on the
    server and during hydration, and `true` on every render after. The first paint therefore
    matches the markup it is hydrating, and the panel opens a beat later, once asking the browser
    is a legitimate thing to do.
  */
  const hydrated = React.useSyncExternalStore(
    NEVER,
    () => true,
    () => false,
  );
  const [choice, setChoice] = React.useState<boolean | null>(null);
  const open = choice ?? (hydrated && !dismissed.read());
  const panelId = React.useId();

  /*
    Every close is a dismissal, and dismissal is permanent.

    Recorded here rather than on the auto-open, which would spend the one showing on somebody who
    had not looked at it yet. A reader who neither presses nor scrolls before moving on sees it
    once more on the next page, which is the right way round for a notice this cheap to shut.
  */
  const decide = React.useCallback((next: boolean) => {
    if (!next) dismissed.write();
    setChoice(next);
  }, []);

  /*
    The two ways out that are not the button: Escape, as everywhere else in the house, and any
    real scroll. The scroll baseline is captured at open time rather than compared against the top
    of the document, because this can be opened from halfway down a market page — measured from
    zero it would close itself in the same frame it opened.
  */
  React.useEffect(() => {
    if (!open) return;
    const from = window.scrollY;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') decide(false);
    };
    const onScroll = () => {
      if (Math.abs(window.scrollY - from) > SCROLL_SLACK) decide(false);
    };
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScroll);
    };
  }, [open, decide]);

  return (
    <div className="border-b border-line bg-bg-2">
      {/*
        The whole line is the control, not just the glyph.

        `Explain` can hang its ⓘ off the end of a heading because a heading is wide and a section
        is calm. This line is 34 characters centred in the full width of the page, and a 14px
        target at the end of it is the hardest thing on the screen to hit with a thumb. So the row
        takes the press, and the ⓘ stays as the thing that says a press is possible.

        The button is the full-bleed element with the shell inside it, rather than the other way
        round, so the hover wash reaches the edges of the strip instead of stopping short in the
        gutters.
      */}
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => decide(!open)}
        className="group block w-full cursor-pointer transition-colors hover:bg-bg-3"
      >
        <span className="shell flex items-center justify-center gap-2 py-1.5">
          {/* The mark carries the state, so the line reads as different at a glance rather than
              only on being read. Neg rather than a third colour: this house has one accent and one
              alarm, and a paused book is the alarm. */}
          <span
            aria-hidden="true"
            className={cn('size-1.5 shrink-0', paused ? 'bg-neg' : 'bg-accent-bright')}
          />
          {/* Centred rather than left aligned, because at 320px the line wraps and a left aligned
              second line reads as a ragged fragment hanging off the mark. */}
          <span className={cn('folio text-center', paused && '!text-ink')}>
            {paused ? 'Monad testnet · Betting is paused' : 'Monad testnet · Test funds, no real value'}
          </span>
          <InfoIcon
            className={cn(
              'size-3.5 shrink-0 transition-colors',
              open ? 'text-accent-bright' : 'text-ink-mute group-hover:text-ink',
            )}
          />
        </span>
      </button>

      {open && (
        <div id={panelId} className="shell pt-0.5 pb-3.5">
          {/*
            Three cells, in the order a tester meets them: what the money is, what a transaction
            costs, what to trade with. Hairline separators and no fill of their own — the same
            grid the connect panel and the quick-amount row are drawn with, so an expanded header
            reads as part of the house rather than as an announcement bolted to the top of it.
          */}
          <div
            className={cn(
              'settle-in grid gap-px border border-line bg-line',
              paused ? 'sm:grid-cols-2' : 'sm:grid-cols-3',
            )}
          >
            {/*
              First, and it displaces the rest into two columns rather than squeezing into a
              fourth. When betting is off, nothing else in this panel is what the reader opened it
              for.
            */}
            {paused && (
              <Note label="Betting is paused" tone="neg">
                {relay.reason === 'capped'
                  ? 'Numera pays the network fee on every bet, and today’s budget is spent. Betting opens again tomorrow. Nothing has been taken from anybody’s balance and positions are unaffected.'
                  : 'Sponsored betting is not configured on this deployment, so no bets can be placed. Funds already in the pool are untouched.'}
              </Note>
            )}
            <Note label="Test funds">
              Every bet is a real transaction, settled by the same contracts as the live market.
              Only the tokens are not real, so nothing here is won or lost.
            </Note>
            <Note label="Gas">
              A transaction costs a little MON, and a new account holds none. Claim it once, for
              the public address shown on your Wallet.
              <Away href={MONAD_FAUCET_URL}>Monad faucet</Away>
            </Note>
            <Note label="Collateral">
              {status === 'authenticated' ? (
                <>
                  Claim test collateral in your Wallet and deposit it. Every market you fund is
                  topped up from that balance.
                  <Home href="/wallet">Get test collateral</Home>
                </>
              ) : (
                <>
                  Sign in with a passkey or MetaMask, then claim test collateral in your Wallet.
                  Signing takes no gas.
                </>
              )}
            </Note>
          </div>
        </div>
      )}
    </div>
  );
}

/** One cell: a label in the folio hand, then the sentence it introduces. */
function Note({
  label,
  tone,
  children,
}: {
  label: string;
  tone?: 'neg';
  children: React.ReactNode;
}) {
  return (
    <div className="bg-bg px-3.5 py-3">
      <p className={cn('folio', tone === 'neg' && '!text-neg')}>{label}</p>
      <p className="mt-1.5 text-[11.5px] leading-relaxed text-ink-dim">{children}</p>
    </div>
  );
}

/** A link that leaves the app. Its own line, so the sentence above it stays readable. */
function Away({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      className="mt-1.5 inline-flex items-center gap-1.5 text-accent-bright underline underline-offset-2 transition-colors hover:text-ink"
    >
      {children}
      <ExternalLinkIcon />
    </a>
  );
}

/** The same, for somewhere inside the app. */
function Home({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="mt-1.5 block text-accent-bright underline underline-offset-2 transition-colors hover:text-ink"
    >
      {children}
    </Link>
  );
}
