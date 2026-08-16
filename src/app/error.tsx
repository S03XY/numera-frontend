'use client';

import { Folio } from '@/components/ui/primitives';
import { Button } from '@/components/ui/Button';

export default function GlobalError({ reset }: { error: Error; reset: () => void }) {
  return (
    <main className="flex flex-1 items-center">
      <section className="shell py-24 text-center">
        <Folio>Something broke</Folio>
        <h1 className="h-sec mt-4">The house is briefly closed.</h1>
        <p className="mx-auto mt-4 max-w-[44ch] text-[14px] leading-relaxed text-ink-dim">
          An unexpected error interrupted this page. Your session and any tracked accounts are
          untouched.
        </p>
        <Button variant="primary" className="mt-7" onClick={reset}>
          Try again
        </Button>
      </section>
    </main>
  );
}
