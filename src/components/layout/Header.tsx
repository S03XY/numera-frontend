'use client';

import Image from 'next/image';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/cn';
import { ThemeToggle } from '@/components/ui/ThemeToggle';
import { useQuery } from '@tanstack/react-query';
import { useSession } from '@/lib/auth/useSession';
import { endpoints } from '@/lib/api/endpoints';
import { ConnectButton } from '@/components/auth/ConnectButton';
import { TestnetNotice } from './TestnetNotice';

/**
 * No Portfolio entry.
 *
 * There is no cross-market portfolio in this product, by decision rather than omission: a screen
 * that gathers every bet a person has made into one list is the one view a private marketplace
 * should not build, however well the addresses behind it are shielded. A position lives on the
 * page of the market it belongs to, next to the ticket that opened it, and is settled there.
 */
const NAV = [{ href: '/', label: 'Markets' }];

/**
 * The Wallet, offered only once there is one to open.
 *
 * Everything on that screen belongs to a key: the shielded balance, the address that holds it, the
 * deposit that fills it. A visitor who has not signed in holds none of them, so the link used to
 * lead to a screen whose only control was "Unlock private trading" — an offer to unlock a session
 * that did not exist, and one that fails at the wallet prompt rather than saying what is missing.
 *
 * A passkey and MetaMask both end at the same place, an authenticated session, so this needs no
 * further distinction between them: either one makes the tab appear.
 */
const WALLET = { href: '/wallet', label: 'Wallet' };

export function Header() {
  const pathname = usePathname();
  const { status } = useSession();

  // Operator nav appears only for wallets that actually hold an on-chain role.
  // Purely cosmetic — every admin route re-checks the role server-side, so
  // hiding the link is convenience, not access control.
  const { data: adminRoles } = useQuery({
    queryKey: ['admin', 'me'],
    queryFn: ({ signal }) => endpoints.admin.me(signal),
    enabled: status === 'authenticated',
    retry: false,
    staleTime: 5 * 60_000,
  });

  // `loading` shows nothing rather than guessing. A returning session is restored from a refresh
  // token one request later, and a Wallet tab that appears, vanishes and comes back is worse than
  // one that arrives a moment late — the same reason `ConnectButton` holds a blank chip until it
  // knows who it is talking to.
  const nav = [
    ...NAV,
    ...(status === 'authenticated' ? [WALLET] : []),
    ...(adminRoles?.isOperator ? [{ href: '/admin', label: 'Operations' }] : []),
  ];

  return (
    <header className="sticky top-0 z-50 border-b border-line bg-bg/85 backdrop-blur-xl">
      {/*
        The network, said once and on every page.

        Inside the sticky header rather than above it, so it does not scroll away. What it carries
        is not an announcement to read once and dismiss: it is the reason a balance on screen is
        not money, and that stays true on the screen where somebody is about to place a bet.

        One line at footer weight. A banner that competes with the market list is a banner people
        learn to look past, and this one has to still be legible on the day it matters. What it
        does not say out loud — the faucets, the gas, why a first transaction fails without them —
        is a press away inside it. See `TestnetNotice`.
      */}
      <TestnetNotice />
      {/*
        Grid, not flex, so the nav can sit BESIDE the logo on a laptop and BELOW
        it on a phone without being rendered twice. It used to be `hidden sm:flex`
        with nothing in its place, which left a phone user able to sign in and
        then unable to reach the Wallet at all. One nav element keeps a
        single "Main" landmark and needs no open/closed menu state.
      */}
      <div className="shell grid grid-cols-[auto_1fr] items-center gap-x-6 gap-y-1 py-3 sm:h-16 sm:grid-cols-[auto_auto_1fr] sm:gap-y-0 sm:py-0">
        <Link
          href="/"
          className="group col-start-1 row-start-1 flex shrink-0 items-center gap-2.5"
          aria-label="Numera — home"
        >
          {/*
            The brand mark, shared with the landing page rather than redrawn as an inline glyph —
            two hand-maintained versions of a logo drift, and the one people arrive having just
            seen is the one that has to match. `priority` because it is above the fold on every
            route and a masthead that pops in a beat late reads as a page still loading.
          */}
          <Image
            src="/logo.png"
            alt=""
            width={22}
            height={18}
            priority
            className="h-[18px] w-auto"
          />
          <span className="display text-[17px] font-medium tracking-[-0.01em]">Numera</span>
        </Link>

        <div className="col-start-2 row-start-1 ml-auto flex items-center gap-2 sm:col-start-3">
          <ThemeToggle />
          <ConnectButton />
        </div>

        <nav
          aria-label="Main"
          className="col-span-2 col-start-1 row-start-2 -mx-1 flex items-center gap-1 overflow-x-auto sm:col-span-1 sm:col-start-2 sm:row-start-1 sm:mx-0 sm:overflow-x-visible"
        >
          {nav.map((item) => {
            const active = item.href === '/' ? pathname === '/' : pathname.startsWith(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  // The whole nav on a phone is two or three of these, and they are the only way
                  // to reach the Wallet — so they get a thumb-sized row rather than the compact
                  // 24px line the desktop masthead wants.
                  'shrink-0 px-3 py-2.5 text-[13px] transition-colors sm:py-1.5',
                  active ? 'text-ink' : 'text-ink-mute hover:text-ink',
                )}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>
      </div>
    </header>
  );
}

export function Footer() {
  return (
    <footer className="mt-24 border-t border-line">
      <div className="shell flex flex-col gap-3 py-7 sm:flex-row sm:items-center sm:justify-between">
        <span className="folio">© Numera · {new Date().getFullYear()}</span>
        <span className="folio">Prices are public · Traders are not</span>
      </div>
    </footer>
  );
}
