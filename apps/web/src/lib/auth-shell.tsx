/**
 * The screen somebody sees before they are anybody.
 *
 * Sign in, set the instance up, reset a password, accept an invitation. Four
 * screens, all of them one card in the middle of an empty page, and all four
 * had built that card themselves — `flex min-h-screen items-center
 * justify-center p-6` four times, a `rounded border p-6` four times, and four
 * different widths between them.
 *
 * They matter more than their line count suggests: this is the first thing a
 * customer ever sees of the product, and until now it was the part of the
 * product that used none of it.
 */
import type { ReactNode } from "react";
import { raised } from "./ui";

export function AuthShell({
  title,
  children,
  footer,
  width = "sm",
}: {
  /**
   * The heading. Every one of these screens has exactly one — but a screen
   * that picks its heading inside a branch (the invitation is either live or
   * expired, and says so differently) draws its own and leaves this out.
   */
  title?: ReactNode;
  children: ReactNode;
  /** Under the card, outside it: the credit line, a link back. */
  footer?: ReactNode;
  /** `md` for the setup form, which asks for more than a password. */
  width?: "sm" | "md";
}) {
  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <div className={`w-full ${width === "md" ? "max-w-md" : "max-w-sm"}`}>
        <div
          className="flex flex-col gap-(--gap-stack) rounded-md border border-line p-6"
          style={raised}
        >
          {title ? <h1 className="font-semibold text-lg">{title}</h1> : null}
          {children}
        </div>
        {footer}
      </div>
    </div>
  );
}
