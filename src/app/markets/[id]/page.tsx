import { Footer, Header } from '@/components/layout/Header';
import { MarketDetail } from '@/components/markets/MarketDetail';

// Next 16: route params arrive as a Promise and must be awaited.
export default async function MarketPage({ params }: PageProps<'/markets/[id]'>) {
  const { id } = await params;

  return (
    <>
      <Header />
      <main className="flex-1">
        <section className="shell py-10 sm:py-14">
          <MarketDetail marketId={id} />
        </section>
      </main>
      <Footer />
    </>
  );
}
