import { z } from 'zod';

/**
 * zod tries `new Function` when it builds its first object schema, to see whether it may compile
 * faster parsers. The page's content policy refuses it; zod catches that and parses without, but
 * the browser still reports a policy violation. Turning compiling off first skips the try, so this
 * module is imported before anything that builds a schema (the MCP client, the app bridge).
 */
z.config({ jitless: true });
