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
  const [showAddForm, setShowAddForm] = useState(false);
  const [priceInput, setPriceInput] = useState('');
  const [newBar, setNewBar] = useState({ name: '', address: '', price: '' });
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [priceFilter, setPriceFilter] = useState<'all' | 'under4' | 'under5' | 'under6'>('all');

  const [userLocation, setUserLocation] = useState<{ lat: number; lng: number } | null>(null);
  const [suggestion, setSuggestion] = useState<(Bar & { distance: number }) | null>(null);
  const [suggestionDismissed, setSuggestionDismissed] = useState(false);
  const [suggestionPriceMax, setSuggestionPriceMax] = useState<SuggestionPriceMax>(4);

  const [routeInfo, setRouteInfo] = useState<RouteInfo | null>(null);

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
      style: 'mapbox://styles/mapbox/streets-v12',
      center: [2.3622, 48.8729],
      zoom: 14,
    });
    map.current.on('error', e => console.error('Mapbox error:', e));
    map.current.addControl(new mapboxgl.NavigationControl(), 'top-right');
    const geolocate = new mapboxgl.GeolocateControl({
      positionOptions: { enableHighAccuracy: true },
      trackUserLocation: true,
      showUserHeading: true,
    });
    map.current.addControl(geolocate, 'top-right');
    map.current.on('load', () => {
      if (/Mobi|Android|iPhone/i.test(navigator.userAgent)) geolocate.trigger();
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

      map.current!.addSource('bars', {
        type: 'geojson',
        data: geojson,
        cluster: true,
        clusterMaxZoom: 14,
        clusterRadius: 40,
      });

      // Cluster bubble
      map.current!.addLayer({
        id: 'clusters',
        type: 'circle',
        source: 'bars',
        filter: ['has', 'point_count'],
        paint: {
          'circle-color': '#3B82F6',
          'circle-radius': ['step', ['get', 'point_count'], 16, 20, 22, 100, 28],
          'circle-opacity': 0.85,
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

      // White ring behind individual dots
      map.current!.addLayer({
        id: 'bars-outline',
        type: 'circle',
        source: 'bars',
        filter: ['!', ['has', 'point_count']],
        paint: { 'circle-radius': 9, 'circle-color': '#ffffff', 'circle-opacity': 0.9 },
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
        setShowAddForm(false);
        setPriceInput('');
        setMessage('');
      });

      ['bars-circle', 'clusters'].forEach(layer => {
        map.current!.on('mouseenter', layer, () => { map.current!.getCanvas().style.cursor = 'pointer'; });
        map.current!.on('mouseleave', layer, () => { map.current!.getCanvas().style.cursor = ''; });
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

      if (map.current.getLayer('route')) map.current.removeLayer('route');
      if (map.current.getSource('route')) map.current.removeSource('route');

      map.current.addSource('route', {
        type: 'geojson',
        data: { type: 'Feature', properties: {}, geometry: route.geometry },
      });
      map.current.addLayer({
        id: 'route',
        type: 'line',
        source: 'route',
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: { 'line-color': '#3B82F6', 'line-width': 5, 'line-opacity': 0.85 },
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
    if (map.current.getLayer('route')) map.current.removeLayer('route');
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

  async function addNewBar() {
    if (!newBar.name || !newBar.address || !newBar.price) { setMessage('Tous les champs sont obligatoires.'); return; }
    const price = parseFloat(newBar.price);
    if (isNaN(price) || price <= 0) { setMessage('Entre un prix valide (ex: 5.50)'); return; }
    setLoading(true);
    const geocodeRes = await fetch(
      `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(newBar.address + ', Paris')}.json?access_token=${process.env.NEXT_PUBLIC_MAPBOX_TOKEN}&limit=1&country=fr`
    );
    const geocodeData = await geocodeRes.json();
    if (!geocodeData.features?.length) {
      setMessage("Adresse introuvable. Essaie d'être plus précis.");
      setLoading(false);
      return;
    }
    const [longitude, latitude] = geocodeData.features[0].center;
    const { error } = await supabase.from('bars').insert({ name: newBar.name, address: newBar.address, latitude, longitude, beer_price: price, submitted_by: 'user' });
    if (error) {
      setMessage("Erreur lors de l'ajout.");
    } else {
      setMessage('Bar ajouté, merci !');
      const { data: inserted } = await supabase
        .from('bars').select('id,name,address,latitude,longitude,beer_price,phone,last_updated').eq('name', newBar.name).eq('latitude', latitude).limit(1);
      if (inserted?.[0]) setBars(prev => [...prev, inserted[0] as Bar]);
      setTimeout(() => { setShowAddForm(false); setNewBar({ name: '', address: '', price: '' }); setMessage(''); }, 1500);
    }
    setLoading(false);
  }

  function closeAll() {
    setSelectedBar(null);
    setShowPriceForm(false);
    setShowAddForm(false);
    setMessage('');
    setPriceInput('');
  }

  return (
    <div className="relative w-full h-screen overflow-hidden">

      {/* Map canvas */}
      <div ref={mapContainer} className="absolute inset-0" style={{ width: '100%', height: '100%' }} />

      {/* Search bar + price filter chips */}
      <div className="absolute top-3 left-3 right-14 z-10 flex flex-col gap-2">
        <div className="flex items-center gap-2 bg-white rounded-2xl shadow-lg px-3 py-2">
          <svg className="w-4 h-4 text-gray-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-4.35-4.35M17 11A6 6 0 1 1 5 11a6 6 0 0 1 12 0z" />
          </svg>
          <input
            type="text"
            placeholder="Rechercher un bar..."
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            className="flex-1 text-sm text-gray-900 placeholder-gray-400 focus:outline-none bg-transparent"
          />
          {searchQuery && (
            <button onClick={() => setSearchQuery('')} className="text-gray-300 hover:text-gray-500 text-lg leading-none">✕</button>
          )}
        </div>

        <div className="flex gap-2 overflow-x-auto pb-1 scrollbar-hide">
          {([
            { key: 'under4', label: '< 4€' },
            { key: 'under5', label: '< 5€' },
            { key: 'under6', label: '< 6€' },
          ] as const).map(({ key, label }) => (
            <button
              key={key}
              onClick={() => setPriceFilter(priceFilter === key ? 'all' : key)}
              className={`flex-shrink-0 text-sm font-semibold px-4 py-1.5 rounded-full shadow transition ${
                priceFilter === key ? 'bg-blue-600 text-white' : 'bg-white text-gray-700 hover:bg-gray-50'
              }`}
            >
              {label}
            </button>
          ))}
          {isFiltered && (
            <span className="flex-shrink-0 text-sm text-blue-500 font-medium px-1 py-1.5 self-center whitespace-nowrap">
              {filteredBars.length} bars
            </span>
          )}
        </div>
      </div>

      {/* Add bar button */}
      <button
        onClick={() => { closeAll(); setShowAddForm(true); }}
        className="absolute bottom-36 right-4 z-10 bg-blue-600 hover:bg-blue-700 text-white font-bold text-xl w-14 h-14 rounded-full shadow-xl transition flex items-center justify-center"
      >
        +
      </button>

      {/* Legend */}
      <div className="absolute bottom-8 left-4 z-10 bg-white rounded-2xl shadow-lg px-4 py-3 text-sm space-y-1.5">
        <p className="font-semibold text-gray-700 text-xs uppercase tracking-wide mb-2">Prix d'une bière</p>
        {[
          { color: 'bg-green-500',  label: 'Moins de 5 €' },
          { color: 'bg-orange-500', label: '5 € – 8 €' },
          { color: 'bg-red-500',    label: 'Plus de 8 €' },
          { color: 'bg-gray-400',   label: 'Prix inconnu' },
        ].map(({ color, label }) => (
          <div key={label} className="flex items-center gap-2">
            <span className={`w-3 h-3 rounded-full ${color} flex-shrink-0`} />
            <span className="text-gray-600">{label}</span>
          </div>
        ))}
      </div>

      {/* Nearby suggestion card */}
      {suggestion && !suggestionDismissed && !selectedBar && !showAddForm && !routeInfo && (
        <div className="absolute bottom-48 left-4 right-4 z-10 bg-white rounded-2xl shadow-xl overflow-hidden">
          <div className="h-1 bg-green-500" />
          <div className="px-4 pt-3 pb-4">
            <p className="text-xs font-semibold text-green-600 uppercase tracking-wide mb-2">
              {suggestionPriceMax ? `Bière à moins de ${suggestionPriceMax}€` : 'Moins chère à proximité'} · {Math.round(suggestion.distance)} m
            </p>
            <div className="flex items-center gap-3 mb-3">
              <div className="flex-1 min-w-0">
                <p className="font-bold text-gray-900 truncate">{suggestion.name}</p>
                {suggestion.address && <p className="text-xs text-gray-400 truncate">{suggestion.address}</p>}
              </div>
              <span className="text-2xl font-extrabold text-green-600 flex-shrink-0">
                {suggestion.beer_price.toFixed(2)}€
              </span>
            </div>

            {/* Price threshold chips */}
            <div className="flex gap-1.5 mb-3">
              {([4, 5, null] as SuggestionPriceMax[]).map(val => (
                <button
                  key={String(val)}
                  onClick={() => { setSuggestionPriceMax(val); setSuggestionDismissed(false); }}
                  className={`text-xs font-semibold px-3 py-1 rounded-full transition ${
                    suggestionPriceMax === val
                      ? 'bg-green-500 text-white'
                      : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                  }`}
                >
                  {val === null ? 'Tous prix' : `< ${val}€`}
                </button>
              ))}
            </div>

            <div className="flex gap-2">
              <button
                onClick={() => showRoute(suggestion.latitude, suggestion.longitude, suggestion.name)}
                className="flex-1 bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold rounded-xl py-2.5 transition"
              >
                Y aller →
              </button>
              <button
                onClick={() => setSuggestionDismissed(true)}
                className="px-4 py-2.5 rounded-xl bg-gray-100 text-gray-500 text-sm font-medium hover:bg-gray-200 transition"
              >
                Fermer
              </button>
            </div>
          </div>
        </div>
      )}

      {/* In-app route info — compact floating card */}
      {routeInfo && (
        <div className="absolute bottom-6 left-4 right-4 z-20 max-w-sm mx-auto">
          <div className="bg-white rounded-2xl shadow-xl px-4 py-3 flex items-center gap-3">
            {/* Blue dot indicator */}
            <div className="w-2.5 h-2.5 rounded-full bg-blue-500 flex-shrink-0 animate-pulse" />

            {/* Info */}
            <div className="flex-1 min-w-0">
              <p className="font-semibold text-gray-900 text-sm truncate">{routeInfo.barName}</p>
              <p className="text-xs text-gray-400">{routeInfo.minutes} min · {routeInfo.distance} m à pied</p>
            </div>

            {/* Actions */}
            <a
              href={`https://www.google.com/maps/dir/?api=1&destination=${routeInfo.lat},${routeInfo.lng}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs font-semibold text-blue-600 hover:text-blue-700 flex-shrink-0"
            >
              Maps
            </a>
            <button
              onClick={clearRoute}
              className="w-6 h-6 flex items-center justify-center rounded-full bg-gray-100 hover:bg-gray-200 text-gray-400 text-sm flex-shrink-0 transition"
            >
              ✕
            </button>
          </div>
        </div>
      )}

      {/* Bar info panel */}
      {selectedBar && !showAddForm && (
        <div className="absolute bottom-0 left-0 right-0 z-20 bg-white rounded-t-3xl shadow-2xl px-5 pt-5 pb-8 max-w-lg mx-auto">
          <div className="w-10 h-1 bg-gray-200 rounded-full mx-auto mb-4" />
          <div className="flex justify-between items-start mb-3">
            <div className="flex-1 pr-3">
              <h2 className="text-lg font-bold text-gray-900 leading-tight">{selectedBar.name}</h2>
              {selectedBar.address && <p className="text-sm text-gray-500 mt-0.5">{selectedBar.address}</p>}
              {selectedBar.phone && (
                <a href={`tel:${selectedBar.phone}`} className="text-sm text-blue-500 mt-0.5 block">{selectedBar.phone}</a>
              )}
            </div>
            <button onClick={closeAll} className="text-gray-300 hover:text-gray-500 text-2xl leading-none">✕</button>
          </div>
          <div className="flex items-center gap-2 mb-4">
            <span className="w-4 h-4 rounded-full flex-shrink-0" style={{ backgroundColor: getPriceColor(selectedBar.beer_price) }} />
            <span className="text-2xl font-bold text-gray-900">{formatPrice(selectedBar.beer_price)}</span>
            {selectedBar.beer_price > 0 && (
              <span className="text-xs text-gray-400 ml-1">· {new Date(selectedBar.last_updated).toLocaleDateString('fr-FR')}</span>
            )}
          </div>
          {!showPriceForm ? (
            <button
              onClick={() => setShowPriceForm(true)}
              className="w-full bg-blue-600 hover:bg-blue-700 text-white rounded-2xl py-3.5 font-semibold transition"
            >
              Soumettre un prix
            </button>
          ) : (
            <div className="space-y-3">
              <input
                type="number" step="0.1" min="0"
                placeholder="Prix en € (ex: 5.50)"
                value={priceInput}
                onChange={e => setPriceInput(e.target.value)}
                className="w-full border border-gray-200 rounded-2xl px-4 py-3.5 text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
                autoFocus
              />
              {message && <p className="text-sm text-center text-green-600 font-medium">{message}</p>}
              <button
                onClick={submitPrice}
                disabled={loading}
                className="w-full bg-blue-600 hover:bg-blue-700 text-white rounded-2xl py-3.5 font-semibold transition disabled:opacity-50"
              >
                {loading ? 'Envoi en cours...' : 'Confirmer le prix'}
              </button>
            </div>
          )}
        </div>
      )}

      {/* Add new bar panel */}
      {showAddForm && (
        <div className="absolute bottom-0 left-0 right-0 z-20 bg-white rounded-t-3xl shadow-2xl px-5 pt-5 pb-8 max-w-lg mx-auto">
          <div className="w-10 h-1 bg-gray-200 rounded-full mx-auto mb-4" />
          <div className="flex justify-between items-center mb-4">
            <h2 className="text-lg font-bold text-gray-900">Ajouter un bar</h2>
            <button onClick={closeAll} className="text-gray-300 hover:text-gray-500 text-2xl leading-none">✕</button>
          </div>
          <div className="space-y-3">
            <input
              type="text" placeholder="Nom du bar"
              value={newBar.name}
              onChange={e => setNewBar(b => ({ ...b, name: e.target.value }))}
              className="w-full border border-gray-200 rounded-2xl px-4 py-3.5 text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <input
              type="text" placeholder="Adresse (ex: 10 rue de la Paix)"
              value={newBar.address}
              onChange={e => setNewBar(b => ({ ...b, address: e.target.value }))}
              className="w-full border border-gray-200 rounded-2xl px-4 py-3.5 text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <input
              type="number" step="0.1" min="0"
              placeholder="Prix de la bière en € (ex: 5.50)"
              value={newBar.price}
              onChange={e => setNewBar(b => ({ ...b, price: e.target.value }))}
              className="w-full border border-gray-200 rounded-2xl px-4 py-3.5 text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            {message && (
              <p className="text-sm text-center font-medium" style={{ color: message.includes('merci') ? '#16a34a' : '#dc2626' }}>
                {message}
              </p>
            )}
            <button
              onClick={addNewBar}
              disabled={loading}
              className="w-full bg-blue-600 hover:bg-blue-700 text-white rounded-2xl py-3.5 font-semibold transition disabled:opacity-50"
            >
              {loading ? 'Géolocalisation en cours...' : 'Ajouter ce bar'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
