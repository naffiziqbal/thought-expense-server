/**
 * Align PostgreSQL category strings with backend/expense.json (canonical parent names).
 *
 * Usage (from backend/):
 *   npx ts-node -r dotenv/config src/scripts/syncExpenseCatalogToProduction.ts           # dry-run
 *   npx ts-node -r dotenv/config src/scripts/syncExpenseCatalogToProduction.ts --apply   # write
 *
 * Optional:
 *   --reflow-descriptions  Also set category from findCategoryFromCatalog(description)
 *                            when it differs (more aggressive; uses current keyword rules).
 */

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import prisma from '../config/prisma';
import { findCategoryFromCatalog } from '../services/categoryCatalog.service';

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

const expenseJsonPath = path.join(__dirname, '../../expense.json');

function loadCatalog(): CatalogFile {
  const raw = fs.readFileSync(expenseJsonPath, 'utf8');
  return JSON.parse(raw) as CatalogFile;
}

/** Canonical parent names + lookup maps for legacy strings (item labels, ids, casing). */
function buildCatalogMaps(catalog: CatalogFile) {
  const canonicalNames = new Set<string>();
  const lowerToCanonical = new Map<string, string>();
  const aliasToCanonical = new Map<string, string>();

  const addAlias = (alias: string, canonical: string) => {
    const key = alias.trim().toLowerCase();
    if (!key) return;
    if (!aliasToCanonical.has(key)) aliasToCanonical.set(key, canonical);
  };

  for (const c of catalog.categories || []) {
    const parent = c.name.trim();
    if (!parent) continue;
    canonicalNames.add(parent);
    lowerToCanonical.set(parent.toLowerCase(), parent);
    addAlias(c.id, parent);
    addAlias(c.name, parent);
    for (const item of c.items || []) {
      addAlias(item.id, parent);
      addAlias(item.name, parent);
      addAlias(item.id.replace(/_/g, ' '), parent);
    }
  }

  return { canonicalNames, lowerToCanonical, aliasToCanonical };
}

function resolveStoredCategory(
  raw: string,
  maps: ReturnType<typeof buildCatalogMaps>
): string | null {
  const s = raw.trim();
  if (!s) return null;
  if (maps.canonicalNames.has(s)) return s;
  const byLower = maps.lowerToCanonical.get(s.toLowerCase());
  if (byLower) return byLower;
  const byAlias = maps.aliasToCanonical.get(s.toLowerCase());
  if (byAlias) return byAlias;
  return null;
}

function parseArgs(argv: string[]) {
  return {
    apply: argv.includes('--apply'),
    reflowDescriptions: argv.includes('--reflow-descriptions'),
  };
}

async function main() {
  const { apply, reflowDescriptions } = parseArgs(process.argv.slice(2));

  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set. Load .env or export it for production.');
    process.exit(1);
  }

  const catalog = loadCatalog();
  const maps = buildCatalogMaps(catalog);

  const expenseCategories = await prisma.expense.findMany({
    distinct: ['category'],
    select: { category: true },
  });
  const budgetCategories = await prisma.categoryBudget.findMany({
    distinct: ['category'],
    select: { category: true },
  });
  const mappingCategories = await prisma.categoryMapping.findMany({
    distinct: ['category'],
    select: { category: true },
  });

  const distinct = new Set<string>();
  for (const r of expenseCategories) distinct.add(r.category);
  for (const r of budgetCategories) distinct.add(r.category);
  for (const r of mappingCategories) distinct.add(r.category);

  const renameMap = new Map<string, string>();
  for (const cat of distinct) {
    const resolved = resolveStoredCategory(cat, maps);
    if (resolved && resolved !== cat) {
      renameMap.set(cat, resolved);
    }
  }

  console.log(`Catalog: ${maps.canonicalNames.size} parent categories from ${expenseJsonPath}`);
  console.log(`Distinct category strings in DB: ${distinct.size}`);
  console.log(`Renames from alias / casing normalization: ${renameMap.size}`);
  for (const [from, to] of [...renameMap.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    console.log(`  "${from}" → "${to}"`);
  }

  const unknown = [...distinct].filter(
    (c) => !maps.canonicalNames.has(c.trim()) && !resolveStoredCategory(c, maps)
  );
  if (unknown.length) {
    console.log(`\nNot mapped to catalog (no automatic rename): ${unknown.length}`);
    unknown.sort().forEach((u) => console.log(`  - ${JSON.stringify(u)}`));
  }

  const reflowExpenseIds: { id: string; from: string; to: string }[] = [];
  if (reflowDescriptions) {
    const expenses = await prisma.expense.findMany({
      select: { id: true, description: true, category: true },
    });
    for (const e of expenses) {
      const fromCat = findCategoryFromCatalog(e.description);
      if (fromCat && fromCat !== e.category) {
        reflowExpenseIds.push({ id: e.id, from: e.category, to: fromCat });
      }
    }
    console.log(
      `\n--reflow-descriptions: would change ${reflowExpenseIds.length} expenses by description match`
    );
    const preview = reflowExpenseIds.slice(0, 20);
    for (const r of preview) {
      console.log(`  ${r.id}: "${r.from}" → "${r.to}"`);
    }
    if (reflowExpenseIds.length > 20) console.log(`  ... and ${reflowExpenseIds.length - 20} more`);
  }

  if (!apply) {
    console.log('\nDry run only. Re-run with --apply to write changes.');
    await prisma.$disconnect();
    return;
  }

  await prisma.$transaction(async (tx) => {
    for (const [from, to] of renameMap) {
      await tx.expense.updateMany({
        where: { category: from },
        data: { category: to },
      });
    }

    for (const [from, to] of renameMap) {
      const rows = await tx.categoryBudget.findMany({ where: { category: from } });
      for (const row of rows) {
        const twin = await tx.categoryBudget.findUnique({
          where: {
            userId_month_year_category: {
              userId: row.userId,
              month: row.month,
              year: row.year,
              category: to,
            },
          },
        });
        if (twin) {
          await tx.categoryBudget.update({
            where: { id: twin.id },
            data: { limit: twin.limit + row.limit },
          });
          await tx.categoryBudget.delete({ where: { id: row.id } });
        } else {
          await tx.categoryBudget.update({
            where: { id: row.id },
            data: { category: to },
          });
        }
      }
    }

    for (const [from, to] of renameMap) {
      const rows = await tx.categoryMapping.findMany({ where: { category: from } });
      for (const row of rows) {
        const existing = await tx.categoryMapping.findUnique({
          where: {
            userId_keyword_category: {
              userId: row.userId,
              keyword: row.keyword,
              category: to,
            },
          },
        });
        if (existing) {
          await tx.categoryMapping.update({
            where: { id: existing.id },
            data: {
              confidence: Math.max(existing.confidence, row.confidence),
            },
          });
          await tx.categoryMapping.delete({ where: { id: row.id } });
        } else {
          await tx.categoryMapping.update({
            where: { id: row.id },
            data: { category: to },
          });
        }
      }
    }

    if (reflowDescriptions) {
      for (const r of reflowExpenseIds) {
        await tx.expense.update({
          where: { id: r.id },
          data: { category: r.to },
        });
      }
    }
  });

  console.log(
    '\nApplied updates. Pinecone vectors still use old metadata until embeddings are refreshed (e.g. PATCH each expense or a future vector sync job).'
  );
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
