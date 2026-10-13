/**
 * The plan view, served as an MCP App resource. This is a minimal stand-in that shows the
 * verdict, the headline and the diff rows; packages/views replaces it with the full diff and
 * timeline view.
 */
export const PLAN_VIEW_URI = 'ui://shadow-home/plan-view.html';
export const PLAN_VIEW_MIME = 'text/html;profile=mcp-app';

export const PLAN_VIEW_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Plan check</title>
<style>
  body { font: 20px/1.4 system-ui, sans-serif; margin: 16px; color: #111; }
  .verdict { font-size: 28px; font-weight: 700; }
  .SAFE { color: #116b2f; } .UNSAFE { color: #a3121b; } .UNPROVEN { color: #8a5a00; }
  table { border-collapse: collapse; margin-top: 12px; }
  td { padding: 4px 12px 4px 0; }
</style>
</head>
<body>
<div id="verdict" class="verdict">Waiting for a plan…</div>
<div id="headline"></div>
<table id="diff"></table>
<script>
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => '&#' + c.charCodeAt(0) + ';');
  const show = (r) => {
    if (!r || !r.verdict) return;
    const v = document.getElementById('verdict');
    v.textContent = r.verdict + ' · ' + r.tier;
    v.className = 'verdict ' + r.verdict;
    document.getElementById('headline').textContent = r.speech ? r.speech.headline : '';
    const rows = (r.diff || []).slice(0, 5).map((d) =>
      '<tr><td>' + esc(d.name) + '</td><td>' + esc(d.from) + ' → ' + esc(d.to) + '</td></tr>');
    document.getElementById('diff').innerHTML = rows.join('');
  };
  window.addEventListener('message', (e) => {
    const m = e.data;
    if (m && m.method === 'ui/notifications/tool-result') {
      const sc = m.params && m.params.structuredContent;
      show(sc && sc.preview ? sc.preview : sc);
    }
  });
</script>
</body>
</html>
`;
