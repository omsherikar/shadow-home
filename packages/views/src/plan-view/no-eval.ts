import { z } from 'zod';

/**
 * zod tries `new Function` when it builds its first object schema, to see whether it may compile
 * faster parsers. A host's content policy refuses it; zod catches that and parses without, but the
 * browser still reports a policy violation. The app bridge turns compiling off only once a view
 * starts, after its schemas are built, so this module does it first, before anything else loads.
 */
z.config({ jitless: true });
