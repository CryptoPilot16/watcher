import { ImageResponse } from 'next/og';

export const runtime = 'edge';

export const size = {
  width: 1200,
  height: 630,
};

export const contentType = 'image/png';

export async function GET() {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          padding: 64,
          color: '#f0ece0',
          background:
            'radial-gradient(circle at top, rgba(236,213,141,0.22), transparent 30%), linear-gradient(180deg, #0f0d09 0%, #15110c 52%, #0c0a07 100%)',
          fontFamily: 'JetBrains Mono, ui-monospace, SFMono-Regular, monospace',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              padding: '10px 16px',
              borderRadius: 14,
              border: '1px solid rgba(214, 189, 111, 0.28)',
              background: 'rgba(15, 13, 9, 0.72)',
              color: '#ecd58d',
              fontSize: 18,
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
            }}
          >
            live ops surface
          </div>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 96,
              height: 96,
              borderRadius: 24,
              border: '1px solid rgba(214, 189, 111, 0.28)',
              background: 'rgba(19, 16, 11, 0.92)',
              color: '#ecd58d',
              fontSize: 42,
              fontWeight: 700,
            }}
          >
            W
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 18, maxWidth: 820 }}>
          <div style={{ fontSize: 88, lineHeight: 0.95, fontWeight: 700, color: '#ffffff' }}>Watcher</div>
          <div style={{ fontSize: 30, lineHeight: 1.35, color: 'rgba(230, 220, 185, 0.82)' }}>
            Mission control for live OpenClaw agent teams. Read the floor, inspect service health, and jump into the dashboard when something needs attention.
          </div>
        </div>

        <div style={{ display: 'flex', gap: 18 }}>
          {['Live session feed', 'Office-floor visibility', 'Lane control + health'].map((item) => (
            <div
              key={item}
              style={{
                flex: 1,
                padding: '18px 20px',
                borderRadius: 16,
                border: '1px solid rgba(214, 189, 111, 0.2)',
                background: 'rgba(24, 20, 14, 0.9)',
                fontSize: 22,
                color: '#f0ece0',
              }}
            >
              {item}
            </div>
          ))}
        </div>
      </div>
    ),
    size,
  );
}
