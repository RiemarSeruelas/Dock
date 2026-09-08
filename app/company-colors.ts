export const supplierHue = (id?: number | null, name = '') => id ? Math.round(Number(id) * 137.508) % 360 : [...name.toLowerCase()].reduce((hash, char) => (hash * 31 + char.charCodeAt(0)) % 360, 0);
