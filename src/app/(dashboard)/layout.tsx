import { AuthGate } from "@/components/auth/auth-gate"
import { CatalogProvider } from "@/components/catalog/catalog-provider"
import { PublishMonitorProvider } from "@/components/publish/publish-monitor"
import { AppShell } from "@/components/shell/app-shell"
import { MerchantMenu } from "@/components/shell/merchant-menu"

/**
 * The administration area. Everything inside is behind AuthGate — the panel
 * is private and only renders once a signer is connected.
 *
 * Order matters: CatalogProvider calls usePublishMonitor, so the monitor must
 * be its ancestor. Both sit inside the gate, since they key off the active
 * pubkey and would otherwise issue empty queries for an anonymous visitor.
 */
export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <AppShell topbar={<MerchantMenu />}>
      <AuthGate>
        <PublishMonitorProvider>
          <CatalogProvider>{children}</CatalogProvider>
        </PublishMonitorProvider>
      </AuthGate>
    </AppShell>
  )
}
