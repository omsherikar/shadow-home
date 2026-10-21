/**
 * The plan view, served as an MCP App resource. It's built from packages/views into one HTML
 * file; tool results carry display names for it under NAMES_META_KEY in `_meta`, the approval
 * tokens for the plans it shows under APPROVAL_META_KEY, their temperature traces under
 * TEMPERATURES_META_KEY, the temperature rules they're drawn against under
 * TEMPERATURE_RULES_META_KEY, and under REPLAY_META_KEY who each check took to be home, with
 * the runs of the repairs they offer.
 */
export {
  APPROVAL_META_KEY,
  NAMES_META_KEY,
  PLAN_VIEW_URI,
  planViewHtml,
  REPLAY_META_KEY,
  TEMPERATURE_RULES_META_KEY,
  TEMPERATURES_META_KEY,
  VIEW_MIME as PLAN_VIEW_MIME,
} from '@shadow-home/views';
