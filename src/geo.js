// Geo helpers: distance + geocoding via OpenStreetMap Nominatim (free, no key).

export function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

const cache = new Map();

/** Returns up to 5 matches [{ name, lat, lng }] near an optional bias point. */
export async function geocode(query, near) {
  const key = `${query}|${near ? `${near.lat.toFixed(3)},${near.lng.toFixed(3)}` : ''}`;
  if (cache.has(key)) return cache.get(key);
  const params = new URLSearchParams({ q: query, format: 'jsonv2', limit: '5' });
  if (near) {
    const d = 0.08; // ~8 km viewbox bias
    params.set('viewbox', `${near.lng - d},${near.lat + d},${near.lng + d},${near.lat - d}`);
    params.set('bounded', '0');
  }
  const res = await fetch(`https://nominatim.openstreetmap.org/search?${params}`, {
    headers: { 'User-Agent': 'GroundTruth-hackathon-demo/0.1 (PayPal AI Hackathon project)' },
  });
  if (!res.ok) throw new Error(`Geocoding failed (HTTP ${res.status})`);
  const rows = await res.json();
  const out = rows.map((r) => ({ name: r.display_name, lat: Number(r.lat), lng: Number(r.lon) }));
  cache.set(key, out);
  return out;
}
