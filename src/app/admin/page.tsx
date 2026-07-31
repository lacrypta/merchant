import { redirect } from "next/navigation"

/**
 * `/admin` on its own is not a screen — it is the door.
 *
 * Nothing links here, but people type it, bookmark it and share it, and a 404
 * on the obvious guess is a bad first impression of a panel that exists.
 * Lands on the catalog, which is the first thing in the nav.
 */
export default function AdminIndexPage() {
  redirect("/admin/products")
}
