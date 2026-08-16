import type { Metadata } from 'next';
import { Footer, Header } from '@/components/layout/Header';
import { AdminConsole } from '@/components/admin/AdminConsole';

export const metadata: Metadata = { title: 'Operations' };

export default function AdminPage() {
  return (
    <>
      <Header />
      <main className="flex-1">
        <section className="shell py-10 sm:py-14">
          <AdminConsole />
        </section>
      </main>
      <Footer />
    </>
  );
}
