'use client';

import * as React from 'react';
import Image from 'next/image';
import { Button } from '@/components/ui/Button';
import { ArrowIcon, SealGlyph } from '@/components/ui/icons';
import { useSession } from '@/lib/auth/useSession';
import { useInjectedWallets } from '@/lib/wallet/useInjectedWallets';
import { prfCapability } from '@/lib/wallet/mera';
import type { InjectedWallet } from '@/lib/wallet/injected';

/**
 * The door to the house.
 *
 * Signing in proves control of a key — it never reveals what you trade. The
 * panel says so explicitly, because a wallet connect flow is exactly where a
 * user forms their mental model of what the product can see.
 *
 * Two ways in, offered as equals rather than as a default and a fallback:
 *
 *  - a **passkey**, for people who do not have a wallet and should not have to
 *    acquire one to place a bet;
 *  - a **wallet they already own**, for people who do — and who reasonably
 *    prefer a key they already trust, possibly one backed by hardware.
 *
 * Both produce the same thing: an EOA that signs SIWE and, later, derives the
 * shielded identity. Nothing downstream cares which was used.
 */

type Step = 'choose' | 'passkey' | 'wallet';

export function ConnectButton() {
  const {
    status,
    user,
    error,
    errorCode,
    busy,
    walletAccount,
    walletSwitched,
    walletSession,
    signUpWithPasskey,
    signInWithPasskey,
    useSwitchedAccount,
    chooseAccount,
    signOut,
  } = useSession();
  const [open, setOpen] = React.useState(false);
  const [step, setStep] = React.useState<Step>('choose');
  /*
    Which passkey button was pressed last.

    Both can fail with `PRF_UNAVAILABLE` and only one of them has a retry. Offering "use a phone"
    to somebody who pressed "I already have one" would create a second account rather than open
    the one they came back for, and it would look like the recovery they were promised.
  */
  const [tried, setTried] = React.useState<'create' | 'connect' | null>(null);
  const rootRef = React.useRef<HTMLDivElement>(null);
  // Probed only once the passkey step is open, so a header nobody has clicked does not query the
  // WebAuthn API on every page load.
  const noPrf = usePrfSupport(open && step === 'passkey') === false;

  // Close on outside click and on Escape — a panel that traps the user is worse
  // than no panel at all.
  React.useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  function close() {
    setOpen(false);
    // Reset to the fork, so reopening never drops the user mid-flow in a branch
    // they have forgotten choosing.
    setStep('choose');
    setTried(null);
  }

  async function run(action: () => Promise<void>) {
    try {
      await action();
      close();
    } catch {
      // useSession surfaces the message; a cancelled prompt is not an error.
    }
  }

  if (status === 'loading') {
    return <div className="h-9 w-24 border border-line" aria-hidden="true" />;
  }

  if (status === 'authenticated' && user) {
    return (
      <div ref={rootRef} className="relative">
        <Button
          variant="ghost"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          // Said on the chip itself, not only inside a panel nobody has opened. This is the one
          // piece of header state that can make every later action derive the wrong identity, so
          // it has to be visible without a click.
          className={walletSwitched ? '!border-warn !text-warn' : undefined}
        >
          {walletSwitched ? (
            <span className="size-2.5 shrink-0 bg-warn" aria-hidden="true" />
          ) : (
            <SealGlyph className="size-2.5 text-accent-bright" />
          )}
          {short(user.address)}
        </Button>
        {open && (
          <Panel>
            {walletSwitched && walletAccount ? (
              <SwitchedAccount
                signedIn={user.address}
                selected={walletAccount}
                busy={busy}
                onUse={() => run(useSwitchedAccount)}
              />
            ) : (
              <p className="text-[12px] leading-relaxed text-ink-dim">
                This key identifies you to Numera. It is never attached to a bet — your positions
                live in separate shielded accounts that we cannot link back to it.
              </p>
            )}
            {/*
              The way to a different account that is not signing out.

              Without this the only route was sign out, reopen, pick MetaMask, sign, and that is
              the wrong shape for what the person wants: they are not leaving, they are looking at
              a different account. Offered only to a wallet session, because a passkey has one
              account by construction and there is nothing to pick.

              It does not switch anything by itself. It asks the extension to re-offer its
              accounts; whatever comes back arrives as an `accountsChanged`, and the panel above
              turns it into an offer they can accept or ignore.

              Gated on the session being a wallet one, NOT on an account having been read back.
              Those differ in the state that matters most: a user who disconnects this site inside
              MetaMask reports no account at all, and reopening the picker is their only way back.
              Keyed off the address, the button would disappear exactly when it is needed.
            */}
            {walletSession && (
              <Button
                variant="ghost"
                className="mt-3 w-full"
                disabled={busy}
                onClick={() => void chooseAccount()}
              >
                {busy ? 'Waiting…' : 'Use a different account'}
              </Button>
            )}
            {/* Held while a wallet dialog is open, like everything else in this panel. Signing
                out from under an unanswered prompt tears down the session the prompt was for. */}
            <Button
              variant="ghost"
              className="mt-2 w-full"
              disabled={busy}
              onClick={() => run(signOut)}
            >
              Sign out
            </Button>
            {error && (
              <p role="alert" className="mt-2 text-[11px] leading-relaxed text-neg">
                {error}
              </p>
            )}
          </Panel>
        )}
      </div>
    );
  }

  return (
    <div ref={rootRef} className="relative">
      <Button variant="primary" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        Enter
        <ArrowIcon className="size-3" />
      </Button>

      {open && (
        <Panel>
          {step === 'choose' && <ChooseStep onPick={setStep} />}

          {step === 'passkey' && (
            <Step title="Passkey" onBack={() => setStep('choose')}>
              <p className="mt-2 text-[12px] leading-relaxed text-ink-dim">
                One passkey, no seed phrase, same account on every device. Signing proves you hold
                the key — it reveals nothing about what you trade.
              </p>
              <PrfWarning blocked={noPrf} />
              <Button
                variant="primary"
                className="mt-3 w-full"
                disabled={busy || noPrf}
                onClick={() => {
                  setTried('create');
                  void run(() => signUpWithPasskey());
                }}
              >
                {busy ? 'Waiting…' : 'Create account'}
              </Button>
              {/* Held for the same reason as creating. Signing in derives the account key from the
                  same PRF output, so a browser that cannot produce one cannot open an existing
                  account either, and leaving this live only buys a ceremony that fails at the end
                  of it. */}
              <Button
                variant="ghost"
                className="mt-2 w-full"
                disabled={busy || noPrf}
                onClick={() => {
                  setTried('connect');
                  void run(signInWithPasskey);
                }}
              >
                I already have one
              </Button>
              {!noPrf && (
                <>
                  {/* Said up front, because the second prompt is the surprising part. Most stores
                      answer during creation and there is only one; the ones that answer only when
                      unlocking produce two, seconds apart, and that reads as a stuck dialog. */}
                  <p className="mt-2.5 text-[11px] leading-relaxed text-ink-mute">
                    Your device may ask twice, once to save the passkey and once to unlock it.
                  </p>
                  <StoreHint />
                </>
              )}
            </Step>
          )}

          {step === 'wallet' && (
            <Step title="Your wallet" onBack={() => setStep('choose')}>
              <WalletList run={run} busy={busy} />
            </Step>
          )}

          {error && (
            <div className="mt-2">
              <p role="alert" className="text-[11px] leading-relaxed text-neg">
                {error}
              </p>
              {/*
                The one failure with a move left in it, said rather than offered as a button.

                Where a passkey is saved is the variable, and the browser's own dialog is where it
                is chosen, so this points at that moment instead of adding a third choice to a
                panel whose job is to present two.

                Shown only after "Create account", since it is advice about saving. See `tried`.
              */}
              {step === 'passkey' && tried === 'create' && errorCode === 'PRF_UNAVAILABLE' && (
                <p className="mt-2 text-[11px] leading-relaxed text-ink-mute">
                  A phone or a security key derives keys where that store cannot. Choose one when
                  your browser asks where to save the passkey.
                </p>
              )}
            </div>
          )}
        </Panel>
      )}
    </div>
  );
}

