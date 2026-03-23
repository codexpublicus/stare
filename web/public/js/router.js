export function getHashParams() {
  const hash = window.location.hash.slice(1);
  if (!hash) return null;
  const parts = hash.replace(/\//g, ' ').split(/\s+/);
  if (parts.length !== 3) return null;
  const [reporter, volStr, pageStr] = parts;
  const volume = parseInt(volStr, 10);
  const page = parseInt(pageStr, 10);
  if (isNaN(volume) || isNaN(page)) return null;
  return { reporter: reporter.toLowerCase(), volume, page };
}

export function setHash(reporter, volume, page) {
  const newHash = `#${reporter}/${volume}/${page}`;
  if (window.location.hash !== newHash) {
    window.location.hash = newHash;
  }
}

export function onHashChange(callback) {
  window.addEventListener('hashchange', () => {
    const params = getHashParams();
    if (params) callback(params);
  });
}
