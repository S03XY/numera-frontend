'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import { SessionProvider } from '@/lib/auth/useSession';
import { ThemeProvider } from '@/lib/theme';
import { PoolProvider } from '@/lib/pool/PoolProvider';
import { ToastProvider } from '@/components/ui/Toast';

export function Providers({ children }: { children: React.ReactNode }) {
  // One client per browser session; created lazily so it is never shared
  // across requests during SSR.
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            /*
              Default to *fresh*, not cached.

              This used to be `staleTime: 15_000` with focus refetching off, on
              the reasoning that realtime pushes the updates. Only the market
              detail page has a channel, so everywhere else that reasoning was
              simply wrong: the board, the portfolio and the tape served a cached
              snapshot indefinitely, and a settled trade stayed invisible.

              Zero means "always revalidate on mount"; screens that carry live
              numbers additionally set their own `refetchInterval`. Returning to
              the tab refetches too — coming back to a stale price is exactly the
              moment a user decides the product is broken.
            */
            staleTime: 0,
            refetchOnWindowFocus: true,
            refetchOnReconnect: true,
            retry: (failureCount, error) => {
              // Never retry client errors (4xx) — only transient failures.
              const status = (error as { status?: number })?.status;
              if (status && status >= 400 && status < 500) return false;
              return failureCount < 2;
            },
          },
        },
      }),
  );

  return (
    <ThemeProvider>
      <QueryClientProvider client={client}>
        <ToastProvider>
          <SessionProvider>
            {/* Inside SessionProvider: unlocking Unlink registers against an
                authenticated backend route, so it depends on the login session. */}
            <PoolProvider>{children}</PoolProvider>
          </SessionProvider>
        </ToastProvider>
      </QueryClientProvider>
    </ThemeProvider>
  );
}
