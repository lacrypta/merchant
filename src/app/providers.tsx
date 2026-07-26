"use client"

import { AuthProvider } from "@/components/auth/auth-provider"
import { Toaster } from "@/components/ui/sonner"

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <AuthProvider>
      {children}
      {/* theme is pinned: this app is dark-only, so next-themes never runs. */}
      <Toaster theme="dark" position="bottom-right" richColors={false} />
    </AuthProvider>
  )
}
