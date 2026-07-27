"use client"

import { Check, Copy, ExternalLink } from "lucide-react"
import * as React from "react"

import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"

/**
 * The BOLT-11 QR.
 *
 * A white card with a real quiet zone, not a lime-on-black novelty: phone
 * cameras need the contrast and the margin to lock on, and this is the one
 * moment in the flow where being scannable beats being on-brand. Same
 * treatment the NIP-46 login QR already uses.
 */
export function InvoiceQr({ pr }: { pr: string }) {
  const [dataUrl, setDataUrl] = React.useState<string | null>(null)
  const [copied, setCopied] = React.useState(false)

  React.useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const QR = (await import("qrcode")).default
        // Uppercase: bech32 is case-insensitive and uppercase packs into
        // alphanumeric QR mode, which is a meaningfully smaller symbol.
        const url = await QR.toDataURL(`lightning:${pr.toUpperCase()}`, {
          errorCorrectionLevel: "M",
          margin: 2,
          width: 512,
          color: { dark: "#0A0A0A", light: "#FFFFFF" },
        })
        if (!cancelled) setDataUrl(url)
      } catch {
        /* the copy button and the wallet link still work */
      }
    })()
    return () => {
      cancelled = true
    }
  }, [pr])

  return (
    <div className="space-y-3">
      <div className="mx-auto w-full max-w-[280px] rounded-2xl bg-white p-3">
        {dataUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={dataUrl}
            alt="Código QR de la factura Lightning"
            className="size-full"
          />
        ) : (
          <Skeleton className="aspect-square w-full rounded-lg bg-neutral-200" />
        )}
      </div>

      <div className="flex flex-wrap justify-center gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            void navigator.clipboard.writeText(pr)
            setCopied(true)
            window.setTimeout(() => setCopied(false), 1500)
          }}
        >
          {copied ? (
            <Check className="size-4" aria-hidden />
          ) : (
            <Copy className="size-4" aria-hidden />
          )}
          {copied ? "Copiada" : "Copiar factura"}
        </Button>
        <Button variant="outline" size="sm" asChild>
          <a href={`lightning:${pr}`}>
            <ExternalLink className="size-4" aria-hidden />
            Abrir billetera
          </a>
        </Button>
      </div>
    </div>
  )
}
