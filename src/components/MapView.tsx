'use client';

// This is the main component of the app.
// It renders the Mapbox map, loads bars from Supabase,
// shows colored pins, and handles popups + forms.

import { useEffect, useRef, useState } from 'react';
import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';
import { supabase, type Bar } from '@/lib/supabase';

// Returns a color based on the beer price
function getPriceColor(price: number): string {
  if (price === 0) return '#9CA3AF'; // grey  = unknown
  if (price < 5)   return '#22C55E'; // green = cheap (< €5)
  if (price <= 8)  return '#F97316'; // orange = mid (€5–€8)
  return '#EF4444';                  // red   = expensive (> €8)
}

// Formats the price for display
function formatPrice(price: number): string {
  if (price === 0) return 'Prix inconnu';
  return `${price.toFixed(2)} €`;
}

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

  // --- Load all bars from Supabase on first render ---
  // We first get the total count, then fire all batch requests in parallel
  useEffect(() => {
    async function loadBars() {
      // Step 1: get total row count
      const { count } = await supabase
        .from('bars')
        .select('*', { count: 'exact', head: true });

      if (!count) return;

      // Step 2: fire all batch requests at the same time (parallel, not sequential)
      const batchSize = 1000;
      const numBatches = Math.ceil(count / batchSize);
      const requests = Array.from({ length: numBatches }, (_, i) =>
        supabase
          .from('bars')
          .select('id,name,address,latitude,longitude,beer_price,phone,last_updated')
          .range(i * batchSize, (i + 1) * batchSize - 1)
      );

      const results = await Promise.all(requests);
      const allBars = results.flatMap(r => r.data || []) as Bar[];
      setBars(allBars);
    }
    loadBars();
  }, []);

  // --- Initialize the Mapbox map ---
  useEffect(() => {
    if (!mapContainer.current || map.current) return;

    const token = process.env.NEXT_PUBLIC_MAPBOX_TOKEN;
    if (!token) {
      console.error('Mapbox token is missing — check your .env.local file');
      return;
    }

    mapboxgl.accessToken = token;

    map.current = new mapboxgl.Map({
      container: mapContainer.current,
      style: 'mapbox://styles/mapbox/streets-v12',
      center: [2.3622, 48.8729], // Paris 10th arrondissement
      zoom: 14,
    });

    map.current.on('error', (e) => console.error('Mapbox error:', e));

    // Zoom controls (top right)
    map.current.addControl(new mapboxgl.NavigationControl(), 'top-right');

    // Geolocation button — on mobile, automatically centers the map on the user
    const geolocate = new mapboxgl.GeolocateControl({
      positionOptions: { enableHighAccuracy: true },
      trackUserLocation: true,
      showUserHeading: true,
    });
    map.current.addControl(geolocate, 'top-right');

    // On mobile, trigger geolocation automatically when the map loads
    map.current.on('load', () => {
      if (/Mobi|Android|iPhone/i.test(navigator.userAgent)) {
        geolocate.trigger();
      }
    });
  }, []);

  // --- Add bars as colored dots on the map ---
  useEffect(() => {
    if (!map.current || bars.length === 0) return;

    function addBarsToMap() {
      // Convert bars array to GeoJSON format (what Mapbox expects)
      const geojson: GeoJSON.FeatureCollection = {
        type: 'FeatureCollection',
        features: bars.map(bar => ({
          type: 'Feature',
          geometry: {
            type: 'Point',
            coordinates: [bar.longitude, bar.latitude],
          },
          properties: { ...bar },
        })),
      };

      // If source already exists (e.g. after a price update), just refresh the data
      if (map.current!.getSource('bars')) {
        (map.current!.getSource('bars') as mapboxgl.GeoJSONSource).setData(geojson);
        return;
      }

      // Register the GeoJSON source with clustering enabled
      // Clustering groups nearby pins together when zoomed out
      map.current!.addSource('bars', {
        type: 'geojson',
        data: geojson,
        cluster: true,
        clusterMaxZoom: 14, // stop clustering when zoomed in past level 14
        clusterRadius: 40,  // how close points need to be to cluster (pixels)
      });

      // Cluster bubble (the circle showing grouped bars)
      map.current!.addLayer({
        id: 'clusters',
        type: 'circle',
        source: 'bars',
        filter: ['has', 'point_count'], // only show when it's a cluster
        paint: {
          'circle-color': '#3B82F6',
          // Bigger bubble = more bars inside
          'circle-radius': ['step', ['get', 'point_count'], 16, 20, 22, 100, 28],
          'circle-opacity': 0.85,
        },
      });

      // Number inside the cluster bubble
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
        filter: ['!', ['has', 'point_count']], // only individual bars (not clusters)
        paint: {
          'circle-radius': 9,
          'circle-color': '#ffffff',
          'circle-opacity': 0.9,
        },
      });

      // Colored dot — color depends on beer_price
      map.current!.addLayer({
        id: 'bars-circle',
        type: 'circle',
        source: 'bars',
        filter: ['!', ['has', 'point_count']],
        paint: {
          'circle-radius': 7,
          'circle-color': [
            'case',
            ['==', ['get', 'beer_price'], 0], '#9CA3AF', // grey
            ['<',  ['get', 'beer_price'], 5], '#22C55E', // green
            ['<=', ['get', 'beer_price'], 8], '#F97316', // orange
            '#EF4444',                                    // red
          ],
        },
      });

      // Clicking a cluster zooms in to expand it
      map.current!.on('click', 'clusters', (e) => {
        if (!e.features?.[0]) return;
        const clusterId = e.features[0].properties!.cluster_id;
        (map.current!.getSource('bars') as mapboxgl.GeoJSONSource)
          .getClusterExpansionZoom(clusterId, (err, zoom) => {
            if (err || !e.features?.[0].geometry) return;
            const coords = (e.features[0].geometry as GeoJSON.Point).coordinates as [number, number];
            map.current!.easeTo({ center: coords, zoom: zoom! });
          });
      });

      // Clicking a dot opens the bar info panel
      map.current!.on('click', 'bars-circle', (e) => {
        if (!e.features?.[0]?.properties) return;
        const p = e.features[0].properties;
        setSelectedBar({
          id: p.id,
          name: p.name,
          address: p.address,
          latitude: p.latitude,
          longitude: p.longitude,
          beer_price: p.beer_price,
          phone: p.phone,
          submitted_by: p.submitted_by,
          last_updated: p.last_updated,
        });
        setShowPriceForm(false);
        setShowAddForm(false);
        setPriceInput('');
        setMessage('');
      });

      // Pointer cursor on hover
      ['bars-circle', 'clusters'].forEach(layer => {
        map.current!.on('mouseenter', layer, () => {
          map.current!.getCanvas().style.cursor = 'pointer';
        });
        map.current!.on('mouseleave', layer, () => {
          map.current!.getCanvas().style.cursor = '';
        });
      });
    }

    if (map.current.isStyleLoaded()) {
      addBarsToMap();
    } else {
      map.current.on('load', addBarsToMap);
    }
  }, [bars]);

  // --- Submit a new price for an existing bar ---
  async function submitPrice() {
    if (!selectedBar || !priceInput) return;
    const price = parseFloat(priceInput);
    if (isNaN(price) || price <= 0) {
      setMessage("Entre un prix valide (ex: 5.50)");
      return;
    }
    setLoading(true);
    const { error } = await supabase
      .from('bars')
      .update({ beer_price: price, last_updated: new Date().toISOString() })
      .eq('id', selectedBar.id);

    if (error) {
      setMessage("Erreur lors de la soumission.");
    } else {
      setMessage("Prix soumis, merci !");
      // Refresh map data
      const { data } = await supabase.from('bars').select('*');
      if (data) setBars(data as Bar[]);
      setTimeout(() => {
        setSelectedBar(null);
        setShowPriceForm(false);
        setPriceInput('');
        setMessage('');
      }, 1500);
    }
    setLoading(false);
  }

  // --- Add a brand new bar ---
  async function addNewBar() {
    if (!newBar.name || !newBar.address || !newBar.price) {
      setMessage("Tous les champs sont obligatoires.");
      return;
    }
    const price = parseFloat(newBar.price);
    if (isNaN(price) || price <= 0) {
      setMessage("Entre un prix valide (ex: 5.50)");
      return;
    }
    setLoading(true);

    // Use Mapbox Geocoding API to convert the address into coordinates
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

    const { error } = await supabase.from('bars').insert({
      name: newBar.name,
      address: newBar.address,
      latitude,
      longitude,
      beer_price: price,
      submitted_by: 'user',
    });

    if (error) {
      setMessage("Erreur lors de l'ajout.");
    } else {
      setMessage("Bar ajouté, merci !");
      const { data } = await supabase.from('bars').select('*');
      if (data) setBars(data as Bar[]);
      setTimeout(() => {
        setShowAddForm(false);
        setNewBar({ name: '', address: '', price: '' });
        setMessage('');
      }, 1500);
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

      {/* The map — takes up the full screen */}
      <div ref={mapContainer} className="absolute inset-0" style={{ width: '100%', height: '100%' }} />

      {/* Top-left button: add a new bar */}
      <button
        onClick={() => { closeAll(); setShowAddForm(true); }}
        className="absolute top-4 left-4 z-10 bg-blue-600 hover:bg-blue-700 text-white font-semibold text-sm px-4 py-2 rounded-full shadow-lg transition"
      >
        + Ajouter un bar
      </button>

      {/* Bottom-left: price legend */}
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

      {/* Bar info panel — slides up from bottom when a pin is clicked */}
      {selectedBar && !showAddForm && (
        <div className="absolute bottom-0 left-0 right-0 z-20 bg-white rounded-t-3xl shadow-2xl px-5 pt-5 pb-8 max-w-lg mx-auto">
          {/* Drag handle */}
          <div className="w-10 h-1 bg-gray-200 rounded-full mx-auto mb-4" />

          <div className="flex justify-between items-start mb-3">
            <div className="flex-1 pr-3">
              <h2 className="text-lg font-bold text-gray-900 leading-tight">{selectedBar.name}</h2>
              {selectedBar.address && (
                <p className="text-sm text-gray-500 mt-0.5">{selectedBar.address}</p>
              )}
              {selectedBar.phone && (
                <a href={`tel:${selectedBar.phone}`} className="text-sm text-blue-500 mt-0.5 block">
                  {selectedBar.phone}
                </a>
              )}
            </div>
            <button onClick={closeAll} className="text-gray-300 hover:text-gray-500 text-2xl leading-none">✕</button>
          </div>

          {/* Price display */}
          <div className="flex items-center gap-2 mb-4">
            <span
              className="w-4 h-4 rounded-full flex-shrink-0"
              style={{ backgroundColor: getPriceColor(selectedBar.beer_price) }}
            />
            <span className="text-2xl font-bold text-gray-900">
              {formatPrice(selectedBar.beer_price)}
            </span>
            {selectedBar.beer_price > 0 && (
              <span className="text-xs text-gray-400 ml-1">
                · {new Date(selectedBar.last_updated).toLocaleDateString('fr-FR')}
              </span>
            )}
          </div>

          {/* Submit price button or form */}
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
                type="number"
                step="0.1"
                min="0"
                placeholder="Prix en € (ex: 5.50)"
                value={priceInput}
                onChange={e => setPriceInput(e.target.value)}
                className="w-full border border-gray-200 rounded-2xl px-4 py-3.5 text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
                autoFocus
              />
              {message && (
                <p className="text-sm text-center text-green-600 font-medium">{message}</p>
              )}
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
              type="text"
              placeholder="Nom du bar"
              value={newBar.name}
              onChange={e => setNewBar(b => ({ ...b, name: e.target.value }))}
              className="w-full border border-gray-200 rounded-2xl px-4 py-3.5 text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <input
              type="text"
              placeholder="Adresse (ex: 10 rue de la Paix)"
              value={newBar.address}
              onChange={e => setNewBar(b => ({ ...b, address: e.target.value }))}
              className="w-full border border-gray-200 rounded-2xl px-4 py-3.5 text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <input
              type="number"
              step="0.1"
              min="0"
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
