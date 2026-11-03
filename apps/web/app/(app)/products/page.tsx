'use client';
import { formatGBP, VAT_LABELS } from '@retail/shared';
import { Package, Plus, Search, ShieldAlert } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Badge, Button, Card, EmptyState, ErrorNote, Input, LoadingRows, PageHeader, Select, Table, Td, Th } from '@/components/ui';
import { useApi } from '@/lib/api';
import { useDebounced } from '@/lib/hooks';
import { useMe } from '@/lib/me';

export default function ProductsPage() {
  const router = useRouter();
  const { can } = useMe();
  const [q, setQ] = useState('');
  const [cat, setCat] = useState('');
  const dq = useDebounced(q);
  const cats = useApi<any[]>('/v1/categories');
  const products = useApi<any[]>(`/v1/products?limit=500${dq ? `&q=${encodeURIComponent(dq)}` : ''}${cat ? `&category_id=${cat}` : ''}`);
  const catName = new Map((cats.data ?? []).map((c) => [c.id, c.name]));
  const showCost = can('reports.financial');

  return (
    <>
      <PageHeader title="Products & prices" description="Everything you sell, with barcodes, VAT and prices. Price changes are kept as history."
        actions={can('products.edit') && <Link href="/products/new"><Button icon={<Plus className="size-4" />}>Add product</Button></Link>} />
      <Card>
        <div className="flex flex-col gap-3 border-b border-line p-4 sm:flex-row">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-subtle" aria-hidden />
            <label htmlFor="q" className="sr-only">Search products</label>
            <Input id="q" placeholder="Search by name, SKU or scan a barcode" value={q} onChange={(e) => setQ(e.target.value)} className="pl-9" />
          </div>
          <label htmlFor="cat" className="sr-only">Category</label>
          <Select id="cat" value={cat} onChange={(e) => setCat(e.target.value)} className="sm:w-56">
            <option value="">All categories</option>
            {(cats.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
        </div>
        <ErrorNote error={products.error} />
        {products.isLoading && !products.data ? <LoadingRows /> : products.data?.length === 0 ? (
          <EmptyState icon={<Package className="size-6" />} title={q ? 'No products match your search' : 'No products yet'}
            action={can('products.edit') && !q && <Link href="/products/new"><Button>Add your first product</Button></Link>}>
            {q ? 'Try a shorter name or scan the barcode.' : 'Add products one by one, or scan an unknown barcode at the till.'}
          </EmptyState>
        ) : (
          <Table>
            <thead><tr>
              <Th>Product</Th><Th>Category</Th><Th>Barcode</Th><Th>VAT</Th><Th align="right">Price</Th>
              {showCost && <><Th align="right">Avg cost</Th><Th align="right">Margin</Th></>}
            </tr></thead>
            <tbody>
              {products.data?.map((p) => {
                const net = p.retail_price_pence === null ? null : p.vat_code === 'S' ? p.retail_price_pence / 1.2 : p.vat_code === 'R' ? p.retail_price_pence / 1.05 : p.retail_price_pence;
                const margin = net && p.avg_cost_pence ? ((net - p.avg_cost_pence) / net) * 100 : null;
                return (
                  <tr key={p.id} className="cursor-pointer hover:bg-surface/70" onClick={() => router.push(`/products/${p.id}`)}>
                    <Td>
                      <Link href={`/products/${p.id}`} className="font-medium text-ink hover:text-brand" onClick={(e) => e.stopPropagation()}>{p.name}</Link>
                      <div className="mt-0.5 flex gap-1.5">
                        {p.min_age && <Badge tone="danger"><ShieldAlert className="size-3" aria-hidden />{p.min_age}+</Badge>}
                        {p.sold_by_weight && <Badge>Sold by weight</Badge>}
                        {p.archived_at && <Badge>Archived</Badge>}
                      </div>
                    </Td>
                    <Td className="text-muted">{catName.get(p.category_id) ?? '—'}</Td>
                    <Td className="font-mono text-xs text-muted">{p.barcode ?? '—'}</Td>
                    <Td><Badge tone={p.vat_code === 'S' ? 'brand' : 'neutral'}>{VAT_LABELS[p.vat_code]}</Badge></Td>
                    <Td align="right" className="font-medium">{p.retail_price_pence === null ? <span className="text-warning">No price</span> : formatGBP(p.retail_price_pence)}</Td>
                    {showCost && <>
                      <Td align="right" className="text-muted">{p.avg_cost_pence ? formatGBP(p.avg_cost_pence) : '—'}</Td>
                      <Td align="right" className={margin !== null && margin < 15 ? 'text-danger font-medium' : ''}>{margin === null ? '—' : `${margin.toFixed(0)}%`}</Td>
                    </>}
                  </tr>
                );
              })}
            </tbody>
          </Table>
        )}
      </Card>
      {products.data && <p className="mt-3 text-sm text-subtle">{products.data.length} products. Margins are on the retail price excluding VAT.</p>}
    </>
  );
}
