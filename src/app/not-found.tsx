import Link from 'next/link';
import { Footer, Header } from '@/components/layout/Header';
import { Folio } from '@/components/ui/primitives';

export default function NotFound() {
  return (
    <>
      <Header />
      <main className="flex flex-1 items-center">
        <section className="shell py-24 text-center">
          <Folio>Error 404</Folio>
          <h1 className="h-sec mt-4">
            Nothing is written <span className="italic">here</span>.
          </h1>
          <p className="mx-auto mt-4 max-w-[42ch] text-[14px] leading-relaxed text-ink-dim">
            This page does not exist — or the market it pointed to was never opened.
          </p>
          <Link href="/" className="link-rule mono mt-7 inline-block text-[11.5px] uppercase tracking-[0.18em] text-accent-bright">
            Back to markets
          </Link>
        </section>
      </main>
      <Footer />
    </>
  );
}
