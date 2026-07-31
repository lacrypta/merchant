/**
 * base64url, for signed events travelling in an Authorization header.
 *
 * Chunked rather than one `String.fromCharCode(...bytes)`: a signed event is
 * ~500 bytes today, but spreading a large array into a call blows the argument
 * limit, and this is shared by two auth schemes now (BUD-11 and NIP-98).
 */
export function base64UrlEncode(value: string): string {
  const bytes = new TextEncoder().encode(value)
  let binary = ""
  const chunkSize = 0x8000
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize))
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}
