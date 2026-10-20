import { z } from 'zod';
import { fits, MAX_HISTORY, MAX_TEXT } from './bounds.ts';
import type { Names } from './types.ts';

/** What the browser sends for one turn, within the bounds in bounds.ts. */
export const turnRequest = z.object({
  text: z.string().min(1).max(MAX_TEXT),
  history: z
    .array(
      z.object({
        name: z.string(),
        arguments: z.record(z.string(), z.unknown()),
        structuredContent: z.record(z.string(), z.unknown()).optional(),
        by: z.literal('screen').optional(),
      }),
    )
    .max(50)
    .refine(fits(MAX_HISTORY)),
  names: z
    .custom<Names>((v) => v === undefined || (typeof v === 'object' && v !== null))
    .optional(),
  screen: z.string().max(2000).optional(),
});
