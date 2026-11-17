// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyStarter, defaultSettings } from '@rsdp/tournament';
import { TournamentCreate } from './TournamentCreate';

vi.mock('./hooks', () => ({ useSession: () => ({ playerId: 'p1', displayName: 'Host', token: 't' }) }));
vi.mock('../socket', () => ({ call: vi.fn(() => new Promise(() => {})), socket: { on: vi.fn(), off: vi.fn(), emit: vi.fn(), connected: false }, savedName: () => '' }));
vi.mock('../components/SiteHeader', () => ({ SiteHeader: () => null }));
vi.mock('./structures', () => ({
  tournamentStructures: { use: () => [], useOnAccount: () => false, ready: () => true },
  saveStructure: vi.fn(),
  structureSettings: vi.fn(),
}));

afterEach(cleanup);

/** The number box labelled `label` inside the option whose tick box is `option`. */
const chipsOf = (option: RegExp) => {
  const box = screen.getByRole('checkbox', { name: option }).closest('.tn-option') as HTMLElement;
  return within(box).getByLabelText(/^Chips/) as HTMLInputElement;
};
const stack = () => screen.getByLabelText(/^Starting stack/) as HTMLInputElement;

describe('rebuy and add-on chips on the New tournament form (#490)', () => {
  it('a new starting stack is the size of a rebuy and an add-on ticked afterwards', () => {
    render(<TournamentCreate onCreated={() => {}} />);
    expect(stack().value).toBe('63000');
    fireEvent.change(stack(), { target: { value: '1500' } });
    fireEvent.click(screen.getByRole('checkbox', { name: /^Rebuys \(on levels/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: /^Add-ons \(on breaks/ }));
    expect(chipsOf(/^Rebuys \(on levels/).value).toBe('1500');
    expect(chipsOf(/^Add-ons \(on breaks/).value).toBe('1500');
  });

  it('keeps following a stack changed after rebuys were ticked, but leaves a size the host typed alone', () => {
    render(<TournamentCreate onCreated={() => {}} />);
    fireEvent.click(screen.getByRole('checkbox', { name: /^Rebuys \(on levels/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: /^Add-ons \(on breaks/ }));
    fireEvent.change(chipsOf(/^Add-ons \(on breaks/), { target: { value: '2000' } });
    // Typed a digit at a time, as a host would: the stack passes through the add-on's 2,000 on its way to 20,000.
    for (const value of ['2', '20', '200', '2000', '20000']) fireEvent.change(stack(), { target: { value } });
    expect(chipsOf(/^Rebuys \(on levels/).value).toBe('20000');
    expect(chipsOf(/^Add-ons \(on breaks/).value).toBe('2000');
  });

  it('a copy made with rebuys off takes the stack when rebuys are ticked, and a copy with its own size keeps it', () => {
    // As saved before the fix: a 1,500 stack with rebuys off, and 63,000 left behind in the size.
    const rsdp = applyStarter(defaultSettings({ name: 'Copy' }), 'rsdp');
    const off = { ...rsdp, startingStack: 1_500 };
    const first = render(<TournamentCreate onCreated={() => {}} initial={off} />);
    fireEvent.click(screen.getByRole('checkbox', { name: /^Rebuys \(on levels/ }));
    expect(chipsOf(/^Rebuys \(on levels/).value).toBe('1500');
    first.unmount();
    render(<TournamentCreate onCreated={() => {}} initial={{ ...off, rebuy: { ...off.rebuy, max: 2, chips: 3_000 } }} />);
    fireEvent.change(stack(), { target: { value: '4000' } });
    expect(chipsOf(/^Rebuys \(on levels/).value).toBe('3000');
  });
});
