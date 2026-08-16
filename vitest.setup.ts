import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';
import { pendingBalances, pendingPositions } from '@/lib/optimistic/pending';

/**
 * Shared setup for every test file.
 *
 * Most run under jsdom, but some deliberately opt into `// @vitest-environment
 * node` — Unlink's key derivation fails under jsdom because @zk-kit checks
 * `instanceof Uint8Array` against bytes minted in another realm. So every DOM
 * touch below is guarded: this file has to be a no-op in node rather than
 * throwing at import and taking the whole suite down.
 */
const HAS_DOM = typeof window !== 'undefined' && typeof document !== 'undefined';

afterEach(() => {
  if (!HAS_DOM) return;
  cleanup();
  vi.clearAllMocks();
  // The refresh token is persisted in localStorage, which is shared across all
  // TokenStore instances in a test file. Clear it so tests stay isolated.
  window.localStorage?.clear();
  // The theme is written to <html>; leaving it set would leak across tests.
  document.documentElement.removeAttribute('data-theme');
  /*
    Optimistic predictions live in module-level stores, outside React, because the component that
    makes one and the components that draw it share no ancestor worth threading state through. That
    makes them a global like any other, and they leak: a deposit predicted in one test kept applying
    in the next, whose fixed balance never moved and so never retired it. The panel then read a
    balance of zero and its withdrawal button vanished, several tests away from the cause.
  */
  pendingPositions.clear();
  pendingBalances.clear();
});

// jsdom has no canvas backend. The ambient Veil bails out on a null context, so
// this only silences the "not implemented" noise it would otherwise log.
if (HAS_DOM && !HTMLCanvasElement.prototype.getContext) {
  HTMLCanvasElement.prototype.getContext = (() => null) as never;
}

// jsdom does not implement IntersectionObserver; scroll reveals fall back to
// visible without it, but stubbing keeps the code path under test.
if (HAS_DOM && typeof window.IntersectionObserver === 'undefined') {
  class StubObserver {
    constructor(private readonly cb: IntersectionObserverCallback) {}
    observe(target: Element) {
      this.cb(
        [{ isIntersecting: true, target } as IntersectionObserverEntry],
        this as unknown as IntersectionObserver,
      );
    }
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return [];
    }
    root = null;
    rootMargin = '';
    thresholds = [];
  }
  window.IntersectionObserver = StubObserver as unknown as typeof IntersectionObserver;
}

// jsdom does not implement matchMedia; several components query it.
if (HAS_DOM && !window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })) as unknown as typeof window.matchMedia;
}
