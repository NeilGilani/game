// Typed access to src/data/photos.json: every photograph of people on the site, with its licence and source.
import raw from "./photos.json";

export interface PhotoCredit {
  id: string;
  file: string;
  title: string;
  author: string;
  authorUrl?: string;
  source: string;
  foundVia: string;
  license: string;
  licenseUrl: string;
  changes: string;
  alt: string;
}

export const photos: PhotoCredit[] = raw.photos;
export const PHOTOS_CHECKED: string = raw.checked;

export function photo(id: string): PhotoCredit {
  const found = photos.find((p) => p.id === id);
  if (!found) throw new Error(`Unknown photo: ${id}`);
  return found;
}
