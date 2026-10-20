// /robots.txt, rendered at build time from the curated case list (#171, D44).
// A static file in dist/ like any other; _headers gives its Content-Type.
import { curatedSet, renderRobots } from '../lib/robots.js';
import curated from '../data/curated.json';

export function GET() {
  return new Response(renderRobots(curatedSet(curated)), {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}
