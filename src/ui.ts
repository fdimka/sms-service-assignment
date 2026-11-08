import { readFileSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';

export function registerUi(app: FastifyInstance): void {
  // Fixed assets only: no request-supplied filesystem paths.
  for (const [route, file, type] of [
    ['/', 'index.html', 'text/html; charset=utf-8'],
    ['/app.js', 'app.js', 'text/javascript; charset=utf-8'],
    ['/styles.css', 'styles.css', 'text/css; charset=utf-8'],
  ]) {
    const content = readFileSync(new URL(`../../public/${file}`, import.meta.url), 'utf8');
    app.get(route!, async (_request, reply) => reply
      .header('cache-control', 'no-store')
      .header('x-content-type-options', 'nosniff')
      .header('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'")
      .type(type!).send(content));
  }
}
