// @vitest-environment jsdom
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { pageTitle, usePageTitle } from './pageTitle';

function Page({ name }: { name: string | null }) {
  usePageTitle(name);
  return null;
}

describe("the tab's title", () => {
  it("names the page first, and goes back to the site's name when the page goes", () => {
    const { rerender, unmount } = render(<Page name={null} />);
    expect(document.title).toBe('RSDP Live!');
    rerender(<Page name="Friday game" />);
    expect(document.title).toBe('Friday game · RSDP Live!');
    expect(pageTitle()).toBe('Friday game · RSDP Live!');
    unmount();
    expect(document.title).toBe('RSDP Live!');
    expect(pageTitle()).toBe('RSDP Live!');
  });
});
