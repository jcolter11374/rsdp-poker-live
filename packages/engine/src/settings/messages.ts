import { z } from 'zod';

const TYPE_NAMES: Record<string, string> = {
  number: 'a number',
  integer: 'a whole number',
  string: 'text',
  boolean: 'true or false',
  object: 'an object',
  array: 'a list',
};

const typeName = (t: string) => TYPE_NAMES[t] ?? t;

/**
 * Plain-English messages for the issues zod raises itself, so every settings
 * error reads the same way ("must be at most 10"). Messages a schema sets on
 * purpose are kept.
 */
export const settingsErrorMap: z.ZodErrorMap = (issue, ctx) => {
  switch (issue.code) {
    case z.ZodIssueCode.invalid_type:
      if (issue.received === 'undefined') return { message: 'required' };
      if (issue.expected === 'integer') return { message: 'must be a whole number' };
      return { message: `must be ${typeName(issue.expected)}, not ${issue.received}` };
    case z.ZodIssueCode.too_small:
      if (issue.type === 'number') return { message: `must be at least ${issue.minimum}` };
      if (issue.type === 'string') return { message: `must be at least ${issue.minimum} characters` };
      if (issue.type === 'array') return { message: `must have at least ${issue.minimum} items` };
      return { message: ctx.defaultError };
    case z.ZodIssueCode.too_big:
      if (issue.type === 'number') return { message: `must be at most ${issue.maximum}` };
      if (issue.type === 'string') return { message: `must be at most ${issue.maximum} characters` };
      if (issue.type === 'array') return { message: `must have at most ${issue.maximum} items` };
      return { message: ctx.defaultError };
    case z.ZodIssueCode.invalid_enum_value:
      return { message: `must be one of ${issue.options.map((o) => `'${String(o)}'`).join(', ')}` };
    default:
      return { message: ctx.defaultError };
  }
};
