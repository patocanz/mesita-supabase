// Geo helpers shared by recommender, search, and distance EFs.

// Haversine distance in km between two lat/lng pairs. Returns +Infinity if
// either point is missing so the caller's `<= radius` filter cleanly drops it.
export function haversineKm(
  lat1: number,
  lng1: number,
  lat2: number | null,
  lng2: number | null,
): number {
  if (lat2 == null || lng2 == null) return Number.POSITIVE_INFINITY;
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

// Bounding-box deltas for a radius-around-a-point search. Latitude is ~111km
// per degree everywhere; longitude shrinks with cos(lat) toward the poles so
// we widen the lng span proportionally. The cos floor (0.1) keeps the math
// finite at very high latitudes — Mesita doesn't operate there but cheap to
// be defensive.
export function radiusBoundingBox(
  lat: number,
  radiusKm: number,
): { latDelta: number; lngDelta: number } {
  const latDelta = radiusKm / 111;
  const lngDelta = radiusKm / (111 * Math.max(0.1, Math.cos((lat * Math.PI) / 180)));
  return { latDelta, lngDelta };
}
