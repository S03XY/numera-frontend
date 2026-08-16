import type { Metadata } from 'next';
import { Footer, Header } from '@/components/layout/Header';
import { Wallet } from '@/components/wallet/Wallet';

export const metadata: Metadata = { title: 'Wallet' };

export default function WalletPage() {
  return (
    <>
      <Header />
      <main className="flex-1">
        <section className="shell py-10 sm:py-14">
          <Wallet />
        </section>
      </main>
      <Footer />
    </>
  );
}
