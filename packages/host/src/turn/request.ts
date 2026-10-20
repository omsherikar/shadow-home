import { z } from 'zod';
import type { Names } from './types.ts';

export const turnRequest = z.object({
  text: z.string().min(1).max(500),
  history: z
    .array(
      z.object({
        name: z.string(),
        arguments: z.record(z.string(), z.unknown()),
        structuredContent: z.record(z.string(), z.unknown()).optional(),
        by: z.literal('screen').optional(),
      }),
    )
    .max(50),
  names: z
    .custom<Names>((v) => v === undefined || (typeof v === 'object' && v !== null))
    .optional(),
  screen: z.string().max(2000).optional(),
});
