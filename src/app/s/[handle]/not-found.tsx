import { SiteNavbar } from "@/components/shell/site-navbar"
import { HandleSearchForm } from "@/components/storefront/handle-search-form"

export default function StorefrontNotFound() {
  return (
    <>
      <SiteNavbar />
      <main id="main" className="mx-auto flex w-full max-w-app flex-1 flex-col items-center justify-center px-4 py-20 text-center">
        <h1 className="text-display">No encontramos esa tienda</h1>
        <p className="mt-4 max-w-prose text-muted-foreground">
          Revisá el npub o el NIP-05. Tiene que ser algo como{" "}
          <code className="text-foreground">npub1…</code> o{" "}
          <code className="text-foreground">pepe@lacrypta.ar</code>.
        </p>
        <div className="mt-8 w-full max-w-[560px]">
          <HandleSearchForm autoFocus />
        </div>
      </main>
    </>
  )
}
