import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /**
   * Section indexes. Neither `/admin` nor `/admin/settings` is a screen — they
   * are the name of a folder, and people type them anyway.
   *
   * Here rather than in a `page.tsx` that calls `redirect()`, which is what
   * they were. A component whose only act is to throw NEXT_REDIRECT hands
   * React a render that never happened, and its dev-mode performance track
   * then tries to measure it:
   *
   *   Failed to execute 'measure' on 'Performance':
   *   'AdminIndexPage' cannot have a negative time stamp.
   *
   * The redirect docs point at this file for exactly this case — "if you'd
   * like to redirect before the render process" — and config redirects are
   * matched ahead of the filesystem, so nothing renders at all.
   *
   * It also fixes a wart: `/admin` sat inside AuthGate, so a signed-out
   * visitor got the login modal AT `/admin` and only reached `/admin/products`
   * after signing in. Now the URL is right before any React runs.
   *
   * 307 and not a permanent 308: a browser caches a permanent redirect
   * forever, and there is nothing to gain here worth making these impossible
   * to take back.
   */
  async redirects() {
    return [
      { source: "/admin", destination: "/admin/products", permanent: false },
      {
        source: "/admin/settings",
        destination: "/admin/settings/relays",
        permanent: false,
      },
    ];
  },
};

export default nextConfig;
