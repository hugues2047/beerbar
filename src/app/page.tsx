// Server Component — no 'use client' here.
// We import a thin client wrapper that handles ssr:false for Mapbox.
import MapWrapper from '@/components/MapWrapper';

export default function Home() {
  return <MapWrapper />;
}
