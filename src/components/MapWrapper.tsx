'use client';

// This Client Component is the correct place for dynamic() with ssr:false.
// Next.js App Router requires ssr:false to live inside a Client Component
// that is NOT the page itself — page Server Components can't use ssr:false.
import dynamic from 'next/dynamic';

const MapView = dynamic(() => import('./MapView'), {
  ssr: false,
  loading: () => (
    <div className="flex items-center justify-center w-full h-screen bg-gray-50">
      <div className="text-center space-y-3">
        <div className="w-8 h-8 border-4 border-blue-600 border-t-transparent rounded-full animate-spin mx-auto" />
        <p className="text-gray-500 text-sm">Chargement de la carte…</p>
      </div>
    </div>
  ),
});

export default function MapWrapper() {
  return <MapView />;
}
