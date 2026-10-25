/** "Your turn" signals outside the page itself: the tab icon and a buzz on phones. */

const BADGED_ICON =
  'data:image/svg+xml,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle cx="32" cy="32" r="30" fill="#c0392b"/>' +
      '<text x="32" y="40" font-size="22" font-family="Arial" font-weight="bold" fill="#fff" text-anchor="middle">R</text>' +
      '<circle cx="48" cy="16" r="15" fill="#f2b84b" stroke="#10161d" stroke-width="3"/></svg>',
  );

/** Puts a dot on the tab icon while it is your turn. */
export function badgeFavicon(on: boolean) {
  const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (!link) return;
  link.dataset.plain ??= link.href;
  link.href = on ? BADGED_ICON : link.dataset.plain;
}

/** A short vibration on phones that support it. */
export function buzz(pattern: number | number[] = [120, 60, 120]) {
  try {
    navigator.vibrate?.(pattern);
  } catch {
    /* not supported */
  }
}
