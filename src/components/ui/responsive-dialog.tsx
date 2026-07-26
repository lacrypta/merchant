"use client"

import * as React from "react"

import { cn } from "@/lib/utils"
import { useIsDesktop } from "@/hooks/use-media-query"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
} from "@/components/ui/drawer"

/**
 * Dialog on desktop, Drawer on touch — one API.
 *
 * EVERY modal in this app routes through this component. The point is to
 * keep `useMediaQuery` out of feature code: scattering it produces
 * inconsistent breakpoints and duplicated a11y wiring.
 *
 * Because `useIsDesktop()` returns false on the server and on first client
 * render, the Drawer branch is what SSR emits — mobile-first, and the
 * hydrated tree always matches.
 */

type ResponsiveDialogContextValue = { isDesktop: boolean }
const ResponsiveDialogContext = React.createContext<ResponsiveDialogContextValue>({
  isDesktop: false,
})

function ResponsiveDialog({
  children,
  ...props
}: React.ComponentProps<typeof Dialog>) {
  const isDesktop = useIsDesktop()
  const Root = isDesktop ? Dialog : Drawer

  return (
    <ResponsiveDialogContext.Provider value={{ isDesktop }}>
      <Root {...props}>{children}</Root>
    </ResponsiveDialogContext.Provider>
  )
}

function useResponsiveDialog() {
  return React.useContext(ResponsiveDialogContext)
}

function ResponsiveDialogTrigger(
  props: React.ComponentProps<typeof DialogTrigger>
) {
  const { isDesktop } = useResponsiveDialog()
  const Comp = isDesktop ? DialogTrigger : DrawerTrigger
  return <Comp {...props} />
}

function ResponsiveDialogContent({
  className,
  children,
  ...props
}: React.ComponentProps<typeof DialogContent>) {
  const { isDesktop } = useResponsiveDialog()

  if (isDesktop) {
    return (
      <DialogContent
        className={cn("max-h-[85dvh] overflow-y-auto rounded-2xl", className)}
        {...props}
      >
        {children}
      </DialogContent>
    )
  }

  return (
    <DrawerContent className={cn("max-h-[92dvh]", className)}>
      <div className="overflow-y-auto overscroll-contain px-4 pb-4">{children}</div>
    </DrawerContent>
  )
}

function ResponsiveDialogHeader(props: React.ComponentProps<typeof DialogHeader>) {
  const { isDesktop } = useResponsiveDialog()
  const Comp = isDesktop ? DialogHeader : DrawerHeader
  return <Comp {...props} />
}

function ResponsiveDialogFooter({
  className,
  ...props
}: React.ComponentProps<typeof DialogFooter>) {
  const { isDesktop } = useResponsiveDialog()
  if (isDesktop) return <DialogFooter className={className} {...props} />
  // safe-b clears the iOS home indicator on the drawer's sticky footer.
  return <DrawerFooter className={cn("safe-b", className)} {...props} />
}

function ResponsiveDialogTitle(props: React.ComponentProps<typeof DialogTitle>) {
  const { isDesktop } = useResponsiveDialog()
  const Comp = isDesktop ? DialogTitle : DrawerTitle
  return <Comp {...props} />
}

function ResponsiveDialogDescription(
  props: React.ComponentProps<typeof DialogDescription>
) {
  const { isDesktop } = useResponsiveDialog()
  const Comp = isDesktop ? DialogDescription : DrawerDescription
  return <Comp {...props} />
}

function ResponsiveDialogClose(props: React.ComponentProps<typeof DialogClose>) {
  const { isDesktop } = useResponsiveDialog()
  const Comp = isDesktop ? DialogClose : DrawerClose
  return <Comp {...props} />
}

export {
  ResponsiveDialog,
  ResponsiveDialogTrigger,
  ResponsiveDialogContent,
  ResponsiveDialogHeader,
  ResponsiveDialogFooter,
  ResponsiveDialogTitle,
  ResponsiveDialogDescription,
  ResponsiveDialogClose,
  useResponsiveDialog,
}
