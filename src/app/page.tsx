import Link from "next/link"

import { GridBackdrop } from "@/components/brand/grid-backdrop"
import { SiteNavbar } from "@/components/shell/site-navbar"
import { HandleSearchForm } from "@/components/storefront/handle-search-form"

export default function LandingPage() {
  return (
    <>
      <SiteNavbar />

      <main id="main" className="relative flex flex-1 flex-col">
        <GridBackdrop variant="horizon" className="opacity-70" />

        <section className="mx-auto flex w-full max-w-app flex-1 flex-col items-center justify-center px-4 py-16 text-center md:px-8">
          <h1 className="text-hero max-w-[14ch]">
            Tu catálogo,
            <br />
            <span className="text-primary">en nostr</span>
          </h1>

          <p className="mt-8 max-w-prose text-lg text-muted-foreground">
            Publicá productos y servicios como eventos firmados con tu propia
            clave. Cualquier punto de venta los lee en vivo.
          </p>

          <div className="mt-10 w-full max-w-[680px]">
            <HandleSearchForm />
            <p className="mt-4 text-sm text-muted-foreground">
              Buscá una tienda por npub o NIP-05.
            </p>
          </div>
        </section>

        <section className="mx-auto w-full max-w-app px-4 pb-20 md:px-8">
          <div className="grid gap-4 md:grid-cols-3">
            <Feature
              title="Sos el dueño del catálogo"
              body="Los productos viven en nostr como eventos NIP-99 firmados con tu npub, no en la base de datos de nadie."
            />
            <Feature
              title="El POS lee en vivo"
              body="Editás un precio acá y el punto de venta lo ve al instante. Se terminó copiar archivos JSON entre repos."
            />
            <Feature
              title="ARS, USD o sats"
              body="Poné el precio en la moneda que quieras. La conversión se calcula al momento de cobrar."
            />
          </div>

          <p className="mt-10 text-center text-sm text-muted-foreground">
            Hecho por{" "}
            <Link
              href="https://lacrypta.ar"
              target="_blank"
              rel="noreferrer noopener"
              className="text-primary underline-offset-4 hover:underline"
            >
              La Crypta
            </Link>
          </p>
        </section>
      </main>
    </>
  )
}

function Feature({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-2xl border border-border bg-card p-6">
      <h2 className="text-h3">{title}</h2>
      <p className="mt-2 text-sm text-muted-foreground">{body}</p>
    </div>
  )
}
