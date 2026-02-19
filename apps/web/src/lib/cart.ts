// apps/web/src/lib/cart.ts
import { atom, computed } from 'nanostores';

export interface CartItem {
  productId: string;
  title: string;
  price: number;
  salePrice: number | null;
  imageUrl: string | null;
  qty: number;
  stock: number;
}

const CART_KEY = 'saas_cart';

function loadCart(): CartItem[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    const raw = localStorage.getItem(CART_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveCart(items: CartItem[]) {
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem(CART_KEY, JSON.stringify(items));
  }
}

export const cartItems = atom<CartItem[]>(loadCart());

// Derived
export const cartCount = computed(cartItems, (items) =>
  items.reduce((acc, item) => acc + item.qty, 0)
);

export const cartTotal = computed(cartItems, (items) =>
  items.reduce((acc, item) => acc + (item.salePrice ?? item.price) * item.qty, 0)
);

// Actions
export function addToCart(item: Omit<CartItem, 'qty'>, qty = 1) {
  const current = cartItems.get();
  const existing = current.find(i => i.productId === item.productId);

  if (existing) {
    const newQty = Math.min(existing.qty + qty, item.stock);
    const updated = current.map(i =>
      i.productId === item.productId ? { ...i, qty: newQty } : i
    );
    cartItems.set(updated);
    saveCart(updated);
  } else {
    const updated = [...current, { ...item, qty: Math.min(qty, item.stock) }];
    cartItems.set(updated);
    saveCart(updated);
  }
}

export function removeFromCart(productId: string) {
  const updated = cartItems.get().filter(i => i.productId !== productId);
  cartItems.set(updated);
  saveCart(updated);
}

export function updateQty(productId: string, qty: number) {
  if (qty <= 0) {
    removeFromCart(productId);
    return;
  }
  const updated = cartItems.get().map(i =>
    i.productId === productId ? { ...i, qty: Math.min(qty, i.stock) } : i
  );
  cartItems.set(updated);
  saveCart(updated);
}

export function clearCart() {
  cartItems.set([]);
  saveCart([]);
}
