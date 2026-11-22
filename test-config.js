// Test the per-user config flow: start the server with NO key env vars,
// build a config from the gist keys (in-memory only, like a user typing
// them on the landing page), and confirm the configured manifest link
// returns subtitles. Prints counts only — never key values.
'use strict';
delete process.env.SUBDL_API_KEY;
delete process.env.SUBDL_API_KEY2;
delete process.env.WYZIE_API_KEY;
delete process.env.WYZIE_API_KEY2;
process.env.PORT = '3458';
var GIST = 'https://gist.githubusercontent.com/rareanimeaddon-blip/6fc363ac74cb8921d61c07a2c6bb59d6/raw/gistfile1.txt';
function b64url(str) {
  return Buffer.from(str, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
var http = require('http');
var handleRequest = require('./server.js').handleRequest;
var srv = http.createServer(handleRequest);
srv.listen(3458);
(async function () {
  await new Promise(function (res) { setTimeout(res, 800); });
  var base = 'http://localhost:3458';
  // Landing page loads and has the key form.
  var landing = await (await fetch(base + '/')).text();
  console.log('landing page has key form:', landing.indexOf('SubDL API key') !== -1 && landing.indexOf('Get my manifest link') !== -1);
  // Plain manifest loads, configurable.
  var m = await (await fetch(base + '/manifest.json')).json();
  console.log('manifest:', m.id, m.version, 'configurable:', !!(m.behaviorHints && m.behaviorHints.configurable));
  // Build a config the way the landing page does (from the gist keys).
  var t = await (await fetch(GIST)).json();
  var cfg = b64url(JSON.stringify({ s: t.subdlApiKey, s2: t.subdlApiKey2, w: t.wyzieApiKey, w2: t.wyzieApiKey2 }));
  // Configured manifest loads.
  var mc = await (await fetch(base + '/' + cfg + '/manifest.json')).json();
  console.log('config manifest:', mc.id, mc.version);
  // Configured subtitles (PHM + BB S1E1) use the config keys.
  var tests = [
    ['movie', 'tt12042730', 'PHM (config)'],
    ['series', 'tt0903747:1:1', 'BB S1E1 (config)']
  ];
  for (var i = 0; i < tests.length; i++) {
    var x = tests[i];
    var j = await (await fetch(base + '/' + cfg + '/subtitles/' + x[0] + '/' + x[1] + '.json')).json();
    var subs = j.subtitles || [];
    console.log(x[2] + ': ' + subs.length + ' subtitles, first: ' + (subs[0] ? (subs[0].movieReleaseName || '').slice(0, 50) : 'none'));
    var leaked = subs.some(function (s) { return s.url.indexOf('api_key=') !== -1; });
    console.log('  api_key in urls: ' + leaked);
  }
  // Plain (no config, no env) still works with mirror + Sunsync only.
  var jp = await (await fetch(base + '/subtitles/movie/tt12042730.json')).json();
  console.log('PHM (no config): ' + (jp.subtitles || []).length + ' subtitles');
  process.exit(0);
})().catch(function (e) { console.error('test failed:', e && e.message); process.exit(1); });
