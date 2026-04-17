import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';

import { ListProductsQueryDto } from '../../contracts/v1/products/list-products-query.dto';
import { ProductDto } from '../../contracts/v1/products/product.types';

type CreateProductInput = Omit<
  ProductDto,
  'id' | 'storeId' | 'createdAt' | 'updatedAt' | 'version' | 'isArchived' | 'archivedAt'
>;

type UpdateProductInput = Partial<
  Omit<ProductDto, 'id' | 'storeId' | 'createdAt' | 'updatedAt' | 'version'>
>;

@Injectable()
export class ProductsRepository {
  private readonly products = new Map<string, ProductDto>();

  async create(storeId: string, input: CreateProductInput): Promise<ProductDto> {
    const now = new Date().toISOString();
    const product: ProductDto = {
      ...input,
      id: randomUUID(),
      storeId,
      isArchived: false,
      archivedAt: null,
      version: 1,
      createdAt: now,
      updatedAt: now,
    };

    this.products.set(this.key(storeId, product.id), product);
    return product;
  }

  async findById(storeId: string, id: string): Promise<ProductDto | null> {
    return this.products.get(this.key(storeId, id)) ?? null;
  }

  async findByBarcode(storeId: string, barcode: string): Promise<ProductDto | null> {
    for (const product of this.products.values()) {
      if (product.storeId === storeId && product.barcode.toLowerCase() === barcode.toLowerCase()) {
        return product;
      }
    }

    return null;
  }

  async findMany(storeId: string, query: ListProductsQueryDto): Promise<ProductDto[]> {
    const includeArchived = Boolean(query.includeArchived);
    const category = query.category?.trim().toLowerCase();
    const search = query.q?.trim().toLowerCase();

    return [...this.products.values()]
      .filter((p) => p.storeId === storeId)
      .filter((p) => includeArchived || !p.isArchived)
      .filter((p) => (category ? p.category.toLowerCase() === category : true))
      .filter((p) => {
        if (!search) return true;
        return p.name.toLowerCase().includes(search) || p.barcode.toLowerCase().includes(search);
      })
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async update(storeId: string, id: string, input: UpdateProductInput): Promise<ProductDto | null> {
    const existing = await this.findById(storeId, id);
    if (!existing) return null;

    const next: ProductDto = {
      ...existing,
      ...input,
      version: existing.version + 1,
      updatedAt: new Date().toISOString(),
    };

    this.products.set(this.key(storeId, id), next);
    return next;
  }

  async applyStockDelta(
    storeId: string,
    id: string,
    delta: number,
    variant?: string | null,
    color?: string | null,
  ): Promise<ProductDto | null> {
    const existing = await this.findById(storeId, id);
    if (!existing) return null;

    const nextStock = existing.stock + delta;
    if (nextStock < 0) {
      return null;
    }

    const rows = [...existing.stockByVariantColor];
    if (variant || color) {
      const rowIndex = rows.findIndex(
        (row) => row.variant === (variant ?? '') && row.color === (color ?? ''),
      );
      if (rowIndex >= 0) {
        const row = rows[rowIndex];
        const nextRowStock = row.stock + delta;
        if (nextRowStock < 0) {
          return null;
        }
        rows[rowIndex] = { ...row, stock: nextRowStock };
      }
    }

    return this.update(storeId, id, {
      stock: nextStock,
      stockByVariantColor: rows,
    });
  }

  async archive(storeId: string, id: string): Promise<ProductDto | null> {
    return this.update(storeId, id, {
      isArchived: true,
      archivedAt: new Date().toISOString(),
    });
  }

  private key(storeId: string, id: string): string {
    return `${storeId}::${id}`;
  }
}
