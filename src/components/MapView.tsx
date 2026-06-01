'use client';

import { useEffect, useRef, useState, useMemo } from 'react';
import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';
import { supabase, type Bar, type HoursPeriod } from '@/lib/supabase';

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
  if (price <= 5)  return '#22C55E';   // ≤ 5 € → vert
  if (price < 7)   return '#F97316';   // 5–7 € → orange
  return '#EF4444';                     // ≥ 7 € → rouge
}

type SuggestionPriceMax = 4 | 5 | null;
type LateFilter = 'none' | '2h' | '5h';

/** Return today's opening hours as a human-readable string, e.g. "18h–2h+" */
function getTodayHours(periods: HoursPeriod[] | null): string | null {
  if (!periods?.length) return null;
  const today = new Date().getDay(); // 0=Sun … 6=Sat
  const p = periods.find(p => p.open.day === today);
  if (!p) return 'Fermé aujourd\'hui';
  if (!p.close) return 'Ouvert 24h/24';
  const fmt = (h: number, m: number) => `${h}h${m ? m.toString().padStart(2, '0') : ''}`;
  const suffix = p.close.hour < 8 ? '+' : ''; // + = closes next calendar day
  return `${fmt(p.open.hour, p.open.minute)}–${fmt(p.close.hour, p.close.minute)}${suffix}`;
}

