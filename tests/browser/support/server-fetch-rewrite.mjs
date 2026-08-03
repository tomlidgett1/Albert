const productionSupabaseOrigin = "https://abcdefghijklmnopqrst.supabase.co";
const localAuthOrigin = "http://127.0.0.1:55431";
const platformFetch = globalThis.fetch.bind(globalThis);

function rewrittenUrl(input) {
  const value = input instanceof Request ? input.url : String(input);
  const url = new URL(value);
  if (url.origin !== productionSupabaseOrigin || !url.pathname.startsWith("/auth/v1/")) {
    return null;
  }
  return `${localAuthOrigin}${url.pathname}${url.search}`;
}

globalThis.fetch = (input, init) => {
  const replacement = rewrittenUrl(input);
  if (!replacement) return platformFetch(input, init);
  if (input instanceof Request) {
    return platformFetch(new Request(replacement, input), init);
  }
  return platformFetch(replacement, init);
};
