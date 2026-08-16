import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render as rtlRender, type RenderOptions } from '@testing-library/react';
import type { ReactElement } from 'react';
import { ThemeProvider } from '@/lib/theme';
import { SessionProvider } from '@/lib/auth/useSession';
import { PoolProvider } from '@/lib/pool/PoolProvider';
import { ToastProvider } from '@/components/ui/Toast';
import type { Market, Outcome } from '@/lib/api/types';

/** Render with a fresh QueryClient and retries disabled (fast, deterministic). */
export function renderWithProviders(ui: ReactElement, options?: RenderOptions) {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, staleTime: 0 },
      mutations: { retry: false },
    },
  });
  return {
    client,
    ...rtlRender(
      // Mirrors app/providers.tsx. Both context providers are included because
      // anything that can place a trade calls usePool(), and anything that
      // knows who you are calls useSession() — either throws without its
      // provider, which would make components untestable in isolation for
      // reasons that have nothing to do with the component.
      //
      // A suite that stubs `useSession` must pass `SessionProvider` through
      // (see ConnectButton.test.tsx): mocking the whole module replaces the
      // provider with `undefined` and this tree stops rendering.
      <ThemeProvider>
        <QueryClientProvider client={client}>
          <ToastProvider>
            <SessionProvider>
              <PoolProvider>{ui}</PoolProvider>
            </SessionProvider>
          </ToastProvider>
        </QueryClientProvider>
      </ThemeProvider>,
      options,
    ),
  };
}

const WAD = 10n ** 18n;

export function makeOutcome(index: number, label: string, pct: number): Outcome {
  const priceWad = ((WAD * BigInt(Math.round(pct * 100))) / 10_000n).toString();
  return {
    index,
    label,
    priceWad,
    probability: (pct / 100).toString(),
    shares: '0',
  };
}

export function makeMarket(overrides: Partial<Market> = {}): Market {
  const outcomes = overrides.outcomes ?? [
    makeOutcome(0, 'Argentina', 60),
    makeOutcome(1, 'France', 40),
  ];
  return {
    id: '11111111-1111-4111-8111-111111111111',
    engine: 'LS_LMSR',
    address: '0xengine',
    marketId: '1',
    title: 'Argentina vs France',
    description: 'Full-time result',
    resolutionRules:
      'Settles to the winner after 90 minutes plus stoppage, per the official match report.',
    imageUrl: null,
    category: 'SPORTS',
    status: 'TRADING',
    tradingOpen: true,
    // Open by default: every market has a start time, and one in the past is what "opens
    // immediately" looks like. Tests that want a scheduled market override both fields.
    startTime: new Date(Date.now() - 3600_000).toISOString(),
    notOpenYet: false,
    closeTime: new Date(Date.now() + 3600_000).toISOString(),
    winningOutcomeId: null,
    collateral: '0xusdc',
    collateralDecimals: 6,
    alpha: '25000000000000000',
    sStar: '2000000000000000000000',
    seed: '1000000000',
    surplus: null,
    pot: '1500000000',
    potHuman: '1500',
    outcomeCount: outcomes.length,
    outcomes,
    // Null is the honest default: a market that has never been through the resolution layer, which
    // is every market that is still trading and therefore most fixtures.
    resolution: null,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}
