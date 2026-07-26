"use client"

import * as React from "react"
import { Check, ChevronRight, Clock, Loader2, X } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@/components/ui/responsive-dialog"
import { publishEventStreaming, type RelayProgress } from "@/lib/nostr/backend"
import type { EventTemplate, PublishReport, SignedEvent } from "@/lib/nostr/types"
import { cn } from "@/lib/utils"

export type JobPhase = "queued" | "signing" | "publishing" | "done" | "failed"

export interface PublishJob {
  id: string
  /** Human label, e.g. "Fernet con Coca" or "Lista de relays". */
  label: string
  phase: JobPhase
  event: SignedEvent | null
  progress: RelayProgress[]
  error?: string
  queuedAt: number
}

export interface EnqueueOptions {
  label: string
  template: EventTemplate
  sign: (t: EventTemplate) => Promise<SignedEvent>
  relays: string[]
  /** Runs once the job settles, successfully or not. */
  onSettled?: (report: PublishReport | null) => void
}

interface PublishMonitorContextValue {
  jobs: PublishJob[]
  /** Fire-and-forget. Returns immediately; the queue does the waiting. */
  enqueue: (opts: EnqueueOptions) => string
  activeCount: number
  clear: () => void
}

const PublishMonitorContext =
  React.createContext<PublishMonitorContextValue | null>(null)

let jobCounter = 0

/**
 * Background publish queue.
 *
 * Publishing must never block the merchant: a NIP-46 round trip is 3–15s, and
 * making them wait for relay ACKs before the next action turns a five-product
 * import into a five-minute stare. So every write is enqueued and the caller
 * returns immediately, having already updated local state optimistically.
 *
 * Jobs run STRICTLY ONE AT A TIME. That is not a simplification — several
 * NIP-46 signers serialise badly and silently drop a second concurrent
 * signEvent, so a parallel queue would lose events.
 *
 * This provider sits above the dashboard router outlet, so the queue keeps
 * draining while the merchant navigates between screens.
 */
export function PublishMonitorProvider({
  children,
}: {
  children: React.ReactNode
}) {
  const [jobs, setJobs] = React.useState<PublishJob[]>([])

  // The pending work lives in a ref, not state: the drain loop must see the
  // current queue without being restarted by every render.
  const queueRef = React.useRef<(EnqueueOptions & { id: string })[]>([])
  const drainingRef = React.useRef(false)

  const patch = React.useCallback((id: string, next: Partial<PublishJob>) => {
    setJobs((prev) => prev.map((j) => (j.id === id ? { ...j, ...next } : j)))
  }, [])

  const drain = React.useCallback(async () => {
    if (drainingRef.current) return
    drainingRef.current = true

    try {
      for (;;) {
        const job = queueRef.current.shift()
        if (!job) break

        patch(job.id, { phase: "signing" })

        let signed: SignedEvent
        try {
          signed = await job.sign(job.template)
        } catch (e) {
          const message =
            e instanceof Error ? e.message : "El firmante rechazó el pedido."
          patch(job.id, { phase: "failed", error: message })
          toast.error(`No se pudo firmar «${job.label}»`, { description: message })
          job.onSettled?.(null)
          continue
        }

        patch(job.id, { phase: "publishing", event: signed })

        const report = await publishEventStreaming(
          signed,
          job.relays,
          (progress) => patch(job.id, { progress })
        )

        const ok = report.ok.length > 0
        patch(job.id, {
          phase: ok ? "done" : "failed",
          error: ok ? undefined : report.failed[0]?.reason,
        })

        if (!ok) {
          toast.error(`No se pudo publicar «${job.label}»`, {
            description: report.failed[0]?.reason ?? "Ningún relay lo aceptó.",
          })
        }

        job.onSettled?.(report)
      }
    } finally {
      drainingRef.current = false
    }
  }, [patch])

  const enqueue = React.useCallback(
    (opts: EnqueueOptions) => {
      const id = `job-${++jobCounter}`
      setJobs((prev) => [
        ...prev,
        {
          id,
          label: opts.label,
          phase: "queued",
          event: null,
          progress: [],
          queuedAt: Date.now(),
        },
      ])
      queueRef.current.push({ ...opts, id })
      void drain()
      return id
    },
    [drain]
  )

  const clear = React.useCallback(() => {
    // Only drop settled jobs; anything still in flight must stay visible.
    setJobs((prev) => prev.filter((j) => j.phase !== "done" && j.phase !== "failed"))
  }, [])

  const activeCount = jobs.filter(
    (j) => j.phase === "queued" || j.phase === "signing" || j.phase === "publishing"
  ).length

  const value = React.useMemo(
    () => ({ jobs, enqueue, activeCount, clear }),
    [jobs, enqueue, activeCount, clear]
  )

  return (
    <PublishMonitorContext.Provider value={value}>
      {children}
      <PublishMonitorWidget />
    </PublishMonitorContext.Provider>
  )
}

