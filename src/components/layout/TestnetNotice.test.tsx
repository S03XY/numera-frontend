import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/test/render';
import { TestnetNotice } from './TestnetNotice';

/**
 * The strip that explains the testnet, and the rules about when it is allowed to take up room.
 *
 * Most of these are about restraint rather than content: a notice inside a sticky header can hold
 * a third of a phone screen, so every path that leaves it open is a path worth a test.
 */

const session = { status: 'anonymous' as string };

vi.mock('@/lib/auth/useSession', () => ({
  useSession: () => session,
  SessionProvider: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock('@/lib/api/endpoints', () => ({
  // `PoolProvider` is real in the shared render tree and asks for this on mount.
  endpoints: { unlink: { environment: vi.fn(async () => ({ enabled: false })) } },
}));

/** Whether sponsored gas is up. Stubbed so the strip's two states can be driven directly. */
const relay = { available: true, reason: null as string | null, resolution: true, unknown: false };
vi.mock('@/lib/relay/useRelayStatus', () => ({ useRelayStatus: () => relay }));

const STORAGE_KEY = 'numera.testnetNotice';

function strip() {
  return screen.getByRole('button', { name: /monad testnet/i });
}

/** A label only the expanded panel carries. Anchored on the structure, not on the prose. */
function panelBody() {
  return screen.queryByText('Collateral');
}

/** jsdom never scrolls, so the position is stated and the event is fired by hand. */
function scrollTo(y: number) {
  Object.defineProperty(window, 'scrollY', { value: y, configurable: true, writable: true });
  fireEvent.scroll(window);
}

beforeEach(() => {
  session.status = 'anonymous';
  relay.available = true;
  relay.reason = null;
  scrollTo(0);
});

describe('TestnetNotice — when it shows itself', () => {
  it('opens on a browser that has not dismissed it (positive)', () => {
    renderWithProviders(<TestnetNotice />);

    expect(strip()).toHaveAttribute('aria-expanded', 'true');
    expect(panelBody()).toBeInTheDocument();
  });

  it('spends the showing on a reader, not on a page load (negative)', () => {
    // Recorded on dismissal rather than on the auto-open, which would spend the one showing on
    // somebody who had not looked at it yet.
    renderWithProviders(<TestnetNotice />);

    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('stays out of the way once it has been dismissed (negative)', () => {
    window.localStorage.setItem(STORAGE_KEY, 'seen');

    renderWithProviders(<TestnetNotice />);

    expect(strip()).toHaveAttribute('aria-expanded', 'false');
    expect(panelBody()).not.toBeInTheDocument();
  });

  it.each([
    ['pressed shut', async () => userEvent.click(strip())],
    ['dismissed with Escape', async () => userEvent.keyboard('{Escape}')],
    ['left behind by a scroll', async () => scrollTo(200)],
  ])('records the dismissal when it is %s (positive)', async (_case, dismiss) => {
    renderWithProviders(<TestnetNotice />);
    expect(panelBody()).toBeInTheDocument();

    await dismiss();

    expect(panelBody()).not.toBeInTheDocument();
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe('seen');
  });

  it('survives a browser that refuses storage (negative)', () => {
    // Safari in private mode throws rather than answering. The notice must not be the thing that
    // takes the masthead down with it.
    const getItem = vi
      .spyOn(Storage.prototype, 'getItem')
      .mockImplementation(() => {
        throw new Error('denied');
      });
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied');
    });

    expect(() => renderWithProviders(<TestnetNotice />)).not.toThrow();
    expect(strip()).toHaveAttribute('aria-expanded', 'true');

    getItem.mockRestore();
    setItem.mockRestore();
  });
});

describe('TestnetNotice — the ways in and out', () => {
  beforeEach(() => {
    // Start from the resting state for these: the auto-open is covered above.
    window.localStorage.setItem(STORAGE_KEY, 'seen');
  });

  it('opens and closes on the line itself, not only on the glyph (positive)', async () => {
    // 34 characters centred in the full width of the page, and the ⓘ at the end of it is the
    // hardest thing on the screen to hit with a thumb. The row takes the press.
    renderWithProviders(<TestnetNotice />);

    await userEvent.click(strip());
    expect(panelBody()).toBeInTheDocument();

    await userEvent.click(strip());
    expect(panelBody()).not.toBeInTheDocument();
  });

  it('closes on Escape, like every other panel in the house (positive)', async () => {
    renderWithProviders(<TestnetNotice />);
    await userEvent.click(strip());

    await userEvent.keyboard('{Escape}');

    expect(panelBody()).not.toBeInTheDocument();
  });

  it('closes once the reader starts scrolling (REGRESSION-guard)', async () => {
    // The header is sticky. An open panel would otherwise follow the reader down the page holding
    // a third of a phone screen.
    renderWithProviders(<TestnetNotice />);
    await userEvent.click(strip());

    scrollTo(200);

    expect(panelBody()).not.toBeInTheDocument();
  });

  it('ignores a jitter of a few pixels (negative)', async () => {
    renderWithProviders(<TestnetNotice />);
    await userEvent.click(strip());

    scrollTo(8);

    expect(panelBody()).toBeInTheDocument();
  });

  it('measures the scroll from where it was opened, not from the top (REGRESSION)', async () => {
    // It can be opened from halfway down a market page. Compared against zero it would close
    // itself in the same frame it opened, and the press would look broken.
    scrollTo(1200);
    renderWithProviders(<TestnetNotice />);

    await userEvent.click(strip());

    expect(panelBody()).toBeInTheDocument();
  });
});

describe('TestnetNotice — what it says', () => {
  beforeEach(() => {
    window.localStorage.setItem(STORAGE_KEY, 'seen');
  });

  it('sends a signed-in tester to the collateral faucet (positive)', async () => {
    session.status = 'authenticated';
    renderWithProviders(<TestnetNotice />);
    await userEvent.click(strip());

    expect(screen.getByRole('link', { name: /get test collateral/i })).toHaveAttribute(
      'href',
      '/wallet',
    );
  });

  it('names the sign-in first for a visitor, and links nowhere (negative)', async () => {
    // The Wallet is not reachable while anonymous, so pointing at it would be a dead end.
    renderWithProviders(<TestnetNotice />);
    await userEvent.click(strip());

    expect(screen.queryByRole('link', { name: /get test collateral/i })).not.toBeInTheDocument();
    expect(screen.getByText(/sign in with a passkey or metamask/i)).toBeInTheDocument();
  });

  it('points at the gas faucet, away from the app (positive)', async () => {
    renderWithProviders(<TestnetNotice />);
    await userEvent.click(strip());

    const faucet = screen.getByRole('link', { name: /monad faucet/i });
    expect(faucet).toHaveAttribute('href', 'https://faucet.monad.xyz');
    expect(faucet).toHaveAttribute('target', '_blank');
    expect(faucet).toHaveAttribute('rel', expect.stringContaining('noopener'));
  });

  it('keeps the claim itself on the surface, open or shut (PRIVACY-adjacent)', () => {
    // The one sentence that must never be behind a press: it is the reason a balance on screen is
    // not money, and it has to be true on the page where somebody places a bet.
    renderWithProviders(<TestnetNotice />);

    expect(screen.getByText(/test funds, no real value/i)).toBeInTheDocument();
  });
});

/**
 * The one line on every page, carrying the one fact that changes hour to hour.
 *
 * Numera pays the network fee on every bet, so when the relayer stops, betting stops everywhere at
 * once. The strip says so; it never says how much gas is left, which nobody reading it could act
 * on and which, published beside a daily cap, would tell whoever is draining us how close they are.
 */
describe('TestnetNotice — when betting is paused', () => {
  beforeEach(() => {
    window.localStorage.setItem(STORAGE_KEY, 'seen');
    relay.available = false;
    relay.reason = 'capped';
  });

  it('changes the line itself, not only the panel behind it (positive)', () => {
    renderWithProviders(<TestnetNotice />);

    expect(screen.getByText(/betting is paused/i)).toBeInTheDocument();
    expect(screen.queryByText(/test funds, no real value/i)).not.toBeInTheDocument();
  });

  it('explains a spent budget as ours, and temporary (positive)', async () => {
    renderWithProviders(<TestnetNotice />);
    await userEvent.click(strip());

    expect(screen.getByText(/opens again tomorrow/i)).toBeInTheDocument();
    expect(screen.getByText(/nothing has been taken/i)).toBeInTheDocument();
  });

  it('distinguishes a deployment with no relayer from a spent budget (negative)', async () => {
    // One resolves itself overnight and the other never will.
    relay.reason = 'disabled';
    renderWithProviders(<TestnetNotice />);
    await userEvent.click(strip());

    expect(screen.getByText(/not configured on this deployment/i)).toBeInTheDocument();
    expect(screen.queryByText(/opens again tomorrow/i)).not.toBeInTheDocument();
  });

  it('publishes no figure for the gas that ran out (SECURITY)', async () => {
    renderWithProviders(<TestnetNotice />);
    await userEvent.click(strip());

    expect(document.body.textContent).not.toMatch(/MON\b.*\d|\d+\s*MON|0x[0-9a-f]{6}/i);
  });
});
