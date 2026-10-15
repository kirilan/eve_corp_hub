// CCP's image server; safe to import from client components.
export function typeIconUrl(typeId: number, size: 32 | 64 = 32) {
  return `https://images.evetech.net/types/${typeId}/icon?size=${size}`;
}
