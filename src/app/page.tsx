'use client';

// This is the main page of the app (the "/" route).
// It dynamically imports MapView with ssr: false, which means
// the map only loads in the browser — required for Mapbox + Capacitor.
import dynamic from 'next/dynamic';

const MapView = dynamic(() => import('@/components/MapView'), {
  ssr: false,
  loading: () => (
    <div className="flex items-center justify-center w-full h-screen bg-gray-50">
      <div className="text-center space-y-3">
        <div className="w-8 h-8 border-4 border-blue-600 border-t-transparent rounded-full animate-spin mx-auto" />
        <p className="text-gray-500 text-sm">Chargement de la carte...</p>
      </div>
    </div>
  ),
});

export default function Home() {
  return <MapView />;
}
