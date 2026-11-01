import type { z } from 'zod';

const TYPE_NAMES: Record<string, string> = {
  number: 'a number',
  string: 'text',
  boolean: 'true or false',
  object: 'an object',
  record: 'an object',
  array: 'a list',
};

const typeName = (t: string) => TYPE_NAMES[t] ?? t;

/** What a value is, in the words these messages have always used ("nan", "array", "null"...). */
function received(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number' && Number.isNaN(value)) return 'nan';
  if (value instanceof Date) return 'date';
  return typeof value;
}

const quote = (v: unknown) => (typeof v === 'string' ? `'${v}'` : String(v));

/**
 * Plain-English messages for the issues zod raises itself, so every settings
 * error reads the same way ("must be at most 10"). Messages a schema sets on
 * purpose are kept: zod only asks this map when the schema didn't set one.
 */
export const settingsErrorMap: z.ZodErrorMap = (issue) => {
  const { input } = issue;
  switch (issue.code) {
    case 'invalid_type':
      if (input === undefined) return 'required';
      if (issue.expected === 'int') return 'must be a whole number';
      // zod refuses Infinity (and -Infinity) as a number.
      if (issue.expected === 'number' && typeof input === 'number' && !Number.isNaN(input)) {
        return 'must be a number, not infinity';
      }
      return `must be ${typeName(issue.expected)}, not ${received(input)}`;
    case 'too_small':
      if (issue.origin === 'number' || issue.origin === 'int') return `must be at least ${issue.minimum}`;
      if (issue.origin === 'string') return `must be at least ${issue.minimum} characters`;
      if (issue.origin === 'array') return `must have at least ${issue.minimum} items`;
      return undefined;
    case 'too_big':
      if (issue.origin === 'number' || issue.origin === 'int') return `must be at most ${issue.maximum}`;
      if (issue.origin === 'string') return `must be at most ${issue.maximum} characters`;
      if (issue.origin === 'array') return `must have at most ${issue.maximum} items`;
      return undefined;
    case 'invalid_value':
      if (input === undefined) return 'required';
      // A list of words given something that isn't text: name its type, as for any other wrong type.
      if (typeof input !== 'string' && issue.values.every((v) => typeof v === 'string')) {
        return `must be ${issue.values.map(quote).join(' | ')}, not ${received(input)}`;
      }
      return `must be one of ${issue.values.map(quote).join(', ')}`;
    default:
      return undefined;
  }
};
