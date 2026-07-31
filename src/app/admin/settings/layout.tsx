import { SettingsNav } from "@/components/settings/settings-nav"

/**
 * Settings had sub-pages with no way to move between them: you could reach
 * /settings/relays from the sidebar and then had nowhere to go.
 */
export default function SettingsLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <div className="space-y-6">
      <SettingsNav />
      {children}
    </div>
  )
}
