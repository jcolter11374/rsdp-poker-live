// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NotifyState } from '../notify';

// The toggle reaches the browser's alerts only through notify.ts: a stand-in here that the tests set.
const alerts = vi.hoisted(() => ({
  state: 'off' as NotifyState,
  push: true,
  listeners: new Set<() => void>(),
  enable: vi.fn(),
  disable: vi.fn(),
}));
vi.mock('../notify', async () => {
  const { useSyncExternalStore } = await import('react');
  const set = (s: NotifyState) => {
    alerts.state = s;
    alerts.listeners.forEach((cb) => cb());
  };
  alerts.enable.mockImplementation(async () => (set('on'), 'on'));
  alerts.disable.mockImplementation(() => set('off'));
  return {
    useNotifyState: () =>
      useSyncExternalStore(
        (cb) => (alerts.listeners.add(cb), () => alerts.listeners.delete(cb)),
        () => alerts.state,
      ),
    enableNotifications: alerts.enable,
    disableNotifications: alerts.disable,
    usePushAvailable: () => alerts.push,
    notify: () => {},
    syncPush: async () => false,
  };
});
vi.mock('../socket', () => ({ socket: { on: () => {}, off: () => {}, emit: () => {} } }));
vi.mock('./client', () => ({ tournamentClient: () => ({ list: async () => ({ tournaments: [], serverNow: Date.now() }) }) }));

const { AlertsToggle } = await import('./TournamentAlerts');

beforeEach(() => {
  alerts.state = 'off';
  alerts.push = true;
  alerts.enable.mockClear();
  alerts.disable.mockClear();
});

describe('the alerts button', () => {
  it('turns alerts on and off, and says they reach the device with the site closed where push works', async () => {
    render(<AlertsToggle />);
    const button = screen.getByRole('button', { name: /turn on alerts/i });
    expect(button.getAttribute('title')).toMatch(/even with the site closed/);
    await act(async () => fireEvent.click(button));
    expect(alerts.enable).toHaveBeenCalledOnce();
    const on = screen.getByRole('button', { name: /alerts on/i });
    expect(on.getAttribute('aria-pressed')).toBe('true');
    await act(async () => fireEvent.click(on));
    expect(alerts.disable).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: /turn on alerts/i })).toBeTruthy();
  });

  it('says only "while this tab is in the background" where the browser has no push', () => {
    alerts.push = false;
    render(<AlertsToggle />);
    expect(screen.getByRole('button', { name: /turn on alerts/i }).getAttribute('title')).toMatch(/while this tab is in the background/);
  });

  it('tells an iPhone plainly to add the site to the home screen first', async () => {
    alerts.state = 'install';
    render(<AlertsToggle quietWhenBlocked />);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: /turn on alerts/i })));
    expect(alerts.enable).not.toHaveBeenCalled();
    expect(screen.getByRole('status').textContent).toMatch(/alerts work only once the site is on your home screen.*Share.*Add to Home Screen/);
  });

  it('shows nothing where alerts are not possible, and says when the browser blocked them', () => {
    alerts.state = 'unsupported';
    const { container, rerender } = render(<AlertsToggle />);
    expect(container.textContent).toBe('');
    alerts.state = 'denied';
    rerender(<AlertsToggle quietWhenBlocked />);
    expect(container.textContent).toBe('');
    rerender(<AlertsToggle />);
    expect(container.textContent).toMatch(/blocked by the browser/);
  });
});
