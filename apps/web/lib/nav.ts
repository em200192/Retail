/**
 * Full-page navigation (sign-out, expired session). The offline demo build
 * installs a handler so it can switch views without leaving the page.
 */
export function hardNavigate(url: string): void {
  const handler = (globalThis as { __counterNavigate?: (u: string) => void }).__counterNavigate;
  if (handler) handler(url);
  else window.location.href = url;
}
