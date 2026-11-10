"use client";

import { Loader2 } from "lucide-react";
import { useLinkStatus } from "next/link";

/**
 * Goes inside a <Link>. While that link's page is loading it shows a small
 * spinner in place of `children`; the current page stays on screen meanwhile.
 */
export function LinkPending({ children }: { children?: React.ReactNode }) {
  const { pending } = useLinkStatus();
  if (!pending) return <>{children}</>;
  return <Loader2 size={12} role="status" aria-label="Loading" className="shrink-0 animate-spin opacity-60" />;
}
