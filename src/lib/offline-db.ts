import Dexie, { type Table } from "dexie";

export type CachedMenuItem = {
  id: string;
  name: string;
  category_id: string;
  base_price: number;
  target_station: "BARISTA" | "KITCHEN";
  is_available: boolean;
  is_active: boolean;
  image_url: string | null;
  makeable: number | null;
};
export type CachedCategory = { id: string; name: string; sort_order: number };

export type QueuedOrder = {
  client_id: string;
  payload: Record<string, unknown>;
  total: number;
  created_at: string;
  attempts: number;
  last_error?: string;
};

class CantiDB extends Dexie {
  menu!: Table<CachedMenuItem, string>;
  categories!: Table<CachedCategory, string>;
  queue!: Table<QueuedOrder, string>;
  constructor() {
    super("cantilounge-hub");
    this.version(1).stores({
      menu: "id, category_id",
      categories: "id, sort_order",
      queue: "client_id, created_at",
    });
  }
}

let _db: CantiDB | null = null;
// Lazy: IndexedDB only exists in the browser.
export function db() {
  if (!_db) _db = new CantiDB();
  return _db;
}
