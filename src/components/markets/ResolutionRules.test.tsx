import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import { ResolutionRules } from './ResolutionRules';
import { renderWithProviders, makeMarket } from '@/test/render';

/**
 * The published settlement rule.
 *
 * Two things are being defended. The rule has to be *shown* — a market where anyone can propose the
 * result is unusable if the criteria are only in someone's head. And the page has to say that it
 * cannot change, because "here are the rules" and "here are the rules, and they are fixed in the
 * market's on-chain record" are very different promises, and only the second one is worth anything
 * to somebody deciding whether to stake money on their reading of it.
 */
describe('ResolutionRules', () => {
  const RULE =
    'Settles to the team leading at the final whistle, per the official match report. ' +
    'If the match is abandoned, the market is voided.';

  it('shows the published rule (positive)', () => {
    renderWithProviders(<ResolutionRules market={makeMarket({ resolutionRules: RULE })} />);
    expect(screen.getByText(RULE)).toBeInTheDocument();
  });

  it('says the rule cannot be changed now money is on it (positive)', () => {
    renderWithProviders(<ResolutionRules market={makeMarket({ resolutionRules: RULE })} />);
    expect(screen.getByText(/cannot be changed/i)).toBeInTheDocument();
    expect(screen.getByText(/on-chain record/i)).toBeInTheDocument();
  });

  /**
   * Markets predating this feature have no rule. Showing an empty disclosure would imply the rule
   * exists and is blank, which is worse than showing nothing.
   */
  it('renders nothing at all when no rule was published (negative)', () => {
    const { container } = renderWithProviders(
      <ResolutionRules market={makeMarket({ resolutionRules: '' })} />,
    );
    expect(container.querySelector('details')).toBeNull();
  });

  it('stays collapsed while browsing, and opens where somebody is about to act on it', () => {
    const { container, unmount } = renderWithProviders(
      <ResolutionRules market={makeMarket({ resolutionRules: RULE })} />,
    );
    expect(container.querySelector('details')?.open).toBe(false);
    unmount();

    const opened = renderWithProviders(
      <ResolutionRules market={makeMarket({ resolutionRules: RULE })} defaultOpen />,
    );
    expect(opened.container.querySelector('details')?.open).toBe(true);
  });

  /** Operators write these as paragraphs; collapsing the newlines would run the clauses together. */
  it('preserves the line breaks an operator wrote (regression)', () => {
    const multiline = 'Settles to the winner.\n\nVoided if abandoned.';
    renderWithProviders(<ResolutionRules market={makeMarket({ resolutionRules: multiline })} />);
    const para = screen.getByText(/Settles to the winner/);
    expect(para.className).toContain('whitespace-pre-line');
  });
});
