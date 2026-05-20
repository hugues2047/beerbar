'use client';

import { useEffect, useRef, useState, useMemo } from 'react';
import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';
import { supabase, type Bar } from '@/lib/supabase';

function getDistanceMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(a));
}

function getPriceColor(price: number): string {
  if (price === 0) return '#9CA3AF';
  if (price < 5)   return '#22C55E';
  if (price <= 8)  return '#F97316';
  return '#EF4444';
}

function formatPrice(price: number): string {
  if (price === 0) return 'Prix inconnu';
  return `${price.toFixed(2)} €`;
}

type SuggestionPriceMax = 4 | 5 | null;

type RouteInfo = {
  minutes: number;
  distance: number;
  barName: string;
  lat: number;
  lng: number;
};

export default function MapView() {
  const mapContainer = useRef<HTMLDivElement>(null);
  const map = useRef<mapboxgl.Map | null>(null);

  const [bars, setBars] = useState<Bar[]>([]);
  const [selectedBar, setSelectedBar] = useState<Bar | null>(null);
  const [showPriceForm, setShowPriceForm] = useState(false);
  const [priceInput, setPriceInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [priceFilter, setPriceFilter] = useState<'all' | 'under4' | 'under5' | 'under6'>('all');

  const [userLocation, setUserLocation] = useState<{ lat: number; lng: number } | null>(null);
  const [suggestion, setSuggestion] = useState<(Bar & { distance: number }) | null>(null);
  const [suggestionDismissed, setSuggestionDismissed] = useState(false);
  const [suggestionPriceMax, setSuggestionPriceMax] = useState<SuggestionPriceMax>(4);

  const [routeInfo, setRouteInfo] = useState<RouteInfo | null>(null);
  const [legendOpen, setLegendOpen] = useState(false);

  const filteredBars = useMemo(() => {
    return bars.filter(bar => {
      if (searchQuery && !bar.name.toLowerCase().includes(searchQuery.toLowerCase())) return false;
      if (priceFilter === 'under4') return bar.beer_price > 0 && bar.beer_price < 4;
      if (priceFilter === 'under5') return bar.beer_price > 0 && bar.beer_price < 5;
      if (priceFilter === 'under6') return bar.beer_price > 0 && bar.beer_price < 6;
      return true;
    });
  }, [bars, searchQuery, priceFilter]);

  const isFiltered = priceFilter !== 'all' || !!searchQuery;

  // Load all bars from Supabase
  useEffect(() => {
    async function loadBars() {
      const { count } = await supabase
        .from('bars')
        .select('*', { count: 'exact', head: true })
        .or('serves_beer.eq.true,serves_beer.is.null');
      if (!count) return;
      const batchSize = 1000;
      const numBatches = Math.ceil(count / batchSize);
      const requests = Array.from({ length: numBatches }, (_, i) =>
        supabase
          .from('bars')
          .select('id,name,address,latitude,longitude,beer_price,phone,last_updated')
          .or('serves_beer.eq.true,serves_beer.is.null')
          .range(i * batchSize, (i + 1) * batchSize - 1)
      );
      const results = await Promise.all(requests);
      setBars(results.flatMap(r => r.data || []) as Bar[]);
    }
    loadBars();
  }, []);

  // Initialize Mapbox map
  useEffect(() => {
    if (!mapContainer.current || map.current) return;
    const token = process.env.NEXT_PUBLIC_MAPBOX_TOKEN;
    if (!token) { console.error('Mapbox token missing'); return; }
    mapboxgl.accessToken = token;
    map.current = new mapboxgl.Map({
      container: mapContainer.current,
      style: 'mapbox://styles/mapbox/light-v11',
      center: [2.3622, 48.8729],
      zoom: 14,
    });
    map.current.on('error', e => console.error('Mapbox error:', e));
    const isMobile = /Mobi|Android|iPhone/i.test(navigator.userAgent);
    // Only show zoom buttons on desktop — mobile uses pinch
    if (!isMobile) map.current.addControl(new mapboxgl.NavigationControl(), 'top-right');
    const geolocate = new mapboxgl.GeolocateControl({
      positionOptions: { enableHighAccuracy: true },
      trackUserLocation: true,
      showUserHeading: true,
    });
    map.current.addControl(geolocate, 'top-right');
    map.current.on('load', () => {
      if (isMobile) geolocate.trigger();
    });
  }, []);

  // Update map source + pin size when filters change
  useEffect(() => {
    if (!map.current?.getSource('bars')) return;
    const geojson: GeoJSON.FeatureCollection = {
      type: 'FeatureCollection',
      features: filteredBars.map(bar => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [bar.longitude, bar.latitude] },
        properties: { ...bar },
      })),
    };
    (map.current.getSource('bars') as mapboxgl.GeoJSONSource).setData(geojson);

    // Enlarge pins and add stroke when a filter is active so they stand out
    if (map.current.getLayer('bars-circle')) {
      const r = isFiltered ? 10 : 7;
      const ro = isFiltered ? 13 : 9;
      map.current.setPaintProperty('bars-circle', 'circle-radius', r);
      map.current.setPaintProperty('bars-circle', 'circle-stroke-width', isFiltered ? 2.5 : 0);
      map.current.setPaintProperty('bars-circle', 'circle-stroke-color', '#ffffff');
      map.current.setPaintProperty('bars-outline', 'circle-radius', ro);
    }
  }, [filteredBars, isFiltered]);

  // Add bars to map on first load
  useEffect(() => {
    if (!map.current || bars.length === 0) return;

    function addBarsToMap() {
      const geojson: GeoJSON.FeatureCollection = {
        type: 'FeatureCollection',
        features: filteredBars.map(bar => ({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [bar.longitude, bar.latitude] },
          properties: { ...bar },
        })),
      };

      if (map.current!.getSource('bars')) return;

      // Hide noisy POI layers — restaurants, shops, hotels, etc.
      // Keep transit (metro) because useful in Paris
      const hideLayers = ['poi-label', 'airport-label'];
      hideLayers.forEach(id => {
        if (map.current!.getLayer(id)) {
          map.current!.setLayoutProperty(id, 'visibility', 'none');
        }
      });

      map.current!.addSource('bars', {
        type: 'geojson',
        data: geojson,
        cluster: true,
        clusterMaxZoom: 14,
        clusterRadius: 40,
      });

      // Cluster bubble — dark pill
      map.current!.addLayer({
        id: 'clusters',
        type: 'circle',
        source: 'bars',
        filter: ['has', 'point_count'],
        paint: {
          'circle-color': '#1a1a1a',
          'circle-radius': ['step', ['get', 'point_count'], 16, 20, 22, 100, 28],
          'circle-opacity': 0.92,
        },
      });

      // Cluster count label
      map.current!.addLayer({
        id: 'cluster-count',
        type: 'symbol',
        source: 'bars',
        filter: ['has', 'point_count'],
        layout: {
          'text-field': '{point_count_abbreviated}',
          'text-size': 12,
          'text-font': ['DIN Offc Pro Medium', 'Arial Unicode MS Bold'],
        },
        paint: { 'text-color': '#ffffff' },
      });

      // White halo behind individual dots
      map.current!.addLayer({
        id: 'bars-outline',
        type: 'circle',
        source: 'bars',
        filter: ['!', ['has', 'point_count']],
        paint: {
          'circle-radius': 10,
          'circle-color': '#ffffff',
          'circle-opacity': 1,
          'circle-blur': 0,
        },
      });

      // Colored dot
      map.current!.addLayer({
        id: 'bars-circle',
        type: 'circle',
        source: 'bars',
        filter: ['!', ['has', 'point_count']],
        paint: {
          'circle-radius': 7,
          'circle-color': [
            'case',
            ['==', ['get', 'beer_price'], 0], '#9CA3AF',
            ['<',  ['get', 'beer_price'], 5], '#22C55E',
            ['<=', ['get', 'beer_price'], 8], '#F97316',
            '#EF4444',
          ],
          'circle-stroke-width': 0,
          'circle-stroke-color': '#ffffff',
        },
      });

      // Clicking a cluster zooms in
      map.current!.on('click', 'clusters', e => {
        if (!e.features?.[0]) return;
        const clusterId = e.features[0].properties!.cluster_id;
        (map.current!.getSource('bars') as mapboxgl.GeoJSONSource)
          .getClusterExpansionZoom(clusterId, (err, zoom) => {
            if (err || !e.features?.[0].geometry) return;
            const coords = (e.features[0].geometry as GeoJSON.Point).coordinates as [number, number];
            map.current!.easeTo({ center: coords, zoom: zoom! });
          });
      });

      // Clicking a dot opens the info panel
      map.current!.on('click', 'bars-circle', e => {
        if (!e.features?.[0]?.properties) return;
        const p = e.features[0].properties;
        setSelectedBar({
          id: p.id, name: p.name, address: p.address,
          latitude: p.latitude, longitude: p.longitude,
          beer_price: p.beer_price, phone: p.phone,
          submitted_by: p.submitted_by, last_updated: p.last_updated,
          serves_beer: p.serves_beer ?? null, amenity_type: p.amenity_type ?? null,
        });
        setShowPriceForm(false);
        setPriceInput('');
        setMessage('');
      });

      ['bars-circle', 'clusters'].forEach(layer => {
        map.current!.on('mouseenter', layer, () => { map.current!.getCanvas().style.cursor = 'pointer'; });
        map.current!.on('mouseleave', layer, () => { map.current!.getCanvas().style.cursor = ''; });
      });

      // Click on empty map space → dismiss suggestion card
      map.current!.on('click', e => {
        const hit = map.current!.queryRenderedFeatures(e.point, { layers: ['bars-circle', 'clusters'] });
        if (hit.length === 0) setSuggestionDismissed(true);
      });
    }

    if (map.current.isStyleLoaded()) addBarsToMap();
    else map.current.on('load', addBarsToMap);
  }, [bars]);

  // Get GPS position
  useEffect(() => {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      pos => setUserLocation({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      () => {}
    );
  }, []);

  // Compute nearest bar matching price threshold
  useEffect(() => {
    if (!userLocation || bars.length === 0 || suggestionDismissed) return;
    const candidates = bars
      .filter(b => b.beer_price > 0)
      .filter(b => suggestionPriceMax === null || b.beer_price <= suggestionPriceMax)
      .map(b => ({ ...b, distance: getDistanceMeters(userLocation.lat, userLocation.lng, b.latitude, b.longitude) }))
      .sort((a, b) => a.distance - b.distance);

    // Prefer within 500m, fall back to 1km
    setSuggestion(
      candidates.find(b => b.distance <= 500) ??
      candidates.find(b => b.distance <= 1000) ??
      null
    );
  }, [userLocation, bars, suggestionDismissed, suggestionPriceMax]);

  // Draw walking route on map via Mapbox Directions
  async function showRoute(destLat: number, destLng: number, barName: string) {
    if (!userLocation || !map.current) return;
    const token = process.env.NEXT_PUBLIC_MAPBOX_TOKEN;
    try {
      const res = await fetch(
        `https://api.mapbox.com/directions/v5/mapbox/walking/${userLocation.lng},${userLocation.lat};${destLng},${destLat}?geometries=geojson&access_token=${token}`
      );
      const data = await res.json();
      const route = data.routes?.[0];
      if (!route) return;

      if (map.current.getLayer('route-dash')) map.current.removeLayer('route-dash');
      if (map.current.getLayer('route-casing')) map.current.removeLayer('route-casing');
      if (map.current.getSource('route')) map.current.removeSource('route');

      map.current.addSource('route', {
        type: 'geojson',
        data: { type: 'Feature', properties: {}, geometry: route.geometry },
      });
      // White casing for contrast against the map
      map.current.addLayer({
        id: 'route-casing',
        type: 'line',
        source: 'route',
        layout: { 'line-join': 'round', 'line-cap': 'butt' },
        paint: { 'line-color': '#ffffff', 'line-width': 10, 'line-opacity': 0.6 },
      });
      // Dashed blue line on top
      map.current.addLayer({
        id: 'route-dash',
        type: 'line',
        source: 'route',
        layout: { 'line-join': 'round', 'line-cap': 'butt' },
        paint: {
          'line-color': '#2563EB',
          'line-width': 5,
          'line-dasharray': [1.5, 1.5],
          'line-opacity': 1,
        },
      });

      const coords = route.geometry.coordinates as [number, number][];
      const bounds = coords.reduce(
        (b, c) => b.extend(c),
        new mapboxgl.LngLatBounds(coords[0], coords[0])
      );
      map.current.fitBounds(bounds, { padding: 80 });

      setRouteInfo({ minutes: Math.round(route.duration / 60), distance: Math.round(route.distance), barName, lat: destLat, lng: destLng });
    } catch (e) {
      console.error('Route error:', e);
    }
  }

  function clearRoute() {
    if (!map.current) return;
    if (map.current.getLayer('route-dash')) map.current.removeLayer('route-dash');
    if (map.current.getLayer('route-casing')) map.current.removeLayer('route-casing');
    if (map.current.getSource('route')) map.current.removeSource('route');
    setRouteInfo(null);
  }

  async function submitPrice() {
    if (!selectedBar || !priceInput) return;
    const price = parseFloat(priceInput);
    if (isNaN(price) || price <= 0) { setMessage('Entre un prix valide (ex: 5.50)'); return; }
    setLoading(true);
    const updatedAt = new Date().toISOString();
    const { error } = await supabase
      .from('bars').update({ beer_price: price, last_updated: updatedAt }).eq('id', selectedBar.id);
    if (error) {
      setMessage('Erreur lors de la soumission.');
    } else {
      setMessage('Prix soumis, merci !');
      setBars(prev => prev.map(b => b.id === selectedBar.id ? { ...b, beer_price: price, last_updated: updatedAt } : b));
      setTimeout(() => { setSelectedBar(null); setShowPriceForm(false); setPriceInput(''); setMessage(''); }, 1500);
    }
    setLoading(false);
  }

  function closeAll() {
    setSelectedBar(null);
    setShowPriceForm(false);
    setMessage('');
    setPriceInput('');
  }

  return (
    <div className="relative w-full h-screen overflow-hidden" style={{ fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Display", "Segoe UI", sans-serif' }}>

      {/* ── MAP ── */}
      <div ref={mapContainer} className="w-full h-full" />

      {/* ── TOP CHROME ── */}
      <div
        className="absolute top-0 left-0 right-0 z-10 pointer-events-none"
        style={{ paddingTop: 'env(safe-area-inset-top, 0px)' }}
      >
        <div className="px-3 pt-3 flex flex-col gap-2 pointer-events-auto">

          {/* Search bar */}
          <div className="flex gap-2">
            <div
              className="flex-1 flex items-center gap-2.5 bg-white/95 rounded-2xl px-3.5 py-3 backdrop-blur-sm"
              style={{ marginRight: '0', boxShadow: '0 1px 12px rgba(0,0,0,0.10), 0 0 0 1px rgba(0,0,0,0.04)' }}
            >
              <svg className="w-3.5 h-3.5 text-gray-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M21 21l-4.35-4.35M17 11A6 6 0 1 1 5 11a6 6 0 0 1 12 0z" />
              </svg>
              <input
                type="text"
                placeholder="Rechercher un bar…"
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                className="flex-1 text-sm font-medium text-gray-900 placeholder-gray-400 focus:outline-none bg-transparent min-w-0 leading-none"
              />
              {searchQuery && (
                <button onClick={() => setSearchQuery('')} className="w-5 h-5 flex items-center justify-center rounded-full bg-gray-200 text-gray-500 text-[10px] flex-shrink-0">✕</button>
              )}
            </div>
            {/* Empty space for mapbox geolocate btn */}
            <div className="w-10 flex-shrink-0" />
          </div>

          {/* Filter chips */}
          <div className="flex gap-1.5 overflow-x-auto scrollbar-hide">
            {([
              { key: 'under4', label: '< 4 €' },
              { key: 'under5', label: '< 5 €' },
              { key: 'under6', label: '< 6 €' },
            ] as const).map(({ key, label }) => (
              <button
                key={key}
                onClick={() => setPriceFilter(priceFilter === key ? 'all' : key)}
                className={`flex-shrink-0 text-xs font-semibold px-3.5 py-1.5 rounded-full transition-all active:scale-95 ${
                  priceFilter === key
                    ? 'bg-gray-900 text-white'
                    : 'bg-white/90 text-gray-700 backdrop-blur-sm'
                }`}
                style={{ boxShadow: priceFilter === key ? 'none' : '0 1px 8px rgba(0,0,0,0.08), 0 0 0 1px rgba(0,0,0,0.04)' }}
              >
                {label}
              </button>
            ))}

            {/* Color legend dots — inline with chips */}
            <div className="ml-auto flex items-center gap-2 bg-white/90 backdrop-blur-sm rounded-full px-3 py-1.5 flex-shrink-0"
                 style={{ boxShadow: '0 1px 8px rgba(0,0,0,0.08), 0 0 0 1px rgba(0,0,0,0.04)' }}>
              <span className="w-2 h-2 rounded-full bg-green-500 flex-shrink-0" title="< 5€" />
              <span className="w-2 h-2 rounded-full bg-orange-500 flex-shrink-0" title="5–8€" />
              <span className="w-2 h-2 rounded-full bg-red-500 flex-shrink-0" title="> 8€" />
            </div>
          </div>
        </div>
      </div>

      {/* ── NEARBY SUGGESTION ── */}
      {suggestion && !suggestionDismissed && !selectedBar && !routeInfo && (
        <div
          className="absolute left-3 right-3 z-10"
          style={{ bottom: 'calc(env(safe-area-inset-bottom, 0px) + 12px)' }}
        >
          <div
            className="bg-white rounded-2xl overflow-hidden"
            style={{ boxShadow: '0 4px 24px rgba(0,0,0,0.12), 0 0 0 1px rgba(0,0,0,0.04)' }}
          >
            <div className="px-4 py-4">
              {/* Header row */}
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-1.5">
                  <span className="w-1.5 h-1.5 rounded-full bg-green-500 flex-shrink-0" />
                  <span className="text-[11px] font-semibold text-gray-500 uppercase tracking-wider">
                    {suggestionPriceMax ? `≤ ${suggestionPriceMax} €` : 'Le moins cher'} · {Math.round(suggestion.distance)} m
                  </span>
                </div>
                <button
                  onClick={() => setSuggestionDismissed(true)}
                  className="w-6 h-6 flex items-center justify-center rounded-full text-gray-400 hover:bg-gray-100 active:bg-gray-200 text-[11px]"
                >✕</button>
              </div>

              {/* Name + price */}
              <div className="flex items-center gap-3 mb-3">
                <div className="flex-1 min-w-0">
                  <p className="font-bold text-gray-900 text-[17px] leading-tight truncate">{suggestion.name}</p>
                  {suggestion.address && (
                    <p className="text-[12px] text-gray-400 truncate mt-0.5">{suggestion.address}</p>
                  )}
                </div>
                <div className="flex-shrink-0 text-right">
                  <span className="text-[28px] font-black tabular-nums leading-none" style={{ color: '#16a34a' }}>
                    {suggestion.beer_price.toFixed(2)}€
                  </span>
                </div>
              </div>

              {/* Bottom row: threshold toggles + go */}
              <div className="flex items-center gap-1.5">
                {([4, 5, null] as SuggestionPriceMax[]).map(val => (
                  <button
                    key={String(val)}
                    onClick={() => { setSuggestionPriceMax(val); setSuggestionDismissed(false); }}
                    className={`text-[11px] font-semibold px-2.5 py-1 rounded-full transition active:scale-95 ${
                      suggestionPriceMax === val
                        ? 'bg-gray-900 text-white'
                        : 'bg-gray-100 text-gray-500'
                    }`}
                  >
                    {val === null ? 'Tous' : `< ${val}€`}
                  </button>
                ))}
                <div className="flex-1" />
                <button
                  onClick={() => showRoute(suggestion.latitude, suggestion.longitude, suggestion.name)}
                  className="flex items-center gap-1.5 bg-gray-900 text-white text-[13px] font-semibold px-4 py-2 rounded-xl active:bg-gray-700 transition"
                >
                  Y aller
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M17 8l4 4m0 0l-4 4m4-4H3" />
                  </svg>
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── REOPEN pill ── */}
      {suggestion && suggestionDismissed && !selectedBar && !routeInfo && (
        <button
          onClick={() => setSuggestionDismissed(false)}
          className="absolute right-3 z-10 bg-white rounded-full pl-2.5 pr-3.5 py-2 flex items-center gap-1.5 active:scale-95 transition"
          style={{ bottom: 'calc(env(safe-area-inset-bottom, 0px) + 12px)', boxShadow: '0 2px 16px rgba(0,0,0,0.12), 0 0 0 1px rgba(0,0,0,0.04)' }}
        >
          <span className="text-sm">🍺</span>
          <span className="text-[13px] font-bold tabular-nums" style={{ color: '#16a34a' }}>{suggestion.beer_price.toFixed(2)}€</span>
        </button>
      )}

      {/* ── ROUTE banner ── */}
      {routeInfo && (
        <div
          className="absolute left-3 right-3 z-20"
          style={{ bottom: 'calc(env(safe-area-inset-bottom, 0px) + 12px)' }}
        >
          <div
            className="bg-gray-900 rounded-2xl px-4 py-3.5 flex items-center gap-3"
            style={{ boxShadow: '0 4px 24px rgba(0,0,0,0.18)' }}
          >
            <div className="w-2 h-2 rounded-full bg-blue-400 flex-shrink-0 animate-pulse" />
            <div className="flex-1 min-w-0">
              <p className="text-white font-semibold text-[14px] truncate leading-tight">{routeInfo.barName}</p>
              <p className="text-gray-400 text-[12px] mt-0.5">{routeInfo.minutes} min · {routeInfo.distance} m à pied</p>
            </div>
            <a
              href={`https://www.google.com/maps/dir/?api=1&destination=${routeInfo.lat},${routeInfo.lng}`}
              target="_blank" rel="noopener noreferrer"
              className="text-blue-400 text-[12px] font-semibold flex-shrink-0 px-1"
            >Maps ↗</a>
            <button
              onClick={clearRoute}
              className="w-7 h-7 flex items-center justify-center rounded-full bg-white/10 text-gray-400 text-xs flex-shrink-0 active:bg-white/20"
            >✕</button>
          </div>
        </div>
      )}

      {/* ── BAR DETAIL SHEET ── */}
      {selectedBar && (
        <div
          className="absolute bottom-0 left-0 right-0 z-30 bg-white"
          style={{
            borderRadius: '20px 20px 0 0',
            paddingBottom: 'env(safe-area-inset-bottom, 0px)',
            boxShadow: '0 -2px 32px rgba(0,0,0,0.10), 0 0 0 1px rgba(0,0,0,0.04)',
          }}
        >
          {/* Handle */}
          <div className="flex justify-center pt-3 pb-1">
            <div className="w-8 h-[3px] rounded-full bg-gray-200" />
          </div>

          <div className="px-5 pt-3 pb-5">
            {/* Name row */}
            <div className="flex items-start gap-2 mb-1">
              <div className="flex-1 min-w-0">
                <h2 className="text-[20px] font-bold text-gray-900 leading-snug">{selectedBar.name}</h2>
              </div>
              <button
                onClick={closeAll}
                className="w-8 h-8 flex items-center justify-center rounded-full bg-gray-100 text-gray-500 flex-shrink-0 active:bg-gray-200 mt-0.5 text-sm"
              >✕</button>
            </div>

            {/* Address */}
            {selectedBar.address && (
              <p className="text-[13px] text-gray-400 mb-4 leading-snug">{selectedBar.address}</p>
            )}

            {!showPriceForm ? (
              <>
                {/* Price + date */}
                <div className="flex items-end gap-2.5 mb-5">
                  <span
                    className="text-[44px] font-black leading-none tabular-nums"
                    style={{ color: selectedBar.beer_price === 0 ? '#d1d5db' : getPriceColor(selectedBar.beer_price) }}
                  >
                    {selectedBar.beer_price === 0 ? '—' : `${selectedBar.beer_price.toFixed(2)}€`}
                  </span>
                  <div className="pb-1.5">
                    <p className="text-[12px] text-gray-400 font-medium leading-tight">
                      {selectedBar.beer_price === 0 ? 'Prix inconnu' : 'la pinte'}
                    </p>
                    {selectedBar.beer_price > 0 && (
                      <p className="text-[11px] text-gray-300 leading-tight">
                        {new Date(selectedBar.last_updated).toLocaleDateString('fr-FR')}
                      </p>
                    )}
                  </div>
                </div>

                {/* Buttons */}
                <div className="flex gap-2.5">
                  {userLocation && (
                    <button
                      onClick={() => showRoute(selectedBar.latitude, selectedBar.longitude, selectedBar.name)}
                      className="flex-1 flex items-center justify-center gap-2 bg-gray-900 text-white rounded-xl py-3.5 font-semibold text-[14px] active:bg-gray-700 transition"
                    >
                      Y aller
                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M17 8l4 4m0 0l-4 4m4-4H3" />
                      </svg>
                    </button>
                  )}
                  <button
                    onClick={() => setShowPriceForm(true)}
                    className={`flex items-center justify-center rounded-xl py-3.5 font-semibold text-[14px] bg-gray-100 text-gray-700 active:bg-gray-200 transition ${userLocation ? 'px-4' : 'flex-1'}`}
                  >
                    Signaler un prix
                  </button>
                </div>
              </>
            ) : (
              <div className="space-y-3">
                <p className="text-[14px] font-semibold text-gray-800">Combien coûte la pinte ?</p>
                <div className="relative">
                  <input
                    type="number" step="0.1" min="0"
                    placeholder="5.50"
                    value={priceInput}
                    onChange={e => setPriceInput(e.target.value)}
                    className="w-full bg-gray-100 rounded-xl px-4 py-3.5 text-gray-900 text-[18px] font-bold focus:outline-none focus:ring-2 focus:ring-gray-900 pr-10"
                    autoFocus
                  />
                  <span className="absolute right-4 top-1/2 -translate-y-1/2 text-[18px] font-bold text-gray-400">€</span>
                </div>
                {message && <p className="text-sm text-center font-medium text-green-600">{message}</p>}
                <div className="flex gap-2.5">
                  <button
                    onClick={() => setShowPriceForm(false)}
                    className="flex-1 bg-gray-100 text-gray-700 rounded-xl py-3.5 font-semibold text-[14px] active:bg-gray-200"
                  >Annuler</button>
                  <button
                    onClick={submitPrice}
                    disabled={loading}
                    className="flex-1 bg-gray-900 text-white rounded-xl py-3.5 font-semibold text-[14px] active:bg-gray-700 disabled:opacity-40"
                  >{loading ? 'Envoi…' : 'Confirmer'}</button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
