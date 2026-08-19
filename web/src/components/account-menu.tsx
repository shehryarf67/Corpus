import { logoutAction } from "@/app/auth-actions";

/** The avatar opens account actions without exposing the session token to JS. */
export function AccountMenu() {
  return (
    <details className="group relative">
      <summary
        aria-label="Open account menu"
        className="grid h-10 w-10 cursor-pointer list-none place-items-center rounded-full border border-rule-strong bg-raise font-mono text-[10.5px] text-graphite transition-colors hover:border-marker-line hover:text-bone [&::-webkit-details-marker]:hidden"
      >
        SH
      </summary>

      <div className="absolute top-[calc(100%+8px)] right-0 z-50 w-[min(180px,calc(100vw-24px))] rounded-[3px] border border-rule-strong bg-chrome p-1.5 shadow-[0_16px_40px_rgba(0,0,0,0.45)]">
        <div className="px-2.5 py-2 font-mono text-[9.5px] tracking-[0.12em] text-graphite-dim uppercase">
          Account
        </div>

        {/* logoutAction calls Hono first. Hono revokes the database session
            and expires the cookie before Next redirects to /login. */}
        <form action={logoutAction}>
          <button
            type="submit"
            className="w-full cursor-pointer rounded-[2px] px-2.5 py-2 text-left text-[12.5px] text-graphite transition-colors hover:bg-raise hover:text-bone"
          >
            Sign out
          </button>
        </form>
      </div>
    </details>
  );
}
