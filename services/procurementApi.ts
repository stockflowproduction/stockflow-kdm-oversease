import { PurchaseOrder, PurchaseParty } from '../types';

const env = (import.meta as any)?.env || {};
const API_BASE = (env.VITE_BACKEND_BASE_URL || env.VITE_API_BASE_URL || '').replace(/\/$/, '');
const PROCUREMENT_BACKEND_ENABLED = String(env.VITE_PROCUREMENT_BACKEND_ENABLED || 'false').toLowerCase() === 'true';
const PROCUREMENT_SHADOW_COMPARE = String(env.VITE_PROCUREMENT_SHADOW_COMPARE || 'false').toLowerCase() === 'true';

const baseUrl = (path: string) => `${API_BASE}${path}`;

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(baseUrl(path), {
    headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) },
    ...init,
  });
  if (!response.ok) {
    throw new Error(`procurement api request failed: ${response.status}`);
  }
  return response.json() as Promise<T>;
}

export const procurementFlags = {
  PROCUREMENT_BACKEND_ENABLED,
  PROCUREMENT_SHADOW_COMPARE,
};

export const procurementApi = {
  async listParties(query?: { q?: string; includeArchived?: boolean }): Promise<{ items: PurchaseParty[] }> {
    const params = new URLSearchParams();
    if (query?.q) params.set('q', query.q);
    if (query?.includeArchived !== undefined) params.set('includeArchived', String(query.includeArchived));
    return request(`/procurement/parties${params.toString() ? `?${params.toString()}` : ''}`);
  },
  getPartyById(id: string): Promise<{ party: PurchaseParty }> { return request(`/procurement/parties/${id}`); },
  createParty(payload: Partial<PurchaseParty>): Promise<{ party: PurchaseParty }> { return request('/procurement/parties', { method: 'POST', body: JSON.stringify(payload) }); },
  updateParty(id: string, payload: Partial<PurchaseParty> & { expectedVersion?: number }): Promise<{ party: PurchaseParty }> { return request(`/procurement/parties/${id}`, { method: 'PATCH', body: JSON.stringify(payload) }); },
  async listOrders(query?: { q?: string; status?: string; partyId?: string }): Promise<{ items: PurchaseOrder[] }> {
    const params = new URLSearchParams();
    if (query?.q) params.set('q', query.q);
    if (query?.status) params.set('status', query.status);
    if (query?.partyId) params.set('partyId', query.partyId);
    return request(`/procurement/orders${params.toString() ? `?${params.toString()}` : ''}`);
  },
  getOrderById(id: string): Promise<{ order: PurchaseOrder }> { return request(`/procurement/orders/${id}`); },
  createOrder(payload: Partial<PurchaseOrder>): Promise<{ order: PurchaseOrder }> { return request('/procurement/orders', { method: 'POST', body: JSON.stringify(payload) }); },
  updateOrder(id: string, payload: Partial<PurchaseOrder> & { expectedVersion?: number }): Promise<{ order: PurchaseOrder }> { return request(`/procurement/orders/${id}`, { method: 'PATCH', body: JSON.stringify(payload) }); },
  receiveOrder(id: string, payload: { orderId: string; expectedVersion?: number; receiveMethod: 'avg_method_1' | 'avg_method_2' | 'no_change' | 'latest_purchase'; note?: string }) {
    return request(`/procurement/orders/${id}/receive`, { method: 'POST', body: JSON.stringify(payload) });
  },
};

export const runProcurementShadowCompare = async (legacy: { orders: PurchaseOrder[]; parties: PurchaseParty[] }): Promise<void> => {
  if (!PROCUREMENT_SHADOW_COMPARE || !API_BASE) return;
  try {
    const [backendParties, backendOrders] = await Promise.all([procurementApi.listParties(), procurementApi.listOrders()]);
    const partyCountMatch = backendParties.items.length === legacy.parties.length;
    const orderCountMatch = backendOrders.items.length === legacy.orders.length;
    const legacyPartyIds = new Set(legacy.parties.map((p) => p.id));
    const backendPartyIds = new Set(backendParties.items.map((p) => p.id));
    const legacyOrderIds = new Set(legacy.orders.map((o) => o.id));
    const backendOrderIds = new Set(backendOrders.items.map((o) => o.id));
    const missingPartyIds = [...legacyPartyIds].filter((id) => !backendPartyIds.has(id));
    const missingOrderIds = [...legacyOrderIds].filter((id) => !backendOrderIds.has(id));
    const partyIdsMatch = missingPartyIds.length === 0;
    const orderIdsMatch = missingOrderIds.length === 0;

    if (partyCountMatch && orderCountMatch && partyIdsMatch && orderIdsMatch) {
    } else {
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
  }
};
