import { TopBar } from "@/components/top-bar";

export default function Loading() {
  return (
    <div className="flex min-h-[100dvh] flex-col">
      <TopBar />

      <main className="mx-auto w-full max-w-[960px] px-6 py-12">
        <div className="font-mono text-[10.5px] tracking-[0.14em] text-graphite-dim uppercase">
          Library
        </div>

        <h1 className="mt-2 font-serif text-[30px] leading-[1.1] font-semibold tracking-[-0.02em]">
          Documents
        </h1>

        <p className="mt-3 font-mono text-[10.5px] text-graphite-dim">
          Loading documents...
        </p>

        <div className="mt-8 grid grid-cols-1 gap-x-6 gap-y-9 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, index) => (
            <div key={index} className="animate-pulse">
              <div className="aspect-[3/4] rounded-[2px] border border-rule bg-rule/20" />

              <div className="mt-3.5 h-4 w-4/5 rounded bg-rule/30" />
              <div className="mt-2 h-3 w-3/5 rounded bg-rule/20" />
              <div className="mt-3 h-3 w-2/5 rounded bg-rule/20" />
            </div>
          ))}
        </div>
      </main>
    </div>
  );
}