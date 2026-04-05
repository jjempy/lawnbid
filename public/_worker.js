export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // Serve app for /app routes
    if (path === '/app' || path.startsWith('/app/') || path.startsWith('/app?')) {
      const appUrl = new URL(request.url);
      appUrl.pathname = '/index.html';
      return env.ASSETS.fetch(appUrl.toString());
    }

    // Serve landing page at root
    if (path === '/' || path === '') {
      const landingUrl = new URL(request.url);
      landingUrl.pathname = '/landing.html';
      return env.ASSETS.fetch(landingUrl.toString());
    }

    // Everything else — serve as static asset
    return env.ASSETS.fetch(request);
  }
}
