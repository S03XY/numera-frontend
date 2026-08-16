'use client';

import * as React from 'react';
import { subscribeToInjectedWallets, type InjectedWallet } from './injected';

/**
 * The browser wallets available on this device.
 *
 * Starts empty and fills in as extensions answer the EIP-6963 request, which is
 * why the caller must distinguish "still looking" from "none installed" — an
 * empty array on first render is not yet evidence of absence, and telling
 * someone with MetaMask that they have no wallet is the worst possible outcome.
 */
export function useInjectedWallets(): { wallets: InjectedWallet[]; searching: boolean } {
  const [wallets, setWallets] = React.useState<InjectedWallet[]>([]);
  const [searching, setSearching] = React.useState(true);

  React.useEffect(() => {
    const stop = subscribeToInjectedWallets(setWallets);
    // Extensions answer within a frame or two; anything slower is absent. We
    // keep listening after this — a late announcement still lands — but stop
    // claiming to be looking, so the empty state can be shown honestly.
    const timer = setTimeout(() => setSearching(false), 400);
    return () => {
      stop();
      clearTimeout(timer);
    };
  }, []);

  return { wallets, searching };
}
