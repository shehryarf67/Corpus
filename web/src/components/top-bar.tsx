import Link from "next/link";
import { logoutAction } from "@/app/auth-actions";
import { Wordmark } from "./wordmark";

/**
 * Shared 52px chrome across the app. `children` fills the middle slot —
 * the library leaves it empty, the workspace puts the document's identity
 * and pane controls there.
 */
export function TopBar({ children }: { children?: React.ReactNode }) {
  return (
    <header className="flex h-[52px] items-center gap-[18px] border-b border-rule bg-chrome px-4">
      <Link href="/documents" className="shrink-0">
        <Wordmark />
      </Link>

      {children}

      <div className="ml-auto flex items-center gap-3">
        <div className="grid h-[27px] w-[27px] place-items-center rounded-full border border-rule-strong bg-raise font-mono text-[10.5px] text-graphite">
          SH
        </div>
        <form action={logoutAction}>
          <button
            type="submit"
            className="cursor-pointer font-mono text-[10.5px] text-graphite-dim transition-colors hover:text-bone"
          >
            Sign out
          </button>
        </form>
      </div>
    </header>
  );
}

/** The thin vertical rule the prototype uses between topbar sections. */
export function TopBarDivider() {
  return <div className="h-5 w-px shrink-0 bg-rule-strong" />;
}
