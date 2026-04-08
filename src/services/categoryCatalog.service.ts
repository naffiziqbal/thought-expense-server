import fs from 'fs';
import path from 'path';

interface CatalogItem {
  id: string;
  name: string;
}

interface CatalogCategory {
  id: string;
  name: string;
  items: CatalogItem[];
}

interface CatalogFile {
  categories: CatalogCategory[];
}

interface IndexedItem {
  categoryName: string;
  keywords: string[];
}

let indexedItems: IndexedItem[] | null = null;

const normalize = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const splitKeywords = (text: string): string[] =>
  normalize(text)
    .split(' ')
    .map((k) => k.trim())
    .filter((k) => k.length >= 3);

const loadCatalog = (): IndexedItem[] => {
  if (indexedItems) return indexedItems;

  const filePath = path.join(process.cwd(), 'expense.json');
  const raw = fs.readFileSync(filePath, 'utf8');
  const catalog = JSON.parse(raw) as CatalogFile;

  const indexed: IndexedItem[] = [];
  for (const category of catalog.categories || []) {
    for (const item of category.items || []) {
      const keywords = new Set<string>([
        ...splitKeywords(item.name),
        ...splitKeywords(item.id.replace(/_/g, ' ')),
      ]);
      indexed.push({
        categoryName: category.name,
        keywords: Array.from(keywords),
      });
    }
  }

  indexedItems = indexed;
  return indexed;
};

export const findCategoryFromCatalog = (description: string): string | null => {
  const text = normalize(description);
  if (!text) return null;

  const catalog = loadCatalog();
  let best: { categoryName: string; score: number } | null = null;

  for (const item of catalog) {
    let score = 0;
    for (const keyword of item.keywords) {
      if (text.includes(keyword)) score += keyword.length >= 6 ? 2 : 1;
    }

    if (score > 0 && (!best || score > best.score)) {
      best = { categoryName: item.categoryName, score };
    }
  }

  return best ? best.categoryName : null;
};

