// @vitest-environment jsdom
import { render } from '@testing-library/react';
import { beforeAll, describe, expect, it } from 'vitest';
import { Dock } from './Dock';

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

const classes = (container: HTMLElement) => [...container.querySelector('.dock')!.classList];

describe('Dock: room for coach tips and the bots\' reasons (#476)', () => {
  it('keeps the room once made until reset changes, so a practice table turning into a real game does not grow back', () => {
    const { container, rerender } = render(
      <Dock reset="a" seated limit tips why>
        <div />
      </Dock>,
    );
    expect(classes(container)).toEqual(expect.arrayContaining(['tips', 'why']));
    // A friend is dealt in: the page no longer asks for the room, but it stays.
    rerender(
      <Dock reset="a" seated limit tips={false} why={false}>
        <div />
      </Dock>,
    );
    expect(classes(container)).toEqual(expect.arrayContaining(['tips', 'why']));
    // A new seat (or turning the phone) starts afresh.
    rerender(
      <Dock reset="b" seated limit tips={false} why={false}>
        <div />
      </Dock>,
    );
    expect(classes(container)).not.toContain('tips');
    expect(classes(container)).not.toContain('why');
  });

  it('makes the room as soon as it is asked for', () => {
    const { container, rerender } = render(
      <Dock reset="a" seated limit>
        <div />
      </Dock>,
    );
    expect(classes(container)).not.toContain('why');
    rerender(
      <Dock reset="a" seated limit why>
        <div />
      </Dock>,
    );
    expect(classes(container)).toContain('why');
  });
});
