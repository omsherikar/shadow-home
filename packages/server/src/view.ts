/**
 * The plan view, served as an MCP App resource. It's built from packages/views into one HTML
 * file; tool results carry display names for it under NAMES_META_KEY in `_meta`, and the approval
 * tokens for the plans it shows under APPROVAL_META_KEY.
 */
export {
  APPROVAL_META_KEY,
  NAMES_META_KEY,
  PLAN_VIEW_URI,
  planViewHtml,
  VIEW_MIME as PLAN_VIEW_MIME,
} from '@shadow-home/views';
