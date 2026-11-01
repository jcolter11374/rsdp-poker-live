import { describe, expect, it, vi } from 'vitest';

vi.mock('./socket', () => ({ socket: { on: () => {} } }));
const { buildName, errorReport, reportGate, routePattern } = await import('./reportError');

describe('reporting what broke in the browser', () => {
  it('names the kind of page, never its address', () => {
    expect(routePattern('/t/Xy3_k9-Qa1')).toBe('/t/:id');
    expect(routePattern('/t/Xy3_k9-Qa1/')).toBe('/t/:id');
    expect(routePattern('/tn/AbCdEfGhIjKlMnOpQrStU')).toBe('/tn/:id');
    expect(routePattern('/tn/new')).toBe('/tn/new');
    expect(routePattern('/h/s3cr3tHandLink0123456789')).toBe('/h/:id');
    expect(routePattern('/season/AbC-123')).toBe('/season/:id');
    expect(routePattern('/rules/omaha')).toBe('/rules/:game');
    expect(routePattern('/')).toBe('/');
    expect(routePattern('/rules')).toBe('/rules');
    expect(routePattern('/whats-new/')).toBe('/whats-new');
    expect(routePattern('/roadmap/admin')).toBe('/roadmap/admin');
    expect(routePattern('/auth/done')).toBe('/auth/done');
    // Anything else (a mistyped link, which shows the home page) could hold anything: no part of it is kept.
    expect(routePattern('/Xy3_k9-Qa1')).toBe('/*');
    expect(routePattern('/about/Xy3_k9')).toBe('/*');
  });

  it('sends each different error once, and only the first few of a page load', () => {
    const gate = reportGate(3);
    expect(gate('error', 'a')).toBe(true);
    expect(gate('rejection', 'a')).toBe(false);
    expect(gate('error', 'b')).toBe(true);
    expect(gate('part', 'c')).toBe(true);
    expect(gate('error', 'd')).toBe(false);
    expect(gate('error', 'a')).toBe(false);
    // The page crashing is still sent after all that, even if the same error came before, but only once.
    expect(gate('crash', 'a')).toBe(true);
    expect(gate('crash', 'e')).toBe(false);
  });

  it('sends the error, its stack cut short, the kind of page and the build', () => {
    const error = new TypeError('seat is undefined');
    error.stack = `TypeError: seat is undefined\n${'    at f (https://x.test/assets/index-AbC123.js:1:2)\n'.repeat(100)}`;
    const report = errorReport(error, 'crash', '/t/Xy3_k9-Qa1', '/assets/index-AbC123.js');
    expect(report).toMatchObject({ message: 'TypeError: seat is undefined', route: '/t/:id', build: '/assets/index-AbC123.js', kind: 'crash' });
    expect(report.stack.startsWith('TypeError: seat is undefined\n    at f')).toBe(true);
    expect(report.stack.length).toBe(2_000);
    expect(JSON.stringify(report)).not.toContain('Xy3_k9');
    expect(errorReport(new Error('x'.repeat(1_000)), 'error', '/', null).message.length).toBe(300);
  });

  it('copes with whatever was thrown, without throwing itself', () => {
    expect(errorReport('lost connection', 'rejection', '/', null)).toMatchObject({ message: 'lost connection', stack: '' });
    expect(errorReport(undefined, 'rejection', '/', null).message).toBe('undefined');
    expect(errorReport({ secret: 'not sent' }, 'rejection', '/', null).message).toBe('[object Object]');
    const nasty = { toString: () => { throw new Error('no'); } };
    expect(errorReport(nasty, 'rejection', '/', null).message).toBe('something that is not an error');
    const odd = new Error('odd');
    Object.defineProperty(odd, 'stack', { get: () => { throw new Error('no'); } });
    expect(errorReport(odd, 'error', '/', null)).toMatchObject({ message: 'Error: odd', stack: '' });
  });

  it('shows the build as the name of its entry script', () => {
    expect(buildName('/assets/index-AbC123.js')).toBe('index-AbC123');
    expect(buildName(null)).toBeNull();
  });
});
