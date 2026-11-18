const EARTH_RADIUS_KM = 6371.0088;
export const CONNECT_KM = 1.0;
export const CONNECT_MS = 360 * 60_000;
const CELL_DEG = 0.02; // ~2.2 km: a 3x3 neighbourhood covers every 1 km neighbour for |lat| < 60

const rad = (deg: number) => (deg * Math.PI) / 180;

export function haversineKm(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const dLat = rad(bLat - aLat);
  const dLon = rad(bLon - aLon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

export const cellCoords = (lat: number, lon: number): [number, number] => [Math.floor(lon / CELL_DEG), Math.floor(lat / CELL_DEG)];
export const cellKey = (cx: number, cy: number): string => `${cx}:${cy}`;
