import { Logo } from '@/components/ui';

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col">
      <header className="px-5 py-5"><Logo /></header>
      <main className="flex flex-1 flex-col items-center px-4 pb-16 pt-6 sm:pt-12">
        <div className="w-full max-w-[420px]">{children}</div>
      </main>
    </div>
  );
}
