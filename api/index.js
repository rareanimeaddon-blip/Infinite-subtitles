// Vercel serverless entry point. vercel.json rewrites every request to
// /api/index?__path=<original path> — this restores the original path
// (Vercel rewrites hide it from req.url) and hands it to the shared
// handler in server.js. No code is duplicated here.
'use strict';

var handleRequest = require('../server.js').handleRequest;

module.exports = function (req, res) {
  try {
    var u = new URL(req.url, 'http://localhost');
    var orig = u.searchParams.get('__path');
    if (orig !== null && orig !== undefined) {
      // __path is the captured path without a leading slash.
      var p = '/' + String(orig);
      try { p = decodeURIComponent(p); } catch (e) { /* keep as-is */ }
      req.url = p;
    }
    handleRequest(req, res);
  } catch (e) {
    try {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ subtitles: [] }));
    } catch (e2) { /* ignore */ }
  }
};
