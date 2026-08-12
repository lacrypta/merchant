import Link from "next/link"

import { GithubMark } from "@/components/brand/github-mark"
import { cn } from "@/lib/utils"

const REPO_URL = "https://github.com/lacrypta/merchant"

/**
 * The one footer, on every page.
 *
 * `className` exists for the surfaces with a bar fixed to the bottom of the
 * viewport — the dashboard's tab bar, the storefront's cart bar. Those overlay
 * whatever is at the end of the document, so the footer pads itself clear of
 * them rather than each shell inventing its own spacer.
 */
export function SiteFooter({ className }: { className?: string }) {
  return (
    <footer className={cn("border-t border-border", className)}>
      <div className="mx-auto flex w-full max-w-app flex-wrap items-center justify-center gap-x-6 gap-y-3 px-4 py-6 text-sm text-muted-foreground md:px-8">
        <p>
          Hecho por{" "}
          <Link
            href="https://github.com/agustinkassis"
            target="_blank"
            rel="noreferrer noopener"
            className="text-primary underline-offset-4 hover:underline"
          >
            El Gorila
          </Link>
          {" - Powered by "}
          <Link
            href="https://lacrypta.ar"
            target="_blank"
            rel="noreferrer noopener"
            className="text-primary underline-offset-4 hover:underline"
          >
            La Crypta
          </Link>
        </p>
        <a
          href={REPO_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-2 rounded-lg hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          <GithubMark className="size-5" />
          <span>Código en GitHub</span>
        </a>
      </div>
    </footer>
  )
}
