import Link from 'next/link';

export default function HomePage() {
  return (
    <main
      style={{
        minHeight: '100dvh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '24px 16px',
      }}
    >
      <section
        style={{
          width: '100%',
          maxWidth: 420,
          overflow: 'hidden',
          borderRadius: 12,
          border: '1px solid rgba(214,189,111,0.38)',
          background: 'linear-gradient(180deg, rgba(27,22,15,0.97), rgba(18,15,11,0.97))',
          boxShadow: '0 8px 32px rgba(0,0,0,0.32)',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            padding: '14px 20px',
            borderBottom: '1px solid rgba(214,189,111,0.22)',
          }}
        >
          <img
            src="/watch-logo.png?v=20260518f"
            alt="WATCHER"
            style={{ width: 32, height: 32, borderRadius: 6, flexShrink: 0 }}
          />
          <div
            style={{
              fontSize: 14,
              fontWeight: 600,
              letterSpacing: '0.12em',
              textTransform: 'uppercase',
              color: '#f0ece0',
            }}
          >
            WATCHER
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 20, padding: 20 }}>
          <div
            style={{
              fontSize: 10,
              letterSpacing: '0.3em',
              textTransform: 'uppercase',
              color: '#ecd58d',
            }}
          >
            choose destination
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <Link
              href="/login?redirect=/watch"
              style={{
                display: 'block',
                borderRadius: 8,
                border: '1px solid rgba(214,189,111,0.38)',
                background: 'rgba(212,186,104,0.14)',
                padding: '14px 16px',
                fontSize: 12,
                fontWeight: 600,
                letterSpacing: '0.15em',
                textTransform: 'uppercase',
                color: '#f0ece0',
                textAlign: 'center',
                textDecoration: 'none',
              }}
            >
              Watcher dashboard
            </Link>
            <Link
              href="/axiom/login"
              style={{
                display: 'block',
                borderRadius: 8,
                border: '1px solid rgba(214,189,111,0.22)',
                background: 'rgba(0,0,0,0.22)',
                padding: '14px 16px',
                fontSize: 12,
                fontWeight: 600,
                letterSpacing: '0.15em',
                textTransform: 'uppercase',
                color: '#f0ece0',
                textAlign: 'center',
                textDecoration: 'none',
              }}
            >
              Axiom admin
            </Link>
          </div>
        </div>
      </section>
    </main>
  );
}
