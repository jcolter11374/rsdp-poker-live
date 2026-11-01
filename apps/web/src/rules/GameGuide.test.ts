import { defaultSettings } from '@rsdp/engine/settings';
import { RSDP_TABLE_RULES } from '@rsdp/tournament';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { GameGuide } from './GameGuide';

describe('GameGuide', () => {
  it("shows the time bank example with the table's own clock", () => {
    const t = defaultSettings('tournament');
    t.timing = { ...t.timing, decisionSeconds: RSDP_TABLE_RULES.decisionSeconds, timeBankSeconds: RSDP_TABLE_RULES.timeBankSeconds, timeBankRefillHands: RSDP_TABLE_RULES.timeBankRefillHands };
    const html = renderToStaticMarkup(createElement(GameGuide, { gameIds: ['nlhe'], extraIds: ['time-bank'], current: 'time-bank', settings: t }));
    expect(html).toContain(`This table: a ${RSDP_TABLE_RULES.decisionSeconds}-second clock and a ${RSDP_TABLE_RULES.timeBankSeconds}-second bank`);
    expect(html).toContain('aria-pressed="true">Time bank');
    // Away from a table (the /rules page), the cash table defaults.
    expect(renderToStaticMarkup(createElement(GameGuide, { current: 'time-bank' }))).toContain('A 30-second clock and a 30-second bank');
  });
});
