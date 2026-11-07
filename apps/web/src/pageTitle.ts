import { useEffect } from 'react';

export const SITE_TITLE = 'RSDP Live!';

let base = SITE_TITLE;

/** The tab's title as the page on screen has it (the turn alert flashes in its place, then puts this back). */
export const pageTitle = () => base;

/**
 * The browser tab's title: the page's own name first (a table's, an event's, an account page's), so someone with a
 * few tables open can tell the tabs apart and a screen reader names the page (WCAG 2.4.2). The site's own name
 * again once the page goes.
 */
export function usePageTitle(name: string | null | undefined) {
  useEffect(() => {
    base = name ? `${name} · ${SITE_TITLE}` : SITE_TITLE;
    document.title = base;
    return () => {
      base = SITE_TITLE;
      document.title = base;
    };
  }, [name]);
}
