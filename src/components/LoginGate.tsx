export function LoginGate({ configured }: { configured: boolean }) {
  return (
    <main className="mx-auto flex max-w-lg flex-col items-center px-6 py-16 text-center sm:py-24">
      <p className="text-sm font-semibold uppercase tracking-wider text-amber-800">Coffee &amp; merch</p>
      <h2 className="mt-2 text-3xl font-bold tracking-tight text-stone-900">Sign in to shop</h2>
      <p className="mt-3 text-base leading-relaxed text-stone-600">
        BeanBox is open to signed-in shoppers. Log in to browse beans and merch, use your cart, and report a problem.
      </p>
      <a
        href="/auth/login"
        className="mt-8 rounded bg-amber-700 px-6 py-2.5 text-sm font-medium text-white hover:bg-amber-800"
      >
        Log in
      </a>
      <a href="/auth/login?screen_hint=signup" className="mt-4 text-sm text-stone-600 underline hover:text-stone-900">
        Create an account
      </a>
      {!configured && (
        <p className="mt-8 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-left text-sm leading-relaxed text-amber-950">
          Auth0 is not configured on this server yet. Add <code className="font-mono">AUTH0_DOMAIN</code>,{" "}
          <code className="font-mono">AUTH0_CLIENT_ID</code>, <code className="font-mono">AUTH0_CLIENT_SECRET</code>,{" "}
          <code className="font-mono">AUTH0_SECRET</code>, and <code className="font-mono">APP_BASE_URL</code> to{" "}
          <code className="font-mono">.env.local</code>, then restart <code className="font-mono">npm run dev</code>.
        </p>
      )}
    </main>
  );
}
