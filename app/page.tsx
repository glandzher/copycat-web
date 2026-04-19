import Link from 'next/link'

export default function Home() {
  return (
    <main className="min-h-screen flex flex-col">
      {/* Nav */}
      <nav className="flex items-center justify-between px-8 py-5 border-b border-gray-100">
        <span className="text-xl font-bold tracking-tight text-brand-600">Copycat</span>
        <div className="flex items-center gap-4">
          <Link href="/login" className="text-sm text-gray-600 hover:text-gray-900 font-medium">
            Sign in
          </Link>
          <Link
            href="/dashboard"
            className="text-sm bg-brand-600 hover:bg-brand-700 text-white font-semibold px-4 py-2 rounded-lg transition-colors"
          >
            Open dashboard →
          </Link>
        </div>
      </nav>

      {/* Hero */}
      <section className="flex-1 flex flex-col items-center justify-center text-center px-6 py-24 gap-8">
        <div className="inline-flex items-center gap-2 bg-brand-50 text-brand-700 text-xs font-semibold px-3 py-1.5 rounded-full border border-brand-100">
          Chrome Extension + Web Platform
        </div>
        <h1 className="text-5xl md:text-6xl font-extrabold tracking-tight leading-tight max-w-3xl">
          Record once.<br />
          <span className="text-brand-600">Share instantly.</span>
        </h1>
        <p className="text-lg text-gray-500 max-w-xl leading-relaxed">
          Copycat captures your screen, webcam, and actions — turning them into
          polished step-by-step guides and shareable videos stored in your own Google Drive.
          Zero storage costs, forever.
        </p>
        <div className="flex flex-col sm:flex-row items-center gap-3">
          <a
            href="https://chrome.google.com/webstore"
            className="bg-brand-600 hover:bg-brand-700 text-white font-semibold px-6 py-3 rounded-xl transition-colors text-sm shadow-sm"
          >
            Add to Chrome — it&apos;s free
          </a>
          <Link
            href="/dashboard"
            className="text-sm font-semibold text-gray-700 hover:text-brand-600 px-6 py-3 rounded-xl border border-gray-200 hover:border-brand-200 transition-colors"
          >
            View my recordings
          </Link>
        </div>
      </section>

      {/* Features */}
      <section className="grid grid-cols-1 md:grid-cols-3 gap-6 px-8 pb-24 max-w-5xl mx-auto w-full">
        {[
          {
            icon: '🎬',
            title: 'Screen + Webcam',
            body: 'Record your browser tab or full screen with a floating webcam bubble. Drag it anywhere — it moves in the video too.',
          },
          {
            icon: '📋',
            title: 'Step-by-step guides',
            body: 'Every click, scroll, and keystroke is captured as an annotated screenshot. Export as a polished PDF guide.',
          },
          {
            icon: '☁️',
            title: 'Your Drive, your data',
            body: 'Videos and guides save to your own Google Drive. No subscriptions, no storage limits imposed by us.',
          },
        ].map(f => (
          <div key={f.title} className="bg-gray-50 rounded-2xl p-6 flex flex-col gap-3">
            <span className="text-3xl">{f.icon}</span>
            <h3 className="font-semibold text-gray-900">{f.title}</h3>
            <p className="text-sm text-gray-500 leading-relaxed">{f.body}</p>
          </div>
        ))}
      </section>

      {/* Footer */}
      <footer className="border-t border-gray-100 py-6 text-center text-xs text-gray-400">
        © {new Date().getFullYear()} Copycat. Built with ♥ and zero server costs.
      </footer>
    </main>
  )
}