export function usePublishMonitor(): PublishMonitorContextValue {
  const ctx = React.useContext(PublishMonitorContext)
  if (!ctx) {
    throw new Error("usePublishMonitor must be used inside <PublishMonitorProvider>")
  }
  return ctx
}

/** Circular determinate progress — the count is the information. */
function ProgressRing({
  done,
  total,
  failed,
  indeterminate,
  size = 40,
}: {
  done: number
  total: number
  failed: number
  indeterminate?: boolean
  size?: number
}) {
  const stroke = 3
  const r = (size - stroke) / 2
  const circumference = 2 * Math.PI * r
  const pct = total === 0 ? 0 : done / total
  const allDone = total > 0 && done === total
  const anyFailed = failed > 0

  return (
    <span
      className="relative inline-grid shrink-0 place-items-center"
      style={{ width: size, height: size }}
    >
      <svg
        width={size}
        height={size}
        className={cn("-rotate-90", indeterminate && "motion-safe:animate-spin")}
        aria-hidden
      >
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="var(--color-surface-4)"
          strokeWidth={stroke}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={
            anyFailed && allDone ? "var(--color-warning)" : "var(--color-primary)"
          }
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={
            indeterminate ? circumference * 0.75 : circumference * (1 - pct)
          }
          className="transition-[stroke-dashoffset] duration-300 ease-[var(--ease-brand)]"
        />
      </svg>
      {!indeterminate ? (
        <span className="absolute grid place-items-center">
          {allDone && !anyFailed ? (
            <Check className="size-4 text-primary" aria-hidden />
          ) : (
            <span className="numeric text-[0.625rem] font-bold">
              {done}/{total}
            </span>
          )}
        </span>
      ) : null}
    </span>
  )
}

function summarise(job: PublishJob) {
  const total = job.progress.length
  const ok = job.progress.filter((p) => p.state === "ok").length
  const failed = job.progress.filter((p) => p.state === "failed").length
  return { total, ok, failed, settled: ok + failed }
}

function PublishMonitorWidget() {
  const { jobs, activeCount, clear } = usePublishMonitor()
  const [open, setOpen] = React.useState(false)

  const latest = jobs[jobs.length - 1]
  const queued = jobs.filter((j) => j.phase === "queued").length
  const anyFailed = jobs.some((j) => j.phase === "failed")

  // Auto-dismiss once everything has settled cleanly. Failures stay put —
  // those are the ones the merchant has to act on.
  React.useEffect(() => {
    if (activeCount > 0 || anyFailed || jobs.length === 0) return
    const t = setTimeout(clear, 3500)
    return () => clearTimeout(t)
  }, [activeCount, anyFailed, jobs.length, clear])

  if (!latest) return null

  const { total, ok, failed, settled } = summarise(latest)
  const busy = activeCount > 0

  let headline: string
  if (latest.phase === "queued") headline = "En cola…"
  else if (latest.phase === "signing") headline = "Esperando tu firma…"
  else if (latest.phase === "publishing")
    headline = `Publicando en ${settled}/${total} relays…`
  else if (latest.phase === "failed") headline = "No se pudo publicar"
  else headline = `Publicado en ${ok} de ${total} relays`

  return (
    <>
      <div className="safe-b pointer-events-none fixed inset-x-0 bottom-0 z-50 flex justify-end p-4 lg:p-6">
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label="Ver detalle de la publicación"
          aria-live="polite"
          className={cn(
            "pointer-events-auto flex items-center gap-3 rounded-2xl border bg-popover px-4 py-3 text-left shadow-2xl",
            "transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
            anyFailed && !busy
              ? "border-warning/40"
              : "border-border hover:border-border-strong"
          )}
        >
          <ProgressRing
            done={settled}
            total={total}
            failed={failed}
            indeterminate={
              latest.phase === "queued" || latest.phase === "signing"
            }
          />

          <span className="min-w-0">
            <span className="block text-sm font-semibold">{headline}</span>
            <span className="block truncate text-xs text-muted-foreground">
              {latest.label}
              {queued > 0 ? ` · ${queued} en cola` : ""}
            </span>
          </span>

          <ChevronRight
            className="size-4 shrink-0 text-muted-foreground"
            aria-hidden
          />
        </button>
      </div>

      <PublishDetailDialog open={open} onOpenChange={setOpen} jobs={jobs} />
    </>
  )
}

