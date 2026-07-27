"use client"

import { AuthProvider } from "@/components/auth/auth-provider"
import { QueryProvider } from "@/components/providers/query-provider"
import { Toaster } from "@/components/ui/sonner"

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    // QueryProvider outermost: it restores the persisted cache, and both the
    // auth session and every screen below read through it.
    <QueryProvider>
      <AuthProvider>
        {children}
        {/* theme is pinned: this app is dark-only, so next-themes never runs. */}
        <Toaster theme="dark" position="bottom-right" richColors={false} />
      </AuthProvider>
    </QueryProvider>
  )
}
