/** Static shell only. The launch capability never appears in server-rendered HTML. */
export const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Weaver Scratchpads</title>
<link rel="stylesheet" href="/assets/app.css">
</head>
<body>
<div id="app"><p class="boot">Opening Weaver Scratchpads…</p></div>
<noscript>Weaver Scratchpads requires JavaScript.</noscript>
<script src="/assets/app.js" defer></script>
</body>
</html>`;
