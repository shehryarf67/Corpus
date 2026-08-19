import Link from "next/link";
import { AccountMenu } from "./account-menu";
import { Wordmark } from "./wordmark";

/**
 * Shared 52px chrome across the app. `children` fills the middle slot —
 * the library leaves it empty, the workspace puts the document's identity
 * and pane controls there.
 */
export function TopBar({ children }: { children?: React.ReactNode }) {
  return (
    <header className="flex h-[52px] min-w-0 items-center gap-3 border-b border-rule bg-chrome px-3 sm:gap-[18px] sm:px-4">
      <Link href="/documents" className="shrink-0">
        <Wordmark />
      </Link>

      {children}

      <div className="ml-auto flex shrink-0 items-center gap-3">
        <AccountMenu />
      </div>
    </header>
  );
}

/** The thin vertical rule the prototype uses between topbar sections. */
export function TopBarDivider() {
  return <div className="h-5 w-px shrink-0 bg-rule-strong" />;
}