function short(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/**
 * The wallet has moved and the session has not.
 *
 * Offered as a choice rather than performed automatically, and the reason is money: the address is
 * not a label on this session, it is the seed of a separate shielded balance. Following the
 * extension silently would show somebody a different balance than the one they funded, with no
 * error anywhere, because both are perfectly valid accounts.
 *
 * So it says which is which, in full, and gives one button. The alternative it replaces was sign
 * out, reopen this panel, choose MetaMask, sign — four steps to express something the browser
 * already knew.
 */
function SwitchedAccount({
  signedIn,
  selected,
  busy,
  onUse,
}: {
  signedIn: string;
  selected: string;
  busy: boolean;
  onUse: () => void;
}) {
  return (
    <div role="alert">
      <p className="kicker !text-[10px] text-warn">Your wallet switched accounts</p>
      <dl className="mt-2.5 space-y-1.5 text-[12px]">
        <div className="flex items-baseline justify-between gap-3">
          <dt className="text-ink-mute">Signed in as</dt>
          <dd className="mono text-ink">{short(signedIn)}</dd>
        </div>
        <div className="flex items-baseline justify-between gap-3">
          <dt className="text-ink-mute">Wallet is on</dt>
          <dd className="mono text-warn">{short(selected)}</dd>
        </div>
      </dl>
      <p className="mt-2.5 text-[11.5px] leading-relaxed text-ink-dim">
        Each account has its own private balance, so these are two separate sets of funds. Switch
        back in MetaMask to keep this one, or continue as the new account.
      </p>
      <Button variant="primary" className="mt-3 w-full" disabled={busy} onClick={onUse}>
        {busy ? 'Waiting…' : `Continue as ${short(selected)}`}
      </Button>
    </div>
  );
}

/**
 * Ask the browser before letting anyone start.
 *
 * A store without PRF creates the credential perfectly happily. The failure surfaces only once we
 * ask for key material, by which point the person is holding a passkey that can never sign in and
 * is saved in their password manager forever. Asking first costs one call and prevents that.
 *
 * ## Why this gate is sound while refusing on `prf.enabled` was not
 *
 * They look like the same mistake and are opposites. `prf.enabled` is reported *by* the ceremony
 * about one credential, and stores that answer false there routinely return a usable key when
 * actually asked, which is why signup asks rather than predicts. `getClientCapabilities()` is the
 * browser describing its own implementation, and a browser with no PRF has nothing for any store
 * to route to.
 *
 * It is narrow, and the narrowness is the point. It reports the **browser**, never the store:
 * Brave answers `extension:prf: true` and still fails through a password manager that cannot
 * derive keys. So this catches one failure completely and is silent about the more common one,
 * which the ceremony itself still has to discover.
 *
 * `null` never blocks. Most browsers cannot answer this at all, and treating "cannot tell" as
 * "no" would lock out nearly everyone to spare a few a wasted credential.
 */
function usePrfSupport(active: boolean): boolean | null {
  const [supported, setSupported] = React.useState<boolean | null>(null);

  React.useEffect(() => {
    if (!active) return;
    let cancelled = false;
    void prfCapability().then((result) => {
      if (!cancelled) setSupported(result);
    });
    return () => {
      cancelled = true;
    };
  }, [active]);

  return supported;
}

function PrfWarning({ blocked }: { blocked: boolean }) {
  if (!blocked) return null;

  return (
    <p
      role="alert"
      className="mt-2 border border-neg px-2.5 py-2 text-[11px] leading-relaxed text-neg"
    >
      This browser cannot derive an account key from a passkey, so one created here could never
      sign in. Use a recent Chrome, Safari, Firefox or Edge, or sign in with MetaMask.
    </p>
  );
}

/**
 * Where to save it, said before the ceremony rather than after it fails.
 *
 * The check above almost never fires, and now we know why it cannot be relied on:
 * `getClientCapabilities()` describes the BROWSER, and PRF support is a property of the *store*
 * the browser hands the credential to. Chrome reports `extension:prf: true` and then saves the
 * passkey to its own profile, which has no `hmac-secret` and cannot derive anything. There is no
 * API that predicts that, and no `hints` value that steers between two platform providers.
 *
 * So the one useful moment is the half-second before the browser's dialog opens, while the person
 * still has the choice in front of them. Two lines, and it turns the most common failure in this
 * product into a non-event.
 */
function StoreHint() {
  return (
    <p className="mt-3 border-t border-line pt-2.5 text-[11px] leading-relaxed text-ink-mute">
      When your browser asks where to save it, <strong className="text-ink-dim">iCloud
      Keychain</strong>, <strong className="text-ink-dim">Google Password Manager</strong>,{' '}
      <strong className="text-ink-dim">Windows Hello</strong> and{' '}
      <strong className="text-ink-dim">1Password</strong> all work.
    </p>
  );
}

/** The fork. Neither option is styled as the recommended one — both are real choices. */
function ChooseStep({ onPick }: { onPick: (step: Step) => void }) {
  return (
    <>
      <p className="kicker !text-[10px]">Choose how to sign in</p>
      <div className="mt-3 grid gap-px bg-line">
        <Choice
          title="Use a passkey"
          detail="Face ID or a security key. No seed phrase, no extension, works on every device."
          onClick={() => onPick('passkey')}
        />
        <Choice
          title="Use MetaMask"
          detail="The browser wallet you already have. Signing costs no gas."
          onClick={() => onPick('wallet')}
        />
      </div>
      <p className="mt-3 text-[11px] leading-relaxed text-ink-mute">
        Either way, the key you sign in with is never attached to a bet.
      </p>
    </>
  );
}

function Choice({
  title,
  detail,
  onClick,
}: {
  title: string;
  detail: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group bg-bg px-3 py-3 text-left transition-colors hover:bg-bg-2"
    >
      <span className="flex items-center justify-between gap-2">
        <span className="text-[13px] text-ink">{title}</span>
        <ArrowIcon className="size-3 text-ink-mute transition-colors group-hover:text-accent-bright" />
      </span>
      <span className="mt-1 block text-[11px] leading-relaxed text-ink-mute">{detail}</span>
    </button>
  );
}

function Step({
  title,
  onBack,
  children,
}: {
  title: string;
  onBack: () => void;
  children: React.ReactNode;
}) {
  return (
    <>
      <div className="flex items-center justify-between">
        <p className="kicker !text-[10px]">{title}</p>
        <button
          type="button"
          onClick={onBack}
          className="text-[11px] text-ink-mute transition-colors hover:text-ink"
        >
          Back
        </button>
      </div>
      {children}
    </>
  );
}

/**
 * MetaMask, if this browser has it.
 *
 * Still read from EIP-6963 announcements rather than `window.ethereum`: with several extensions
 * installed they fight over that global and whoever loaded last wins, so the announcement is the
 * only way to be sure the provider we connect is the wallet we named. `injected.ts` filters the
 * announcements down to MetaMask; this renders whatever survives, so it stays a list and adding a
 * second supported wallet later is a one-line change there rather than a rewrite here.
 */
function WalletList({
  run,
  busy,
}: {
  run: (action: () => Promise<void>) => Promise<void>;
  busy: boolean;
}) {
  const { signInWithInjected } = useSession();
  const { wallets, searching } = useInjectedWallets();

  if (wallets.length === 0) {
    return (
      <p className="mt-2 text-[12px] leading-relaxed text-ink-dim">
        {searching
          ? 'Looking for MetaMask…'
          : 'MetaMask was not found. Install it and reopen this panel — or use a passkey instead, which needs no extension at all.'}
      </p>
    );
  }

  return (
    <>
      {/* Two dialogs now, so say two. The account step is the fix for people who switched in
          MetaMask and found this page still showing the old one, and being surprised by an extra
          prompt is how a fix reads as a fault. */}
      <p className="mt-2 text-[12px] leading-relaxed text-ink-dim">
        MetaMask will ask which account to share, then ask you to sign one message. It costs no gas
        and moves no funds.
      </p>
      <div className="mt-3 grid gap-px bg-line">
        {wallets.map((wallet) => (
          <button
            key={wallet.rdns}
            type="button"
            disabled={busy}
            onClick={() => void run(() => signInWithInjected(wallet))}
            className="flex items-center gap-2.5 bg-bg px-3 py-2.5 text-left transition-colors hover:bg-bg-2 disabled:opacity-50"
          >
            <WalletIcon wallet={wallet} />
            <span className="text-[13px] text-ink">{wallet.name}</span>
          </button>
        ))}
      </div>
      {/* The load bearing sentence of the whole panel. An account here is not a label on a
          session: it seeds the shielded identity and every market account under it, so choosing a
          different one opens a different set of funds. The last line is the part that stops
          somebody panicking when their balance reads zero. */}
      <p className="mt-3 text-[11px] leading-relaxed text-ink-mute">
        The account you choose decides which private balance opens. Choosing a different one opens
        a different balance, and nothing is lost. Sign in again with the first account to see it.
      </p>
      <p className="mt-2 text-[11px] leading-relaxed text-ink-mute">
        Use a regular wallet account. Smart-contract wallets cannot derive a shielded balance yet.
      </p>
    </>
  );
}

function WalletIcon({ wallet }: { wallet: InjectedWallet }) {
  // EIP-6963 requires a data URI, so this never reaches the network. A wallet
  // that ignores the spec gets a neutral placeholder rather than a broken image.
  if (!wallet.icon.startsWith('data:')) {
    return <span aria-hidden="true" className="size-4 shrink-0 bg-line" />;
  }
  return (
    <Image
      src={wallet.icon}
      alt=""
      width={16}
      height={16}
      unoptimized
      className="size-4 shrink-0"
    />
  );
}

function Panel({ children }: { children: React.ReactNode }) {
  return (
    // Capped to the viewport, because 290px anchored to the right edge of a header button is
    // wider than the space left beside it on a 320px phone — and the half that overflowed was
    // the left half, where the wallet names and the explanation are.
    <div className="absolute right-0 top-[calc(100%+8px)] z-50 w-[290px] max-w-[calc(100vw-2rem)] border border-line-2 bg-bg-2 p-4 shadow-[0_30px_70px_-40px_rgba(0,0,0,0.9)]">
      {children}
    </div>
  );
}
