import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Button } from './Button';
import { EmptyState, ErrorState, Skeleton } from './Feedback';
import { Datum, Folio, Kicker, Plate, Rule, Seal, SectionHead, StatusDot } from './primitives';
import { PrivacyMark, ShieldedAccount } from './Shielded';
import { Explain } from './Explain';
import { CopyButton } from './CopyButton';

const ACCOUNT = '0x4a7e19c3f80d2b56ae91038c7f4de205b6a3c918';

describe('Button', () => {
  it('renders and fires (positive)', async () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Place bet</Button>);
    await userEvent.click(screen.getByRole('button', { name: 'Place bet' }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('does not fire when disabled (negative)', async () => {
    const onClick = vi.fn();
    render(
      <Button disabled onClick={onClick}>
        Place bet
      </Button>,
    );
    await userEvent.click(screen.getByRole('button'));
    expect(onClick).not.toHaveBeenCalled();
  });

  it('defaults to type=button so it never submits a form by accident (regression)', () => {
    render(<Button>Go</Button>);
    expect(screen.getByRole('button')).toHaveAttribute('type', 'button');
  });

  it('still allows an explicit submit', () => {
    render(<Button type="submit">Track</Button>);
    expect(screen.getByRole('button')).toHaveAttribute('type', 'submit');
  });

  it.each([
    ['sm', 'h-9', 'sm:h-7'],
    ['md', 'h-11', 'sm:h-9'],
    ['lg', 'h-12', 'sm:h-11'],
  ] as const)(
    'gives %s a touch-sized height first and the desktop one at sm (MOBILE REGRESSION)',
    (size, touch, desktop) => {
      // The desktop sizes are drawn for a mouse — a 28px `sm` is a precise terminal control and a
      // miss under a thumb. The buttons wearing these sizes are Collect winnings, Confirm and
      // Settle, so a mis-tap costs money. Base class is the phone; `sm:` restores the instrument.
      render(<Button size={size}>Go</Button>);
      expect(screen.getByRole('button')).toHaveClass(touch, desktop);
    },
  );
});

describe('primitives', () => {
  it('renders the house typographic furniture', () => {
    render(
      <>
        <Kicker>Markets</Kicker>
        <Folio>001</Folio>
        <Seal>Settled</Seal>
      </>,
    );
    expect(screen.getByText('Markets')).toHaveClass('kicker');
    expect(screen.getByText('001')).toHaveClass('folio');
    expect(screen.getByText('Settled')).toHaveClass('seal');
  });

  it('hides purely decorative rules from assistive tech', () => {
    const { container } = render(<Rule />);
    expect(container.querySelector('.rule')).toHaveAttribute('aria-hidden', 'true');
  });

  it('marks a section and can carry a right-hand slot', () => {
    render(<SectionHead right={<span>12 books</span>}>Markets</SectionHead>);
    expect(screen.getByText('Markets')).toBeInTheDocument();
    expect(screen.getByText('12 books')).toBeInTheDocument();
  });

  it('drops the right slot to its own line rather than crushing the heading (MOBILE)', () => {
    // Truncating alone was the desktop answer and it does not survive a phone: "TOP UP THIS
    // MARKET" is 170px of tracked small caps and "Ready to trade" plus the ⓘ is another 157, so
    // in a 256px column the heading became "TOP UP T…" and the panel stopped saying what it was.
    // Wrapping decides this by measurement, which it has to — the badge's width changes with the
    // state ("Locked", "Needs funds", "Awaiting proposal"), so no breakpoint is the right one.
    const { container } = render(<SectionHead right={<span>Ready to trade</span>}>Top up</SectionHead>);
    expect(container.firstElementChild).toHaveClass('flex-wrap');
    // Right-aligned on whichever line it lands on.
    expect(screen.getByText('Ready to trade').parentElement).toHaveClass('ml-auto', 'shrink-0');
  });

  it('adds the hover treatment only to interactive plates', () => {
    const { container: still } = render(<Plate>quiet</Plate>);
    const { container: live } = render(<Plate interactive>alive</Plate>);
    expect(still.querySelector('.plate')).not.toHaveClass('plate-interactive');
    expect(live.querySelector('.plate')).toHaveClass('plate-interactive');
  });

  it('stops the status dot pulsing when the feed is down (negative)', () => {
    const { container: on } = render(<StatusDot live />);
    const { container: off } = render(<StatusDot live={false} />);
    expect(on.querySelector('.status-dot')).not.toHaveClass('status-dot-idle');
    expect(off.querySelector('.status-dot')).toHaveClass('status-dot-idle');
  });

  it('renders a label/value readout with a tone', () => {
    render(
      <dl>
        <Datum label="P&L" value="+$120" tone="pos" />
      </dl>,
    );
    expect(screen.getByText('P&L')).toBeInTheDocument();
    expect(screen.getByText('+$120')).toHaveClass('text-pos');
  });

  it('lets a long value shrink and break rather than leave the plate (MOBILE REGRESSION)', () => {
    // A 42-character address is the case that proved this. `justify-between` with two rigid
    // children simply grows past its container, so the shielded address on the Wallet screen and
    // the operator wallet in the console both ran out through the plate's right-hand border —
    // clipped rather than visibly broken, because the body hides horizontal overflow. A mono hash
    // has no spaces, so wrapping alone would not have saved it either.
    const address = '0xb27c7FEC99Bc20f25E78594510E03359ED7Be8A8';
    render(
      <dl>
        <Datum label="Shielded address" value={address} />
      </dl>,
    );
    const value = screen.getByText(address);
    expect(value).toHaveClass('min-w-0', 'break-words');
    expect(screen.getByText('Shielded address')).toHaveClass('min-w-0');
  });
});

describe('ShieldedAccount', () => {
  it('truncates the address and asserts anonymity (privacy)', () => {
    render(<ShieldedAccount address={ACCOUNT} />);
    expect(screen.getByText('0x4a7e…c918')).toBeInTheDocument();
    expect(screen.getByText(/cannot be traced to a person/i)).toBeInTheDocument();
  });

  it('exposes the full address to screen readers, not just the truncation', () => {
    render(<ShieldedAccount address={ACCOUNT} />);
    expect(screen.getByText(new RegExp(ACCOUNT))).toBeInTheDocument();
  });

  it('never renders a user, name or placeholder identity (PRIVACY)', () => {
    const { container } = render(<ShieldedAccount address={ACCOUNT} />);
    expect(container.textContent).not.toMatch(/unknown|anonymous user|user #|guest/i);
  });

  it('renders the standing privacy mark', () => {
    render(<PrivacyMark />);
    expect(screen.getByText('Shielded')).toBeInTheDocument();
  });
});

describe('feedback', () => {
  it('renders an empty state with an optional action', () => {
    render(<EmptyState title="No markets yet" description="Check back shortly." action={<Button>Reload</Button>} />);
    expect(screen.getByText('No markets yet')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reload' })).toBeInTheDocument();
  });

  it('announces errors and offers a retry (negative)', async () => {
    const onRetry = vi.fn();
    render(<ErrorState title="Couldn’t load" description="Try again." onRetry={onRetry} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Couldn’t load');
    await userEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(onRetry).toHaveBeenCalled();
  });

  it('omits the retry when there is nothing to retry (negative)', () => {
    render(<ErrorState title="Market not found" />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('hides skeletons from assistive tech so loaders are never announced', () => {
    const { container } = render(<Skeleton className="h-4" />);
    expect(container.querySelector('.skeleton')).toHaveAttribute('aria-hidden', 'true');
  });
});

describe('SectionHead', () => {
  it('lets the heading give way rather than the row overflow (REGRESSION)', () => {
    // Everything but the rule was `shrink-0`, so once the rule had collapsed the row kept growing
    // past its container and the last item in it — the ⓘ — hung over the plate's border. `.kicker`
    // sets 0.26em of letter spacing, so these strings run wider than they look.
    render(<SectionHead right={<span>Ready to trade</span>}>Top up this market</SectionHead>);
    const heading = screen.getByRole('heading', { name: /top up this market/i });

    expect(heading).toHaveClass('truncate', 'min-w-0');
    expect(heading).not.toHaveClass('shrink-0');
  });
});

describe('Explain', () => {
  const panel = () => (
    <Explain label="How private trading works" detail={<p>Routed through a shielded account.</p>}>
      Trade
    </Explain>
  );

  it('keeps the detail behind the toggle until asked (positive)', async () => {
    render(panel());
    expect(screen.queryByText(/shielded account/i)).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /how private trading works/i }));
    expect(screen.getByText(/shielded account/i)).toBeInTheDocument();
  });

  it('keeps the glyph square, like the rest of the set (positive)', () => {
    render(panel());
    const toggle = screen.getByRole('button', { name: /how private trading works/i });
    expect(toggle.querySelector('rect')).not.toBeNull();
    expect(toggle.querySelector('circle')).toBeNull();
  });

  it('gives the toggle a target bigger than its glyph (REGRESSION)', () => {
    // A bare 14px icon is well under any sane minimum, and with no box of its own it sat flush
    // against the plate's padding edge and read as a piece of the border. Centring it in a 24px
    // button is what separates it from the frame — spacing, not shape.
    render(panel());
    const toggle = screen.getByRole('button', { name: /how private trading works/i });
    expect(toggle.className).toMatch(/\bsize-6\b/);
  });

  it('reports its own state to assistive tech (positive)', async () => {
    render(panel());
    const toggle = screen.getByRole('button', { name: /how private trading works/i });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');

    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
  });
});

describe('CopyButton', () => {
  it('copies the value and confirms it (positive)', async () => {
    const writeText = vi.fn(async () => {});
    Object.assign(navigator, { clipboard: { writeText } });

    render(<CopyButton value="0xdeadbeef" label="market account address" />);
    await userEvent.click(screen.getByRole('button', { name: /copy market account address/i }));

    expect(writeText).toHaveBeenCalledWith('0xdeadbeef');
    expect(await screen.findByRole('button', { name: /copied/i })).toBeInTheDocument();
  });

  it('says nothing when the clipboard refuses (negative)', async () => {
    // Permission-gated and blocked outright in some browsers. The value is on screen beside this
    // either way, so an error here would be noise about something still doable by hand.
    Object.assign(navigator, {
      clipboard: {
        writeText: vi.fn(async () => {
          throw new Error('denied');
        }),
      },
    });

    render(<CopyButton value="0xdeadbeef" label="address" />);
    await userEvent.click(screen.getByRole('button'));

    expect(screen.getByRole('button', { name: /^copy address$/i })).toBeInTheDocument();
  });

  it('claims no status role, so panel live regions stay unambiguous (a11y REGRESSION)', () => {
    // `role="status"` here put a second live region into every panel that shows an address —
    // beside the ones reporting a syncing balance or a settling transfer, which matter more.
    const { container } = render(<CopyButton value="0xabc" label="address" />);
    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(container.querySelector('[aria-live="polite"]')).not.toBeNull();
  });
});
