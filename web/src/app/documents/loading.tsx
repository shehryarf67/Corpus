import { TopBar } from "@/components/top-bar";

export default function Loading() {
  return (
    <div className="flex min-h-[100dvh] flex-col">
      <TopBar />

      <main className="mx-auto w-full max-w-[960px] px-4 py-8 sm:px-6 sm:py-12">
        <div className="font-mono text-[10.5px] tracking-[0.14em] text-graphite-dim uppercase">
          Library
        </div>

        <h1 className="mt-2 font-serif text-[30px] leading-[1.1] font-semibold tracking-[-0.02em]">
          Documents
        </h1>

        <p className="mt-3 font-mono text-[10.5px] text-graphite-dim">
          Loading documents...
        </p>

        <div className="mt-8 grid grid-cols-1 gap-x-5 gap-y-8 min-[560px]:grid-cols-2 sm:gap-x-6 sm:gap-y-9 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, index) => (
            <div
              key={index}
              className="mx-auto w-full max-w-[380px] animate-pulse min-[560px]:max-w-none"
            >
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
