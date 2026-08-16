import { Footer, Header } from '@/components/layout/Header';
import { MarketList } from '@/components/markets/MarketList';

export default function HomePage() {
  return (
    <>
      <Header />
      <main className="flex-1">
        <section className="shell py-10 sm:py-12">
          <header className="mb-8">
            <h1 className="h-sec">Markets</h1>
            <p className="mt-2.5 text-[14px] text-ink-dim">
              Public prices. Private traders.
            </p>
          </header>

          <MarketList />
        </section>
      </main>
      <Footer />
    </>
  );
}
