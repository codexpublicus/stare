// The stare-pub Worker's script, for requests that match no file only (#283, D147).
//
// Everything stare.pub serves is a static asset (wrangler.jsonc, web/dist). A browser
// navigation (`Sec-Fetch-Mode: navigate`) to a path no file matches gets the reader,
// index.html, from the single-page-application fallback without this script running:
// that's how /k/<key>/ and /c/.../ open. Any other request no file matches (a crawler, a
// script, a fetch for a file that isn't there) comes here, and gets the 404 it got before
// the fallback. Real files always win: this never runs for a path a file matches.
export default {
  fetch() {
    return new Response('Not found\n', {
      status: 404,
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'public, max-age=0, must-revalidate',
      },
    });
  },
};