/** Is the bar currently open based on its periods? */
function isOpenNow(periods: HoursPeriod[] | null): boolean | null {
  if (!periods?.length) return null;
  const now  = new Date();
  const day  = now.getDay();
  const mins = now.getHours() * 60 + now.getMinutes();
  for (const p of periods) {
    const openMins  = p.open.day  * 1440 + p.open.hour  * 60 + (p.open.minute  ?? 0);
    const closeMins = p.close ? (p.close.day * 1440 + p.close.hour * 60 + (p.close.minute ?? 0)) : null;
    const nowAbs    = day * 1440 + mins;
    if (closeMins === null) return true; // 24h
    if (nowAbs >= openMins && nowAbs < closeMins) return true;
  }
  return false;
}

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
  const chromeRef = useRef<HTMLDivElement>(null);   // for measuring actual chrome height

  const [bars, setBars] = useState<Bar[]>([]);
  const [selectedBar, setSelectedBar] = useState<Bar | null>(null);
  const [showPriceForm, setShowPriceForm] = useState(false);
  const [priceInput, setPriceInput] = useState('');
  const [priceConfirmed, setPriceConfirmed] = useState(false);   // double-confirm on suspicious price
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);           // collapsible search bar
  const [priceFilter, setPriceFilter] = useState<'all' | 'under4' | 'under5' | 'under6'>('all');

  const [userLocation, setUserLocation] = useState<{ lat: number; lng: number } | null>(null);
  const [suggestion, setSuggestion] = useState<(Bar & { distance: number }) | null>(null);
  const [suggestionDismissed, setSuggestionDismissed] = useState(false);
  const [suggestionPriceMax, setSuggestionPriceMax] = useState<SuggestionPriceMax>(4);

  const [routeInfo, setRouteInfo] = useState<RouteInfo | null>(null);
  const [terraceFilter, setTerraceFilter] = useState(false);
  const [lateFilter, setLateFilter] = useState<LateFilter>('none');
  const [barsLoading, setBarsLoading] = useState(true);

  // Dynamic chrome height — drives sheet maxHeight so it never goes under the search bar
  const [chromeH, setChromeH] = useState(52);
  useEffect(() => {
    if (!chromeRef.current) return;
    const ro = new ResizeObserver(() => {
      if (chromeRef.current) setChromeH(chromeRef.current.getBoundingClientRect().height);
    });
    ro.observe(chromeRef.current);
    return () => ro.disconnect();
  }, []);

  // Virtual keyboard height — keeps price form CTA above iOS keyboard
  const [kbH, setKbH] = useState(0);
  useEffect(() => {
    if (typeof window === 'undefined' || !window.visualViewport) return;
    const handler = () => {
      const diff = window.innerHeight - (window.visualViewport!.height + window.visualViewport!.offsetTop);
      setKbH(Math.max(0, diff));
    };
    window.visualViewport.addEventListener('resize', handler);
    window.visualViewport.addEventListener('scroll', handler);
    handler();
    return () => {
      window.visualViewport!.removeEventListener('resize', handler);
      window.visualViewport!.removeEventListener('scroll', handler);
    };
  }, []);

  const filteredBars = useMemo(() => {
    return bars.filter(bar => {
      if (searchQuery && !bar.name.toLowerCase().includes(searchQuery.toLowerCase())) return false;
      if (terraceFilter && !bar.has_terrace) return false;
      if (priceFilter === 'under4') { if (!(bar.beer_price > 0 && bar.beer_price < 4)) return false; }
      if (priceFilter === 'under5') { if (!(bar.beer_price > 0 && bar.beer_price < 5)) return false; }
      if (priceFilter === 'under6') { if (!(bar.beer_price > 0 && bar.beer_price < 6)) return false; }
      // 26 = 2am in 24+ notation, 29 = 5am
      if (lateFilter === '2h' && (bar.close_hour === null || bar.close_hour < 26)) return false;
      if (lateFilter === '5h' && (bar.close_hour === null || bar.close_hour < 29)) return false;
      return true;
    });
  }, [bars, searchQuery, priceFilter, terraceFilter, lateFilter]);

  const isFiltered = priceFilter !== 'all' || !!searchQuery || terraceFilter || lateFilter !== 'none';

  // Load all bars — cache localStorage 30 min pour réduire le bandwidth Supabase
  useEffect(() => {
    async function loadBars() {
      const CACHE_KEY = 'pbm_bars_v2';
      const CACHE_TTL = 30 * 60 * 1000; // 30 min

      // Essai du cache local
      try {
        const raw = localStorage.getItem(CACHE_KEY);
        if (raw) {
          const { ts, data } = JSON.parse(raw);
          if (Date.now() - ts < CACHE_TTL && Array.isArray(data) && data.length > 100) {
            setBars(data as Bar[]);
            setBarsLoading(false);
            return;
          }
        }
      } catch {}

      // Fetch Supabase
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
          .select('id,name,address,latitude,longitude,beer_price,price_source,phone,last_updated,has_terrace,terrace_grande,opening_hours,close_hour')
          .or('serves_beer.eq.true,serves_beer.is.null')
          .range(i * batchSize, (i + 1) * batchSize - 1)
      );
      const results = await Promise.all(requests);
      const allBars = results.flatMap(r => r.data || []) as Bar[];
      setBars(allBars);
      setBarsLoading(false);

      // Mise en cache
      try {
        localStorage.setItem(CACHE_KEY, JSON.stringify({ ts: Date.now(), data: allBars }));
      } catch {}
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
      // Push Mapbox controls below our top chrome (safe-area + chrome ~56px)
      // so the geolocate button doesn't overlap the filter chips
      const topOffset = `calc(env(safe-area-inset-top, 0px) + 56px)`;
      const ctrlContainer = mapContainer.current?.querySelector<HTMLElement>('.mapboxgl-ctrl-top-right');
      if (ctrlContainer) ctrlContainer.style.top = topOffset;
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
      const r  = isFiltered ? 9  : 6;
      const ro = isFiltered ? 12 : 8;
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
        clusterMaxZoom: 12,   // bars individuels visibles dès zoom 13 (vue arrondissement)
        clusterRadius: 30,
        clusterProperties: {
          // prix le moins cher du cluster (999 = aucun prix connu)
          min_price: ['min', ['case', ['>', ['get', 'beer_price'], 0], ['get', 'beer_price'], 999]],
        },
      });

      // Cluster bubble — coloré selon le prix le moins cher
      map.current!.addLayer({
        id: 'clusters',
        type: 'circle',
        source: 'bars',
        filter: ['has', 'point_count'],
        paint: {
          'circle-color': [
            'case',
            ['>=', ['get', 'min_price'], 999], '#374151',          // aucun prix → gris foncé
            ['<=', ['get', 'min_price'], 5],   '#15803d',          // ≤5€ → vert foncé
            ['<',  ['get', 'min_price'], 7],   '#c2410c',          // 5–7€ → orange foncé
            '#991b1b',                                              // ≥7€ → rouge foncé
          ] as unknown as string,
          'circle-radius': ['step', ['get', 'point_count'], 16, 20, 22, 100, 28] as unknown as number,
          'circle-opacity': 0.92,
        },
      });

      // Cluster count label + min price
      map.current!.addLayer({
        id: 'cluster-count',
        type: 'symbol',
        source: 'bars',
        filter: ['has', 'point_count'],
        layout: {
          'text-field': [
            'concat',
            ['to-string', ['get', 'point_count_abbreviated']],
            ['case',
              ['<', ['get', 'min_price'], 50],
              ['concat', '\n', ['number-format', ['get', 'min_price'], { 'max-fraction-digits': 2 }], '€'],
              '',
            ],
          ] as unknown as string,
          'text-size': 11,
          'text-font': ['DIN Offc Pro Medium', 'Arial Unicode MS Bold'],
          'text-line-height': 1.3,
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
          'circle-radius': 8,
          'circle-color': '#ffffff',
          'circle-opacity': 0.9,
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
          'circle-radius': 6,
          'circle-color': [
            'case',
            ['==', ['get', 'beer_price'], 0], '#9CA3AF',
            ['<=', ['get', 'beer_price'], 5], '#22C55E',
            ['<',  ['get', 'beer_price'], 7], '#F97316',
            '#EF4444',
          ],
          'circle-stroke-width': 0,
          'circle-stroke-color': '#ffffff',
        },
      });

      // Invisible hit-area — bigger click target than the visual dot
      map.current!.addLayer({
        id: 'bars-hitarea',
        type: 'circle',
        source: 'bars',
        filter: ['!', ['has', 'point_count']],
        paint: {
          'circle-radius': 22,
          'circle-opacity': 0,
          'circle-stroke-width': 0,
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

      // Clicking a dot (via hitarea = bigger target) opens the info panel
      map.current!.on('click', 'bars-hitarea', e => {
        if (!e.features?.[0]?.properties) return;
        const p = e.features[0].properties;
        setSelectedBar({
          id: p.id, name: p.name, address: p.address,
          latitude: p.latitude, longitude: p.longitude,
          beer_price: p.beer_price, price_source: p.price_source ?? null,
          phone: p.phone, submitted_by: null, last_updated: p.last_updated,
          serves_beer: p.serves_beer ?? null, amenity_type: p.amenity_type ?? null,
          has_terrace: p.has_terrace ?? null, terrace_grande: p.terrace_grande ?? null,
          opening_hours: p.opening_hours ? JSON.parse(p.opening_hours) : null,
          close_hour: p.close_hour ?? null,
        });
        setShowPriceForm(false);
        setPriceInput('');
        setPriceConfirmed(false);
        setMessage('');
      });

      ['bars-hitarea', 'clusters'].forEach(layer => {
        map.current!.on('mouseenter', layer, () => { map.current!.getCanvas().style.cursor = 'pointer'; });
        map.current!.on('mouseleave', layer, () => { map.current!.getCanvas().style.cursor = ''; });
      });

      // Click on empty map space → dismiss suggestion card / close bar sheet
      map.current!.on('click', e => {
        const hit = map.current!.queryRenderedFeatures(e.point, { layers: ['bars-hitarea', 'clusters'] });
        if (hit.length === 0) {
          setSuggestionDismissed(true);
          setSelectedBar(null);
          setShowPriceForm(false);
          setMessage('');
        }
      });

      // Zoom tracking — reset dismissed state when user zooms back in to street level
      map.current!.on('zoomend', () => {
        if (map.current!.getZoom() >= 13) setSuggestionDismissed(false);
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
    const price = parseFloat(priceInput.replace(',', '.'));

    // ── Validation réaliste (Paris) ────────────────────────────────────────
    // Seuils dérivés statistiquement des données réelles :
    //   hard max = Q3 + 1.5×IQR ≈ 7 + 2.25 = 9.25 → arrondi 9.50€
    //   soft warn = Q3 + 0.5×IQR ≈ 7 + 0.75 = 7.75 → arrondi 8.00€
    const HARD_MAX  = 16.00;
    const SOFT_WARN = 10.00;

    if (isNaN(price) || price < 2.5 || price > HARD_MAX) {
      setMessage(`Prix hors fourchette Paris (2,50 € – ${HARD_MAX.toFixed(2)} €)`);
      return;
    }
    const rounded = Math.round(price * 100) / 100;

    // ── Double confirmation si prix élevé ou écart important ──────────────
    if (!priceConfirmed) {
      // 1. Prix élevé pour Paris
      if (rounded >= SOFT_WARN) {
        setMessage(`${rounded.toFixed(2)} €, c'est cher pour Paris — tu confirmes ?`);
        setPriceConfirmed(true);
        return;
      }
      // 2. Grand écart avec le prix existant
      if (selectedBar.beer_price > 0) {
        const diff = Math.abs(rounded - selectedBar.beer_price);
        const pct  = diff / selectedBar.beer_price;
        if (diff > 1.5 && pct > 0.30) {
          setMessage(`Prix actuel : ${selectedBar.beer_price.toFixed(2)} €. Confirme ${rounded.toFixed(2)} € ?`);
          setPriceConfirmed(true);
          return;
        }
      }
    }

    // ── Calcul du prix final ───────────────────────────────────────────────
    // Si un prix utilisateur existe déjà → moyenne pondérée (lisse les erreurs)
    // Si la source est google/mgb → on écrase (source humaine prime)
    let finalPrice = rounded;
    if (selectedBar.beer_price > 0 && selectedBar.price_source === 'user') {
      finalPrice = Math.round((selectedBar.beer_price + rounded) / 2 * 100) / 100;
    }

    setLoading(true);
    const updatedAt = new Date().toISOString();
    const { error } = await supabase
      .from('bars')
      .update({ beer_price: finalPrice, last_updated: updatedAt, price_source: 'user' })
      .eq('id', selectedBar.id);

    if (error) {
      setMessage('Erreur lors de la soumission.');
    } else {
      setMessage('Merci ! Prix enregistré 🍺');
      setBars(prev => prev.map(b =>
        b.id === selectedBar.id ? { ...b, beer_price: finalPrice, last_updated: updatedAt, price_source: 'user' } : b
      ));
      setTimeout(() => {
        setSelectedBar(null); setShowPriceForm(false);
        setPriceInput(''); setPriceConfirmed(false); setMessage('');
      }, 1600);
    }
    setLoading(false);
  }

  function closeAll() {
    setSelectedBar(null);
    setShowPriceForm(false);
    setMessage('');
    setPriceInput('');
    setPriceConfirmed(false);
  }

  return (
    <div className="fixed inset-0 overflow-hidden" style={{ fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Display", "Segoe UI", sans-serif' }}>

      {/* ── MAP ── */}
      <div ref={mapContainer} className="w-full h-full" />

      {/* ── LOADING OVERLAY ── */}
      {barsLoading && (
        <div className="absolute inset-0 z-50 flex items-center justify-center pointer-events-none">
          <div className="bg-white/90 backdrop-blur-sm rounded-2xl px-5 py-3.5 flex items-center gap-3"
               style={{ boxShadow: '0 2px 16px rgba(0,0,0,0.10)' }}>
            <div className="w-4 h-4 border-2 border-gray-900 border-t-transparent rounded-full animate-spin flex-shrink-0" />
            <span className="text-[13px] font-semibold text-gray-700">Chargement des bars…</span>
          </div>
        </div>
      )}

      {/* ── TOP CHROME ── compact single row, search expands on demand ── */}
      <div
        ref={chromeRef}
        className="absolute top-0 left-0 right-0 z-10 pointer-events-none"
        style={{ paddingTop: 'env(safe-area-inset-top, 0px)' }}
      >
        <div className="px-3 pt-2.5 pb-2.5 flex flex-col gap-1.5 pointer-events-auto">

          {/* Search input — only visible when open */}
          {searchOpen && (
            <div
              className="flex items-center gap-2.5 bg-white/97 rounded-2xl px-3.5 py-2.5 backdrop-blur-sm"
              style={{ boxShadow: '0 1px 12px rgba(0,0,0,0.12), 0 0 0 1px rgba(0,0,0,0.05)' }}
            >
              <svg className="w-3.5 h-3.5 text-gray-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M21 21l-4.35-4.35M17 11A6 6 0 1 1 5 11a6 6 0 0 1 12 0z" />
              </svg>
              <input
                type="text"
                placeholder="Nom du bar…"
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                autoFocus
                className="flex-1 text-[14px] font-medium text-gray-900 placeholder-gray-400 focus:outline-none bg-transparent min-w-0"
              />
              <button
                onClick={() => { setSearchOpen(false); setSearchQuery(''); }}
                className="w-6 h-6 flex items-center justify-center rounded-full bg-gray-100 text-gray-500 text-[11px] flex-shrink-0"
              >✕</button>
            </div>
          )}

          {/* Always-visible row: scrollable chips (left) + pinned legend (right) */}
          {/* Legend is position:absolute so it's always visible even when chips overflow */}
          <div className="relative">

            {/* Scrollable chips — pr-[100px] keeps chips from scrolling under the legend */}
            <div className="flex gap-1.5 items-center overflow-x-auto scrollbar-hide pr-[100px]">

              {/* 🔍 Search toggle */}
              <button
                onClick={() => setSearchOpen(v => !v)}
                className={`flex-shrink-0 flex items-center justify-center rounded-full w-8 h-8 transition-all active:scale-95 ${
                  searchQuery
                    ? 'bg-gray-900 text-white'
                    : 'bg-white/90 text-gray-500 backdrop-blur-sm'
                }`}
                style={{ boxShadow: searchQuery ? 'none' : '0 1px 8px rgba(0,0,0,0.08), 0 0 0 1px rgba(0,0,0,0.04)' }}
                title="Rechercher"
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M21 21l-4.35-4.35M17 11A6 6 0 1 1 5 11a6 6 0 0 1 12 0z" />
                </svg>
              </button>

              {/* Price chips */}
              {([
                { key: 'under4', label: '< 4€' },
                { key: 'under5', label: '< 5€' },
                { key: 'under6', label: '< 6€' },
              ] as const).map(({ key, label }) => (
                <button
                  key={key}
                  onClick={() => setPriceFilter(priceFilter === key ? 'all' : key)}
                  className={`flex-shrink-0 text-xs font-semibold px-3 py-1.5 rounded-full transition-all active:scale-95 ${
                    priceFilter === key ? 'bg-gray-900 text-white' : 'bg-white/90 text-gray-700 backdrop-blur-sm'
                  }`}
                  style={{ boxShadow: priceFilter === key ? 'none' : '0 1px 8px rgba(0,0,0,0.08), 0 0 0 1px rgba(0,0,0,0.04)' }}
                >
                  {label}
                </button>
              ))}

              {/* Terrace chip */}
              <button
                onClick={() => setTerraceFilter(!terraceFilter)}
                className={`flex-shrink-0 text-xs font-semibold px-3 py-1.5 rounded-full transition-all active:scale-95 ${
                  terraceFilter ? 'bg-gray-900 text-white' : 'bg-white/90 text-gray-700 backdrop-blur-sm'
                }`}
                style={{ boxShadow: terraceFilter ? 'none' : '0 1px 8px rgba(0,0,0,0.08), 0 0 0 1px rgba(0,0,0,0.04)' }}
              >
                🌿
              </button>

              {/* Late-close chips */}
              {(['2h', '5h'] as const).map(val => (
                <button
                  key={val}
                  onClick={() => setLateFilter(lateFilter === val ? 'none' : val)}
                  className={`flex-shrink-0 text-xs font-semibold px-3 py-1.5 rounded-full transition-all active:scale-95 ${
                    lateFilter === val ? 'bg-gray-900 text-white' : 'bg-white/90 text-gray-700 backdrop-blur-sm'
                  }`}
                  style={{ boxShadow: lateFilter === val ? 'none' : '0 1px 8px rgba(0,0,0,0.08), 0 0 0 1px rgba(0,0,0,0.04)' }}
                  title={val === '2h' ? 'Ouvert après 2h du matin' : 'Ouvert après 5h du matin'}
                >
                  🌙{val}
                </button>
              ))}

              {/* Reset all filters — only when any filter is active */}
              {isFiltered && (
                <button
                  onClick={() => { setPriceFilter('all'); setTerraceFilter(false); setLateFilter('none'); setSearchQuery(''); setSearchOpen(false); }}
                  className="flex-shrink-0 text-xs font-semibold px-3 py-1.5 rounded-full transition-all active:scale-95 bg-gray-200 text-gray-600"
                >
                  ✕ reset
                </button>
              )}
            </div>

            {/* Color legend — pinned right, always visible, chips scroll under it */}
            {/* The left shadow creates a soft fade effect behind scrolling chips */}
            <div
              className="absolute right-0 inset-y-0 flex items-center pl-6 pointer-events-none"
              style={{ background: 'linear-gradient(to right, transparent 0%, rgba(0,0,0,0.0) 0%)' }}
            >
              <div
                className="flex items-center gap-1 bg-white/95 backdrop-blur-md rounded-full px-2.5 py-1.5 flex-shrink-0 pointer-events-none"
                style={{ boxShadow: '-12px 0 16px 8px rgba(255,255,255,0.6), 0 1px 8px rgba(0,0,0,0.08), 0 0 0 1px rgba(0,0,0,0.04)' }}
              >
                <span className="w-2 h-2 rounded-full bg-green-500 flex-shrink-0" />
                <span className="text-[10px] font-semibold text-gray-500">5€</span>
                <span className="w-2 h-2 rounded-full bg-orange-500 flex-shrink-0 ml-1" />
                <span className="text-[10px] font-semibold text-gray-500">7€</span>
                <span className="w-2 h-2 rounded-full bg-red-500 flex-shrink-0 ml-1" />
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* ── NEARBY SUGGESTION ── */}
      {suggestion && !suggestionDismissed && !selectedBar && !routeInfo && (
        <div
          className="absolute left-3 right-3 z-10 card-appear"
          style={{ bottom: 'calc(env(safe-area-inset-bottom, 16px) + 16px)' }}
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
                  <span className="text-[28px] font-black tabular-nums leading-none" style={{ color: getPriceColor(suggestion.beer_price) }}>
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
          style={{ bottom: 'calc(env(safe-area-inset-bottom, 16px) + 16px)', boxShadow: '0 2px 16px rgba(0,0,0,0.12), 0 0 0 1px rgba(0,0,0,0.04)' }}
        >
          <span className="text-sm">🍺</span>
          <span className="text-[13px] font-bold tabular-nums" style={{ color: getPriceColor(suggestion.beer_price) }}>{suggestion.beer_price.toFixed(2)}€</span>
        </button>
      )}

      {/* ── ROUTE banner ── */}
      {routeInfo && (
        <div
          className="absolute left-3 right-3 z-20 card-appear"
          style={{ bottom: 'calc(env(safe-area-inset-bottom, 16px) + 16px)' }}
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
          className="absolute bottom-0 left-0 right-0 z-30 bg-white sheet-slide-up flex flex-col"
          style={{
            borderRadius: '20px 20px 0 0',
            // Never taller than available space below the actual measured chrome height
            maxHeight: `calc(100dvh - ${chromeH}px - 8px)`,
            boxShadow: '0 -2px 32px rgba(0,0,0,0.10), 0 0 0 1px rgba(0,0,0,0.04)',
          }}
        >
          {/* Handle */}
          <div className="flex justify-center pt-3 pb-1 flex-shrink-0">
            <div className="w-8 h-[3px] rounded-full bg-gray-200" />
          </div>

          {/* ── Scrollable info zone — bottom padding accounts for floating CTA ── */}
          <div className="px-5 pt-2 overflow-y-auto flex-1 min-h-0" style={{ paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 100px)' }}>
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
              <p className="text-[13px] text-gray-400 mb-2 leading-snug">{selectedBar.address}</p>
            )}

            {/* Opening hours */}
            {selectedBar.opening_hours && (() => {
              const todayStr = getTodayHours(selectedBar.opening_hours);
              const open = isOpenNow(selectedBar.opening_hours);
              return (
                <div className="flex items-center gap-2 mb-2">
                  <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${open ? 'bg-green-500' : open === false ? 'bg-red-400' : 'bg-gray-300'}`} />
                  <span className="text-[12px] font-medium text-gray-500">
                    {open === true ? 'Ouvert' : open === false ? 'Fermé' : ''}
                    {todayStr && <span className="text-gray-400"> · {todayStr}</span>}
                  </span>
                </div>
              );
            })()}

            {/* Terrace badge */}
            {selectedBar.has_terrace === true && (
              <span className="inline-flex items-center gap-1 text-[12px] font-semibold text-green-700 bg-green-50 px-2.5 py-1 rounded-full mb-3">
                🌿 {selectedBar.terrace_grande ? 'Grande terrasse' : 'Terrasse'}
              </span>
            )}
            {selectedBar.has_terrace === false && (
              <span className="inline-flex items-center gap-1 text-[12px] font-medium text-gray-400 bg-gray-100 px-2.5 py-1 rounded-full mb-3">
                Pas de terrasse
              </span>
            )}

            {!showPriceForm ? (
              /* Price + date */
              <div className="flex items-end gap-2.5">
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
            ) : (
              /* Price form fields */
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
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── FLOATING CTA — toujours visible, hors du scroll de la fiche ── */}
      {/* kbH > 0 on iOS when virtual keyboard is open — CTA lifts above keyboard */}
      {selectedBar && (
        <div
          className="absolute left-0 right-0 z-40 px-5 transition-[bottom] duration-150"
          style={{ bottom: kbH > 0 ? `${kbH + 12}px` : 'max(20px, env(safe-area-inset-bottom, 20px))' }}
        >
          {!showPriceForm ? (
            <div className="flex flex-col gap-2">
              {/* Y aller — CTA principal, pleine largeur */}
              {userLocation && (
                <button
                  onClick={() => showRoute(selectedBar.latitude, selectedBar.longitude, selectedBar.name)}
                  className="w-full flex items-center justify-center gap-2.5 bg-gray-900 text-white rounded-2xl py-4 font-bold text-[16px] active:bg-gray-700 transition"
                  style={{ boxShadow: '0 4px 24px rgba(0,0,0,0.28)' }}
                >
                  Y aller
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M17 8l4 4m0 0l-4 4m4-4H3" />
                  </svg>
                </button>
              )}
              {/* Suggérer — action secondaire, discrète */}
              <button
                onClick={() => { setShowPriceForm(true); setPriceConfirmed(false); setMessage(''); }}
                className="text-center text-[12px] font-medium text-gray-400 py-1 active:text-gray-600 transition"
              >
                {selectedBar.beer_price > 0 ? 'Signaler un prix incorrect' : 'Suggérer un prix'}
              </button>
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              <div className="flex gap-2.5">
                <button
                  onClick={() => { setShowPriceForm(false); setPriceConfirmed(false); setMessage(''); }}
                  className="flex-1 bg-white text-gray-700 rounded-2xl py-3.5 font-semibold text-[14px] active:bg-gray-100"
                  style={{ boxShadow: '0 2px 12px rgba(0,0,0,0.10), 0 0 0 1px rgba(0,0,0,0.06)' }}
                >Annuler</button>
                <button
                  onClick={submitPrice}
                  disabled={loading}
                  className="flex-1 bg-gray-900 text-white rounded-2xl py-3.5 font-semibold text-[14px] active:bg-gray-700 disabled:opacity-40"
                  style={{ boxShadow: '0 4px 20px rgba(0,0,0,0.25)' }}
                >{loading ? 'Envoi…' : priceConfirmed ? 'Oui, confirmer' : 'Envoyer'}</button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