function PublishDetailDialog({
  open,
  onOpenChange,
  jobs,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  jobs: PublishJob[]
}) {
  const { clear } = usePublishMonitor()

  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent className="sm:max-w-2xl">
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>Cola de publicación</ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            Qué se firmó y cómo respondió cada relay.
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>

        <div className="space-y-8">
          {[...jobs].reverse().map((job) => {
            const { total, ok, failed, settled } = summarise(job)
            return (
              <section key={job.id} className="space-y-4">
                <header className="flex items-center gap-3">
                  <ProgressRing
                    done={settled}
                    total={total}
                    failed={failed}
                    indeterminate={
                      job.phase === "queued" || job.phase === "signing"
                    }
                    size={32}
                  />
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-semibold">{job.label}</p>
                    <p className="numeric text-xs text-muted-foreground">
                      {job.phase === "queued"
                        ? "En cola"
                        : job.phase === "signing"
                          ? "Esperando firma"
                          : `${ok} aceptaron · ${failed} fallaron`}
                      {job.event ? (
                        <>
                          <span aria-hidden> · </span>kind {job.event.kind}
                        </>
                      ) : null}
                    </p>
                  </div>
                  {job.phase === "queued" ? (
                    <Clock className="size-4 text-muted-foreground" aria-hidden />
                  ) : null}
                </header>

                {job.progress.length > 0 ? (
                  <ul className="space-y-1.5">
                    {job.progress.map((p) => (
                      <li
                        key={p.relay}
                        className="flex items-center gap-3 rounded-lg border border-border bg-card px-3 py-2"
                      >
                        <span aria-hidden className="shrink-0">
                          {p.state === "pending" ? (
                            <Loader2 className="size-4 animate-spin text-muted-foreground" />
                          ) : p.state === "ok" ? (
                            <Check className="size-4 text-success" />
                          ) : (
                            <X className="size-4 text-danger" />
                          )}
                        </span>
                        <span className="numeric truncate-middle min-w-0 flex-1 text-xs">
                          {p.relay}
                        </span>
                        <span
                          className={cn(
                            "shrink-0 text-xs",
                            p.state === "ok"
                              ? "text-success"
                              : p.state === "failed"
                                ? "text-danger"
                                : "text-muted-foreground"
                          )}
                        >
                          {p.state === "pending"
                            ? "esperando…"
                            : p.state === "ok"
                              ? "aceptado"
                              : (p.reason ?? "rechazado")}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : null}

                {job.event ? (
                  <details className="group rounded-lg border border-border bg-surface-2">
                    <summary className="cursor-pointer list-none px-3 py-2 text-sm font-medium select-none">
                      <span className="inline-flex items-center gap-2">
                        <ChevronRight
                          className="size-4 transition-transform group-open:rotate-90"
                          aria-hidden
                        />
                        Ver evento firmado (JSON)
                      </span>
                    </summary>
                    <pre className="max-h-80 overflow-auto border-t border-border px-3 py-3 font-mono text-[0.6875rem] leading-relaxed">
                      {JSON.stringify(job.event, null, 2)}
                    </pre>
                  </details>
                ) : null}
              </section>
            )
          })}
        </div>

        <div className="mt-6 flex gap-3">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cerrar
          </Button>
          <Button variant="ghost" onClick={clear}>
            Limpiar terminados
          </Button>
        </div>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  )
}
