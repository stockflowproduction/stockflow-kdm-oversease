import React, { useEffect, useMemo, useRef, useState } from "react";

type Mode = "sale" | "return";

type Customer = {
  id: number;
  name: string;
  phone: string;
  gstNumber?: string;
  gstName?: string;
  totalDue: number;
  totalPurchase: number;
};

type Variant = {
  id: string;
  name: string;
  price: number;
  buyPrice: number;
  stock: number;
};

type Product = {
  id: number;
  name: string;
  code: string;
  stock: number;
  category: string;
  image: string;
  variants: Variant[];
};

type CartItem = {
  key: string;
  productId: number;
  name: string;
  code: string;
  category: string;
  image: string;
  variantId: string;
  variantName: string;
  price: number;
  buyPrice: number;
  qty: number;
  maxStock: number;
};

const initialCustomers: Customer[] = [
  {
    id: 1,
    name: "Aarav Traders",
    phone: "9876500011",
    gstNumber: "24ABCDE1234F1Z5",
    gstName: "Aarav Traders LLP",
    totalDue: 1250,
    totalPurchase: 18250,
  },
  {
    id: 2,
    name: "Mehta Stationers",
    phone: "9876500022",
    gstNumber: "24PQRSX5678K1Z3",
    gstName: "Mehta Stationers",
    totalDue: 0,
    totalPurchase: 8450,
  },
  {
    id: 3,
    name: "Krishna Dairy",
    phone: "9876500033",
    gstNumber: "",
    gstName: "",
    totalDue: 460,
    totalPurchase: 12400,
  },
];

const sharedImage =
  "https://res.cloudinary.com/demo/image/upload/docs/letterpress/flowers.jpg";

const products: Product[] = [
  {
    id: 1,
    name: "Whole Milk",
    code: "MILK001",
    stock: 12,
    category: "Dairy",
    image: sharedImage,
    variants: [
      { id: "500ml", name: "500ml", price: 55, buyPrice: 40, stock: 8 },
      { id: "1l", name: "1L", price: 99, buyPrice: 78, stock: 4 },
    ],
  },
  {
    id: 2,
    name: "Packaged Chocolate",
    code: "CHOC123",
    stock: 0,
    category: "Snacks",
    image: sharedImage,
    variants: [{ id: "bar", name: "Bar", price: 95, buyPrice: 70, stock: 0 }],
  },
  {
    id: 3,
    name: "Rice (5kg)",
    code: "RICE5000",
    stock: 6,
    category: "Groceries",
    image: sharedImage,
    variants: [{ id: "5kg", name: "5kg", price: 400, buyPrice: 320, stock: 6 }],
  },
  {
    id: 4,
    name: "Notebook A5",
    code: "NOTE05",
    stock: 20,
    category: "Stationery",
    image: sharedImage,
    variants: [{ id: "std", name: "Standard", price: 40, buyPrice: 22, stock: 20 }],
  },
  {
    id: 5,
    name: "Cooking Oil",
    code: "OIL002",
    stock: 10,
    category: "Kitchen",
    image: sharedImage,
    variants: [
      { id: "1l", name: "1L", price: 145, buyPrice: 120, stock: 6 },
      { id: "5l", name: "5L", price: 690, buyPrice: 590, stock: 4 },
    ],
  },
  {
    id: 6,
    name: "Pen Box",
    code: "PEN090",
    stock: 14,
    category: "Stationery",
    image: sharedImage,
    variants: [{ id: "box", name: "Box", price: 120, buyPrice: 90, stock: 14 }],
  },
];

const baseTheme = {
  bg: "#f5f5f7",
  panel: "#ffffff",
  soft: "#fafafa",
  soft2: "#f3f4f6",
  border: "#e5e7eb",
  borderStrong: "#d1d5db",
  text: "#111827",
  sub: "#6b7280",
  mute: "#9ca3af",
  black: "#111111",
  successBg: "#ecfdf3",
  warnBg: "#fff7ed",
  danger: "#dc2626",
  disabledBg: "#ededed",
  accent: "#111111",
  accentSoft: "#f3f4f6",
  accentBorder: "#d1d5db",
};

const returnTheme = {
  ...baseTheme,
  accent: "#d97706",
  accentSoft: "#fff7ed",
  accentBorder: "#fdba74",
};

const appleFont =
  '-apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro Display", "Helvetica Neue", Arial, sans-serif';

const categories = ["All", ...Array.from(new Set(products.map((p) => p.category)))];
const taxSlabs = [0, 5, 12, 18, 28];

function getNowLocalDateTime() {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const yyyy = now.getFullYear();
  const mm = pad(now.getMonth() + 1);
  const dd = pad(now.getDate());
  const hh = pad(now.getHours());
  const mi = pad(now.getMinutes());
  return `${yyyy}-${mm}-${dd}T${hh}:${mi}`;
}

function TrashIcon({ color }: { color: string }) {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M4 7H20M9 7V5C9 4.44772 9.44772 4 10 4H14C14.5523 4 15 4.44772 15 5V7M7 7L8 19C8.08963 20.0748 8.98878 20.9 10.0673 20.9H13.9327C15.0112 20.9 15.9104 20.0748 16 19L17 7M10 11V17M14 11V17"
        stroke={color}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function SummaryRow({
  label,
  value,
  theme,
}: {
  label: React.ReactNode;
  value: React.ReactNode;
  theme: typeof baseTheme;
}) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "118px 1fr",
        alignItems: "center",
        gap: 10,
        minHeight: 24,
      }}
    >
      <div
        style={{
          color: theme.sub,
          fontSize: 14.75,
          textAlign: "left",
          justifySelf: "start",
        }}
      >
        {label}
      </div>
      <div
        style={{
          justifySelf: "end",
          textAlign: "right",
          fontSize: 14.75,
          fontWeight: 600,
        }}
      >
        {value}
      </div>
    </div>
  );
}

export default function ClassicPOS() {
  const [mode, setMode] = useState<Mode>("sale");
  const theme = mode === "return" ? returnTheme : baseTheme;

  const inputStyle: React.CSSProperties = {
    height: 36,
    padding: "0 10px",
    border: `1px solid ${theme.borderStrong}`,
    borderRadius: 10,
    fontSize: 13.5,
    fontWeight: 400,
    outline: "none",
    background: "#fff",
    color: theme.text,
    boxSizing: "border-box",
    fontFamily: appleFont,
  };

  const primaryBtn: React.CSSProperties = {
    height: 36,
    padding: "0 14px",
    background: theme.accent,
    color: "#fff",
    border: "none",
    borderRadius: 10,
    fontWeight: 600,
    fontSize: 13.5,
    cursor: "pointer",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    whiteSpace: "nowrap",
    fontFamily: appleFont,
  };

  const secondaryBtn: React.CSSProperties = {
    height: 36,
    padding: "0 14px",
    background: "#fff",
    color: theme.text,
    border: `1px solid ${theme.borderStrong}`,
    borderRadius: 10,
    fontWeight: 600,
    fontSize: 13.5,
    cursor: "pointer",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    whiteSpace: "nowrap",
    fontFamily: appleFont,
  };

  const iconBtnStyle: React.CSSProperties = {
    width: 28,
    height: 28,
    minWidth: 28,
    minHeight: 28,
    border: `1px solid ${theme.borderStrong}`,
    borderRadius: 9,
    background: "#fff",
    cursor: "pointer",
    fontSize: 16,
    fontWeight: 600,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 0,
    color: theme.text,
    lineHeight: 1,
    fontFamily: appleFont,
  };

  const [customersState, setCustomersState] = useState<Customer[]>(initialCustomers);
  const [barcodeQuery, setBarcodeQuery] = useState("");
  const [selectedCategory, setSelectedCategory] = useState("All");
  const [cart, setCart] = useState<CartItem[]>([]);

  const [variantProduct, setVariantProduct] = useState<Product | null>(null);
  const [variantQuantities, setVariantQuantities] = useState<Record<string, number>>({});

  const [showInvoiceModal, setShowInvoiceModal] = useState(false);
  const [invoiceDateTime, setInvoiceDateTime] = useState(getNowLocalDateTime());
  const [customerQuery, setCustomerQuery] = useState("");
  const [selectedCustomer, setSelectedCustomer] = useState<Customer | null>(null);
  const [showCustomerDrop, setShowCustomerDrop] = useState(false);
  const [showNewCustomerModal, setShowNewCustomerModal] = useState(false);
  const [newName, setNewName] = useState("");
  const [newPhone, setNewPhone] = useState("");
  const [newGstNumber, setNewGstNumber] = useState("");
  const [newGstName, setNewGstName] = useState("");
  const [paymentMethod, setPaymentMethod] = useState("cash");
  const [received, setReceived] = useState("");
  const [gst, setGst] = useState(18);

  const headerDateRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!showInvoiceModal) return;

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        const shouldClose = window.confirm("Do you want to close the invoice window?");
        if (shouldClose) setShowInvoiceModal(false);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [showInvoiceModal]);

  const filteredCustomers = useMemo(() => {
    const q = customerQuery.trim().toLowerCase();
    if (!q) return customersState.slice(0, 6);
    return customersState.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        c.phone.includes(q) ||
        (c.gstNumber || "").toLowerCase().includes(q) ||
        (c.gstName || "").toLowerCase().includes(q)
    );
  }, [customerQuery, customersState]);

  const filteredProducts = useMemo(() => {
    const q = barcodeQuery.trim().toLowerCase();
    return products.filter((p) => {
      const matchesCategory = selectedCategory === "All" || p.category === selectedCategory;
      const matchesSearch =
        !q ||
        p.name.toLowerCase().includes(q) ||
        p.code.toLowerCase().includes(q) ||
        p.category.toLowerCase().includes(q) ||
        p.variants.some((v) => v.name.toLowerCase().includes(q));
      return matchesCategory && matchesSearch;
    });
  }, [barcodeQuery, selectedCategory]);

  const cartSubtotal = useMemo(() => {
    return cart.reduce((sum, item) => sum + item.qty * item.price, 0);
  }, [cart]);

  const tax = (cartSubtotal * gst) / 100;
  const roundOff = Math.round((cartSubtotal + tax) * 100) / 100 - (cartSubtotal + tax);
  const grandTotal = cartSubtotal + tax + roundOff;
  const receivedNum = parseFloat(received) || 0;
  const balance = receivedNum - grandTotal;

  const getItemKey = (productId: number, variantId: string) => `${productId}-${variantId}`;

  const getCartQtyForVariant = (productId: number, variantId: string) => {
    const found = cart.find((item) => item.key === getItemKey(productId, variantId));
    return found?.qty || 0;
  };

  const getCartQtyForProduct = (product: Product) => {
    return product.variants.reduce((sum, variant) => {
      return sum + getCartQtyForVariant(product.id, variant.id);
    }, 0);
  };

  const getRemainingStockForProduct = (product: Product) => {
    return product.variants.reduce((sum, variant) => {
      return sum + (variant.stock - getCartQtyForVariant(product.id, variant.id));
    }, 0);
  };

  const setCartItemQty = (product: Product, variant: Variant, nextQty: number) => {
    const safeQty = Math.max(0, Math.min(nextQty, variant.stock));
    const key = getItemKey(product.id, variant.id);

    setCart((prev) => {
      const existing = prev.find((item) => item.key === key);

      if (safeQty === 0) {
        return prev.filter((item) => item.key !== key);
      }

      if (existing) {
        return prev.map((item) =>
          item.key === key ? { ...item, qty: safeQty, maxStock: variant.stock } : item
        );
      }

      return [
        ...prev,
        {
          key,
          productId: product.id,
          name: product.name,
          code: product.code,
          category: product.category,
          image: product.image,
          variantId: variant.id,
          variantName: variant.name,
          price: variant.price,
          buyPrice: variant.buyPrice,
          qty: safeQty,
          maxStock: variant.stock,
        },
      ];
    });
  };

  const handleSimpleProductMinus = (product: Product) => {
    const variant = product.variants[0];
    const current = getCartQtyForVariant(product.id, variant.id);
    setCartItemQty(product, variant, current - 1);
  };

  const handleSimpleProductPlus = (product: Product) => {
    const variant = product.variants[0];
    const current = getCartQtyForVariant(product.id, variant.id);
    setCartItemQty(product, variant, current + 1);
  };

  const openVariantModal = (product: Product) => {
    const initial: Record<string, number> = {};
    product.variants.forEach((variant) => {
      initial[variant.id] = getCartQtyForVariant(product.id, variant.id);
    });
    setVariantQuantities(initial);
    setVariantProduct(product);
  };

  const confirmVariantSelection = () => {
    if (!variantProduct) return;

    variantProduct.variants.forEach((variant) => {
      const qty = Math.max(0, Math.min(variantQuantities[variant.id] || 0, variant.stock));
      setCartItemQty(variantProduct, variant, qty);
    });

    setVariantProduct(null);
    setVariantQuantities({});
  };

  const updateQty = (key: string, qty: number) => {
    setCart((prev) =>
      prev
        .map((item) => {
          if (item.key !== key) return item;
          const safeQty = Math.max(1, Math.min(qty || 1, item.maxStock));
          return { ...item, qty: safeQty };
        })
        .filter((item) => item.qty > 0)
    );
  };

  const updatePrice = (key: string, price: number) => {
    setCart((prev) =>
      prev.map((item) =>
        item.key === key ? { ...item, price: Math.max(0, price || 0) } : item
      )
    );
  };

  const removeItem = (key: string) => {
    setCart((prev) => prev.filter((item) => item.key !== key));
  };

  const createCustomer = () => {
    const name = newName.trim();
    const phone = newPhone.trim();
    if (!name || !phone) return;

    const customer: Customer = {
      id: Date.now(),
      name,
      phone,
      gstNumber: newGstNumber.trim(),
      gstName: newGstName.trim(),
      totalDue: 0,
      totalPurchase: 0,
    };

    setCustomersState((prev) => [customer, ...prev]);
    setSelectedCustomer(customer);
    setCustomerQuery(customer.name);
    setNewName("");
    setNewPhone("");
    setNewGstNumber("");
    setNewGstName("");
    setShowNewCustomerModal(false);
    setShowCustomerDrop(false);
  };

  const openInvoiceModal = () => {
    setInvoiceDateTime(getNowLocalDateTime());
    setShowInvoiceModal(true);
  };

  return (
    <div
      style={{
        minHeight: "100vh",
        background: theme.bg,
        fontFamily: appleFont,
        color: theme.text,
        padding: 11,
        boxSizing: "border-box",
      }}
    >
      <style>{`
        input[type=number]::-webkit-outer-spin-button,
        input[type=number]::-webkit-inner-spin-button {
          -webkit-appearance: none;
          margin: 0;
        }
        input[type=number] {
          -moz-appearance: textfield;
          appearance: textfield;
        }
        * {
          scrollbar-width: none;
        }
        *::-webkit-scrollbar {
          display: none;
          width: 0;
          height: 0;
        }
      `}</style>

      <div
        style={{
          maxWidth: 1440,
          margin: "0 auto",
          minHeight: "calc(100vh - 22px)",
          background: "#fff",
          border: `1px solid ${theme.border}`,
          borderRadius: 14,
          overflow: "hidden",
          display: "grid",
          gridTemplateColumns: "minmax(0, 1fr) 400px",
        }}
      >
        {/* LEFT */}
        <div
          style={{
            minWidth: 0,
            padding: 12,
            display: "flex",
            flexDirection: "column",
            gap: 10,
          }}
        >
          <div
            style={{
              background: "#fff",
              border: `1px solid ${theme.border}`,
              borderRadius: 12,
              padding: 10,
            }}
          >
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "minmax(0, 1fr) auto",
                gap: 10,
                alignItems: "center",
              }}
            >
              <input
                value={barcodeQuery}
                onChange={(e) => setBarcodeQuery(e.target.value)}
                placeholder="Search product, barcode, category, variant"
                style={{ ...inputStyle, width: "100%" }}
              />

              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 1fr",
                  gap: 8,
                  minWidth: 180,
                }}
              >
                <button
                  onClick={() => setMode("sale")}
                  style={{
                    ...(mode === "sale" ? primaryBtn : secondaryBtn),
                    width: "100%",
                    height: 36,
                  }}
                >
                  Sale
                </button>
                <button
                  onClick={() => setMode("return")}
                  style={{
                    ...(mode === "return" ? primaryBtn : secondaryBtn),
                    width: "100%",
                    height: 36,
                  }}
                >
                  Return
                </button>
              </div>
            </div>

            <div
              style={{
                display: "flex",
                gap: 8,
                overflowX: "auto",
                paddingTop: 10,
                marginTop: 10,
              }}
            >
              {categories.map((cat) => {
                const active = selectedCategory === cat;
                return (
                  <button
                    key={cat}
                    onClick={() => setSelectedCategory(cat)}
                    style={{
                      ...(active ? primaryBtn : secondaryBtn),
                      height: 32,
                      padding: "0 14px",
                      fontSize: 12.5,
                      flexShrink: 0,
                    }}
                  >
                    {cat}
                  </button>
                );
              })}
            </div>
          </div>

          <div
            style={{
              background: "#fff",
              borderRadius: 12,
              padding: 0,
              display: "flex",
              flexDirection: "column",
              flex: 1,
              minHeight: 0,
            }}
          >
            <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: 0 }}>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fill, minmax(190px, 1fr))",
                  gap: 10,
                }}
              >
                {filteredProducts.map((product) => {
                  const isVariantProduct = product.variants.length > 1;
                  const firstVariant = product.variants[0];
                  const shownPrice = Math.min(...product.variants.map((v) => v.price));
                  const shownStock = isVariantProduct
                    ? getRemainingStockForProduct(product)
                    : firstVariant.stock - getCartQtyForVariant(product.id, firstVariant.id);
                  const shownQty = getCartQtyForProduct(product);
                  const isDisabled = shownStock <= 0;

                  return (
                    <div
                      key={product.id}
                      style={{
                        border: `1px solid ${mode === "return" ? theme.accentBorder : theme.border}`,
                        borderRadius: 12,
                        padding: 10,
                        background: isDisabled ? theme.disabledBg : "#fff",
                        display: "grid",
                        gap: 8,
                        opacity: isDisabled ? 0.6 : 1,
                      }}
                    >
                      <div
                        style={{
                          position: "relative",
                          borderRadius: 10,
                          overflow: "hidden",
                          border: `1px solid ${theme.border}`,
                          background: "#fff",
                          height: 118,
                        }}
                      >
                        <img
                          src={product.image}
                          alt={product.name}
                          style={{
                            width: "100%",
                            height: "100%",
                            objectFit: "contain",
                            background: "#fff",
                            display: "block",
                          }}
                        />

                        <div
                          style={{
                            position: "absolute",
                            right: 8,
                            bottom: 4,
                            background:
                              mode === "return"
                                ? "rgba(217,119,6,0.32)"
                                : "rgba(17,24,39,0.30)",
                            color: "#fff",
                            borderRadius: 999,
                            padding: "2px 7px",
                            fontSize: 11.25,
                            fontWeight: 600,
                            lineHeight: 1.1,
                            minWidth: 42,
                            textAlign: "center",
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                          }}
                        >
                          ₹ {shownPrice}
                        </div>
                      </div>

                      <div style={{ fontSize: 13.5, fontWeight: 600, lineHeight: 1.3 }}>
                        {product.name}
                      </div>

                      {isVariantProduct ? (
                        <div
                          style={{
                            display: "grid",
                            gridTemplateColumns: "auto auto",
                            gap: 10,
                            alignItems: "center",
                            justifyContent: "start",
                          }}
                        >
                          <div
                            style={{
                              fontSize: 11.75,
                              color: theme.sub,
                              whiteSpace: "nowrap",
                            }}
                          >
                            Stock: {Math.max(0, shownStock)}
                          </div>

                          <button
                            onClick={() => openVariantModal(product)}
                            style={{
                              ...secondaryBtn,
                              width: 126,
                              height: 34,
                              justifySelf: "start",
                              color: mode === "return" ? theme.accent : theme.text,
                              borderColor: mode === "return" ? theme.accentBorder : theme.borderStrong,
                            }}
                            disabled={product.stock <= 0}
                          >
                            Show Variants
                          </button>
                        </div>
                      ) : (
                        <div
                          style={{
                            display: "grid",
                            gridTemplateColumns: "auto 28px 1fr 28px",
                            gap: 8,
                            alignItems: "center",
                          }}
                        >
                          <div
                            style={{
                              fontSize: 11.75,
                              color: theme.sub,
                              whiteSpace: "nowrap",
                            }}
                          >
                            Stock: {Math.max(0, shownStock)}
                          </div>

                          <button
                            onClick={() => handleSimpleProductMinus(product)}
                            style={iconBtnStyle}
                            disabled={shownQty <= 0}
                          >
                            −
                          </button>

                          <div
                            style={{
                              height: 30,
                              borderRadius: 8,
                              background: theme.soft2,
                              display: "flex",
                              alignItems: "center",
                              justifyContent: "center",
                              fontSize: 13.5,
                              fontWeight: 600,
                              color: mode === "return" ? theme.accent : theme.text,
                            }}
                          >
                            {shownQty}
                          </div>

                          <button
                            onClick={() => handleSimpleProductPlus(product)}
                            style={iconBtnStyle}
                            disabled={isDisabled}
                          >
                            +
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>

        {/* RIGHT */}
        <div
          style={{
            minWidth: 0,
            background: "#fcfcfd",
            padding: 11,
            display: "flex",
            flexDirection: "column",
            gap: 10,
            height: "calc(100vh - 22px)",
            boxSizing: "border-box",
          }}
        >
          <div
            style={{
              background: "#fff",
              border: `1px solid ${theme.border}`,
              borderRadius: 12,
              padding: 10,
              display: "flex",
              flexDirection: "column",
              flex: 1,
              minHeight: 0,
              overflow: "hidden",
            }}
          >
            <div
              style={{
                fontSize: 13.5,
                fontWeight: 600,
                marginBottom: 8,
                flexShrink: 0,
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
              }}
            >
              <span>{mode === "return" ? "Return Cart" : "Cart"}</span>
              {cart.length > 0 && (
                <button onClick={() => setCart([])} style={{ ...secondaryBtn, height: 30 }}>
                  Clear
                </button>
              )}
            </div>

            <div
              style={{
                flex: 1,
                minHeight: 0,
                overflowY: "auto",
                display: "flex",
                flexDirection: "column",
                gap: 8,
                paddingRight: 2,
              }}
            >
              {cart.length === 0 ? (
                <div
                  style={{
                    border: `1px dashed ${theme.border}`,
                    borderRadius: 12,
                    padding: 20,
                    textAlign: "center",
                    color: theme.sub,
                    fontSize: 12.5,
                    background: theme.soft,
                  }}
                >
                  {mode === "return" ? "Return cart is empty" : "Cart is empty"}
                </div>
              ) : (
                cart.map((item) => {
                  const itemTotal = item.qty * item.price;

                  return (
                    <div
                      key={item.key}
                      style={{
                        border: `1px solid ${mode === "return" ? theme.accentBorder : theme.border}`,
                        borderRadius: 11,
                        padding: 7.2,
                        background: "#fff",
                        flexShrink: 0,
                        display: "grid",
                        gridTemplateColumns: "44px minmax(0, 1fr) 26px",
                        gridTemplateRows: "auto auto auto",
                        columnGap: 8,
                        rowGap: 3,
                        alignItems: "center",
                      }}
                    >
                      <div
                        style={{
                          gridRow: "1 / span 2",
                          width: 44,
                          height: 44,
                          borderRadius: 10,
                          overflow: "hidden",
                          border: `1px solid ${theme.border}`,
                          background: "#fff",
                        }}
                      >
                        <img
                          src={item.image}
                          alt={item.name}
                          style={{
                            width: "100%",
                            height: "100%",
                            objectFit: "contain",
                            background: "#fff",
                            display: "block",
                          }}
                        />
                      </div>

                      <div
                        style={{
                          fontSize: 14,
                          fontWeight: 600,
                          lineHeight: 1.15,
                          textAlign: "left",
                          whiteSpace: "nowrap",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          justifySelf: "start",
                        }}
                      >
                        {item.name} - {item.variantName}
                      </div>

                      <button
                        onClick={() => removeItem(item.key)}
                        style={{
                          ...iconBtnStyle,
                          width: 24,
                          height: 24,
                          minWidth: 24,
                          minHeight: 24,
                          borderColor: "#fecaca",
                          justifySelf: "end",
                        }}
                        aria-label="Remove item"
                        title="Remove item"
                      >
                        <TrashIcon color={theme.danger} />
                      </button>

                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 7.2,
                          fontSize: 11.5,
                          color: theme.sub,
                          textAlign: "left",
                        }}
                      >
                        <span>Stock left: {Math.max(0, item.maxStock - item.qty)}</span>
                        <span>Buy price: ₹ {item.buyPrice}</span>
                      </div>

                      <div />

                      <div
                        style={{
                          gridColumn: "1 / span 3",
                          display: "grid",
                          gridTemplateColumns: "120px 90px 1fr",
                          gap: 10,
                          alignItems: "center",
                        }}
                      >
                        <div
                          style={{
                            display: "grid",
                            gridTemplateColumns: "28px 1fr 28px",
                            gap: 8,
                            alignItems: "center",
                          }}
                        >
                          <button onClick={() => updateQty(item.key, item.qty - 1)} style={iconBtnStyle}>
                            −
                          </button>

                          <div
                            style={{
                              height: 30,
                              borderRadius: 8,
                              background: theme.soft2,
                              display: "flex",
                              alignItems: "center",
                              justifyContent: "center",
                              fontSize: 13.5,
                              fontWeight: 600,
                              color: mode === "return" ? theme.accent : theme.text,
                            }}
                          >
                            {item.qty}
                          </div>

                          <button onClick={() => updateQty(item.key, item.qty + 1)} style={iconBtnStyle}>
                            +
                          </button>
                        </div>

                        <input
                          type="number"
                          value={item.price}
                          onChange={(e) => updatePrice(item.key, parseFloat(e.target.value) || 0)}
                          style={{
                            ...inputStyle,
                            width: "100%",
                            height: 30,
                            textAlign: "center",
                          }}
                        />

                        <div
                          style={{
                            textAlign: "right",
                            fontSize: 16.7,
                            fontWeight: 700,
                            whiteSpace: "nowrap",
                            color: mode === "return" ? theme.accent : theme.text,
                          }}
                        >
                          ₹ {itemTotal.toFixed(2)}
                        </div>
                      </div>
                    </div>
                  );
                })
              )}
            </div>

            <div
              style={{
                borderTop: `1px solid ${theme.border}`,
                paddingTop: 10,
                marginTop: 10,
                flexShrink: 0,
              }}
            >
              <button
                onClick={openInvoiceModal}
                disabled={cart.length === 0}
                style={{
                  ...primaryBtn,
                  width: "100%",
                  height: 38,
                  opacity: cart.length === 0 ? 0.5 : 1,
                  cursor: cart.length === 0 ? "not-allowed" : "pointer",
                }}
              >
                {mode === "return" ? "Create Return Invoice" : "Create Invoice"}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* VARIANT MODAL */}
      {variantProduct && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.35)",
            zIndex: 220,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 16,
          }}
        >
          <div
            style={{
              width: "100%",
              maxWidth: 920,
              background: "#fff",
              borderRadius: 16,
              border: `1px solid ${theme.border}`,
              padding: 18,
              display: "grid",
              gap: 14,
            }}
          >
            <div style={{ textAlign: "center" }}>
              <div style={{ fontSize: 20.8, fontWeight: 600 }}>Show Variants</div>
              <div style={{ fontSize: 16.25, color: theme.sub, marginTop: 10 }}>
                {variantProduct.name}
              </div>
            </div>

            <div
              style={{
                display: "grid",
                gap: 18,
                maxHeight: "50vh",
                overflowY: "auto",
              }}
            >
              {variantProduct.variants.map((variant) => {
                const qty = variantQuantities[variant.id] || 0;
                return (
                  <div
                    key={variant.id}
                    style={{
                      width: "60%",
                      minWidth: 420,
                      justifySelf: "center",
                      display: "grid",
                      gridTemplateColumns: "1.2fr 54px 92px 34px 52px 34px",
                      gap: 12,
                      alignItems: "center",
                      border: `1px solid ${mode === "return" ? theme.accentBorder : theme.border}`,
                      borderRadius: 14,
                      padding: 10,
                      background: "#fff",
                    }}
                  >
                    <div
                      style={{
                        fontSize: 16.25,
                        fontWeight: 600,
                        textAlign: "center",
                      }}
                    >
                      {variant.name}
                    </div>

                    <div
                      style={{
                        fontSize: 16.25,
                        color: theme.sub,
                        textAlign: "center",
                      }}
                    >
                      {variant.stock}
                    </div>

                    <div
                      style={{
                        fontSize: 16.25,
                        fontWeight: 600,
                        textAlign: "center",
                        color: mode === "return" ? theme.accent : theme.text,
                      }}
                    >
                      ₹ {variant.price}
                    </div>

                    <button
                      onClick={() =>
                        setVariantQuantities((prev) => ({
                          ...prev,
                          [variant.id]: Math.max(0, (prev[variant.id] || 0) - 1),
                        }))
                      }
                      style={iconBtnStyle}
                    >
                      −
                    </button>

                    <div
                      style={{
                        height: 32,
                        borderRadius: 8,
                        background: theme.soft2,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        fontSize: 16.25,
                        fontWeight: 600,
                        color: mode === "return" ? theme.accent : theme.text,
                      }}
                    >
                      {qty}
                    </div>

                    <button
                      onClick={() =>
                        setVariantQuantities((prev) => ({
                          ...prev,
                          [variant.id]: Math.min(variant.stock, (prev[variant.id] || 0) + 1),
                        }))
                      }
                      style={iconBtnStyle}
                    >
                      +
                    </button>
                  </div>
                );
              })}
            </div>

            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: 12,
              }}
            >
              <button onClick={() => setVariantProduct(null)} style={{ ...secondaryBtn, height: 40 }}>
                Cancel
              </button>
              <button onClick={confirmVariantSelection} style={{ ...primaryBtn, height: 40 }}>
                Confirm
              </button>
            </div>
          </div>
        </div>
      )}

      {/* NEW CUSTOMER MODAL */}
      {showNewCustomerModal && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.35)",
            zIndex: 330,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 16,
          }}
        >
          <div
            style={{
              width: "100%",
              maxWidth: 294,
              background: "#fff",
              borderRadius: 16,
              border: `1px solid ${theme.border}`,
              padding: 18,
              display: "grid",
              gap: 12,
            }}
          >
            <div style={{ fontSize: 16, fontWeight: 600 }}>New Customer</div>

            <div style={{ display: "grid", gap: 8 }}>
              <input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="Customer name"
                style={{ ...inputStyle, width: "100%" }}
              />
              <input
                value={newPhone}
                onChange={(e) => setNewPhone(e.target.value)}
                placeholder="Phone number"
                style={{ ...inputStyle, width: "100%" }}
              />
              <input
                value={newGstNumber}
                onChange={(e) => setNewGstNumber(e.target.value)}
                placeholder="GST number"
                style={{ ...inputStyle, width: "100%" }}
              />
              <input
                value={newGstName}
                onChange={(e) => setNewGstName(e.target.value)}
                placeholder="GST name"
                style={{ ...inputStyle, width: "100%" }}
              />
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              <button onClick={() => setShowNewCustomerModal(false)} style={secondaryBtn}>
                Cancel
              </button>
              <button onClick={createCustomer} style={primaryBtn}>
                Save Customer
              </button>
            </div>
          </div>
        </div>
      )}

      {/* INVOICE MODAL */}
      {showInvoiceModal && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.38)",
            zIndex: 300,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 16,
          }}
        >
          <div
            style={{
              width: "100%",
              maxWidth: 980,
              height: "88vh",
              background: "#fff",
              borderRadius: 18,
              border: `1px solid ${theme.border}`,
              display: "flex",
              flexDirection: "column",
              overflow: "hidden",
            }}
          >
            <div
              style={{
                padding: "10px 18px",
                borderBottom: `1px solid ${theme.border}`,
                display: "grid",
                gridTemplateColumns: "auto 1fr auto",
                alignItems: "center",
                gap: 10,
                flexShrink: 0,
              }}
            >
              <div
                onClick={() => {
                  headerDateRef.current?.showPicker?.();
                  headerDateRef.current?.focus();
                }}
                style={{
                  width: 220,
                  height: 36,
                  border: `1px solid ${theme.borderStrong}`,
                  borderRadius: 10,
                  position: "relative",
                  background: "#fff",
                  cursor: "pointer",
                  overflow: "hidden",
                }}
              >
                <input
                  ref={headerDateRef}
                  type="datetime-local"
                  value={invoiceDateTime}
                  onChange={(e) => setInvoiceDateTime(e.target.value || getNowLocalDateTime())}
                  style={{
                    width: "100%",
                    height: "100%",
                    border: "none",
                    outline: "none",
                    background: "transparent",
                    fontFamily: appleFont,
                    fontSize: 13.5,
                    color: theme.text,
                    padding: "0 10px",
                    boxSizing: "border-box",
                    cursor: "pointer",
                  }}
                />
              </div>

              <div />

              <button onClick={() => setShowInvoiceModal(false)} style={secondaryBtn}>
                Close
              </button>
            </div>

            <div
              style={{
                padding: 18,
                display: "grid",
                gridTemplateColumns: "minmax(360px, 0.92fr) minmax(0, 1.08fr)",
                gap: 16,
                flex: 1,
                minHeight: 0,
                overflow: "hidden",
              }}
            >
              {/* LEFT */}
              <div
                style={{
                  display: "grid",
                  gap: 14,
                  minWidth: 0,
                  minHeight: 0,
                }}
              >
                <div
                  style={{
                    border: `1px solid ${mode === "return" ? theme.accentBorder : theme.border}`,
                    borderRadius: 14,
                    padding: 14,
                    background: "#fff",
                    display: "grid",
                    gap: 14,
                    alignContent: "start",
                  }}
                >
                  <div style={{ position: "relative" }}>
                    <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto", gap: 8 }}>
                      <div style={{ position: "relative", minWidth: 0 }}>
                        <input
                          value={customerQuery}
                          onChange={(e) => {
                            setCustomerQuery(e.target.value);
                            setShowCustomerDrop(true);
                          }}
                          onFocus={() => setShowCustomerDrop(true)}
                          onBlur={() => setTimeout(() => setShowCustomerDrop(false), 150)}
                          placeholder="Search customer"
                          style={{ ...inputStyle, width: "100%" }}
                        />

                        {showCustomerDrop && filteredCustomers.length > 0 && (
                          <div
                            style={{
                              position: "absolute",
                              top: "calc(100% + 6px)",
                              left: 0,
                              right: 0,
                              background: "#fff",
                              border: `1px solid ${theme.border}`,
                              borderRadius: 12,
                              overflow: "hidden",
                              zIndex: 40,
                              boxShadow: "0 8px 20px rgba(0,0,0,0.08)",
                            }}
                          >
                            {filteredCustomers.map((c, index) => (
                              <div
                                key={c.id}
                                onMouseDown={() => {
                                  setSelectedCustomer(c);
                                  setCustomerQuery(c.name);
                                  setShowCustomerDrop(false);
                                }}
                                style={{
                                  padding: "10px 12px",
                                  cursor: "pointer",
                                  borderBottom:
                                    index === filteredCustomers.length - 1 ? "none" : `1px solid ${theme.border}`,
                                }}
                              >
                                <div style={{ fontSize: 12.75, fontWeight: 600 }}>{c.name}</div>
                                <div style={{ fontSize: 11.5, color: theme.sub }}>{c.phone}</div>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>

                      <button
                        onClick={() => setShowNewCustomerModal(true)}
                        style={{ ...primaryBtn, height: 36 }}
                      >
                        + New
                      </button>
                    </div>
                  </div>

                  <div style={{ borderTop: `1px solid ${theme.border}` }} />

                  <div
                    style={{
                      fontSize: 15,
                      fontWeight: 600,
                      color: mode === "return" ? theme.accent : theme.text,
                    }}
                  >
                    Billing Summary
                  </div>

                  <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8 }}>
                    {["cash", "credit", "online"].map((method) => {
                      const active = paymentMethod === method;
                      return (
                        <button
                          key={method}
                          onClick={() => setPaymentMethod(method)}
                          style={{
                            ...(active ? primaryBtn : secondaryBtn),
                            width: "100%",
                            height: 36,
                            fontSize: 13.5,
                            textTransform: "capitalize",
                            color: active ? "#fff" : mode === "return" ? theme.accent : theme.text,
                            borderColor: mode === "return" ? theme.accentBorder : theme.borderStrong,
                          }}
                        >
                          {method}
                        </button>
                      );
                    })}
                  </div>

                  <div style={{ display: "grid", gap: 6 }}>
                    <SummaryRow
                      label="Sub Total"
                      value={`₹ ${cartSubtotal.toFixed(2)}`}
                      theme={theme}
                    />

                    <SummaryRow
                      label="GST"
                      theme={theme}
                      value={
                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 8,
                          }}
                        >
                          <select
                            value={gst}
                            onChange={(e) => setGst(Number(e.target.value))}
                            style={{
                              ...inputStyle,
                              height: 30,
                              width: 74,
                              minWidth: 74,
                              paddingRight: 28,
                              fontSize: 13,
                            }}
                          >
                            {taxSlabs.map((slab) => (
                              <option key={slab} value={slab}>
                                {slab}%
                              </option>
                            ))}
                          </select>
                          <span style={{ fontSize: 14.75, fontWeight: 600 }}>
                            ₹ {tax.toFixed(2)}
                          </span>
                        </div>
                      }
                    />

                    <SummaryRow
                      label="Round-off"
                      value={`₹ ${roundOff.toFixed(2)}`}
                      theme={theme}
                    />
                    <SummaryRow
                      label="Total"
                      value={`₹ ${grandTotal.toFixed(2)}`}
                      theme={theme}
                    />

                    <div
                      style={{
                        display: "grid",
                        gridTemplateColumns: "118px 1fr",
                        alignItems: "center",
                        gap: 10,
                        minHeight: 34,
                      }}
                    >
                      <div
                        style={{
                          color: theme.sub,
                          fontSize: 14.75,
                          textAlign: "left",
                          justifySelf: "start",
                        }}
                      >
                        Received
                      </div>

                      <input
                        type="number"
                        value={received}
                        onChange={(e) => setReceived(e.target.value)}
                        style={{
                          ...inputStyle,
                          height: 34,
                          width: "80%",
                          justifySelf: "end",
                          textAlign: "right",
                        }}
                      />
                    </div>
                  </div>

                  {received !== "" && (
                    <div
                      style={{
                        padding: "9px 10px",
                        borderRadius: 9,
                        background: balance >= 0 ? theme.successBg : theme.warnBg,
                        border: `1px solid ${theme.border}`,
                        fontSize: 12.75,
                        fontWeight: 600,
                        textAlign: "center",
                      }}
                    >
                      {balance >= 0
                        ? `Change: ₹ ${balance.toFixed(2)}`
                        : `Due: ₹ ${Math.abs(balance).toFixed(2)}`}
                    </div>
                  )}

                  <div style={{ fontSize: 12.75, color: theme.sub }}>
                    Customer:{" "}
                    <span style={{ color: theme.text, fontWeight: 600 }}>
                      {selectedCustomer ? selectedCustomer.name : "Walk-in Customer"}
                    </span>
                  </div>

                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                    <button
                      onClick={() => setShowInvoiceModal(false)}
                      style={{ ...secondaryBtn, width: "100%", height: 36 }}
                    >
                      Save
                    </button>
                    <button style={{ ...primaryBtn, width: "100%", height: 36 }}>
                      Save & Print
                    </button>
                  </div>
                </div>
              </div>

              {/* RIGHT PRODUCTS SUMMARY */}
              <div
                style={{
                  border: `1px solid ${mode === "return" ? theme.accentBorder : theme.border}`,
                  borderRadius: 14,
                  background: "#fff",
                  display: "flex",
                  flexDirection: "column",
                  minWidth: 0,
                  minHeight: 0,
                  overflow: "hidden",
                }}
              >
                <div
                  style={{
                    padding: "14px 14px 10px",
                    flexShrink: 0,
                    display: "grid",
                    gridTemplateColumns: "minmax(0, 1fr) 80px 90px 90px",
                    gap: 10,
                    alignItems: "center",
                    borderBottom: `1px solid ${theme.border}`,
                  }}
                >
                  <div
                    style={{
                      fontSize: 14.5,
                      fontWeight: 600,
                      color: mode === "return" ? theme.accent : theme.text,
                    }}
                  >
                    Products Summary
                  </div>
                  <div style={{ fontSize: 13.5, color: theme.sub, textAlign: "center" }}>Quantity</div>
                  <div style={{ fontSize: 13.5, color: theme.sub, textAlign: "right" }}>Price</div>
                  <div style={{ fontSize: 13.5, color: theme.sub, textAlign: "right" }}>Total</div>
                </div>

                <div
                  style={{
                    flex: 1,
                    minHeight: 0,
                    overflowY: "auto",
                    display: "flex",
                    flexDirection: "column",
                    justifyContent: "flex-start",
                    alignItems: "stretch",
                  }}
                >
                  {cart.map((item) => {
                    const itemTotal = item.qty * item.price;
                    return (
                      <div
                        key={item.key}
                        style={{
                          padding: "10px 14px",
                          display: "grid",
                          gridTemplateColumns: "46px minmax(0, 1fr) 80px 90px 90px",
                          gap: 10,
                          alignItems: "center",
                          borderBottom: `1px solid ${theme.border}`,
                          flexShrink: 0,
                        }}
                      >
                        <div
                          style={{
                            width: 46,
                            height: 46,
                            borderRadius: 8,
                            overflow: "hidden",
                            border: `1px solid ${theme.border}`,
                            background: "#fff",
                          }}
                        >
                          <img
                            src={item.image}
                            alt={item.name}
                            style={{
                              width: "100%",
                              height: "100%",
                              objectFit: "contain",
                              background: "#fff",
                              display: "block",
                            }}
                          />
                        </div>

                        <div
                          style={{
                            fontSize: 13.5,
                            fontWeight: 600,
                            whiteSpace: "nowrap",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                          }}
                        >
                          {item.name} - {item.variantName}
                        </div>

                        <div style={{ fontSize: 13.25, textAlign: "center" }}>{item.qty}</div>
                        <div style={{ fontSize: 13.25, textAlign: "right" }}>₹ {item.price}</div>
                        <div
                          style={{
                            fontSize: 13.75,
                            fontWeight: 700,
                            textAlign: "right",
                            color: mode === "return" ? theme.accent : theme.text,
                          }}
                        >
                          ₹ {itemTotal.toFixed(2)}
                        </div>
                      </div>
                    );
                  })}
                </div>

                <div
                  style={{
                    flexShrink: 0,
                    borderTop: `1px solid ${theme.border}`,
                    background: "#fff",
                    padding: "12px 14px",
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    position: "sticky",
                    bottom: 0,
                  }}
                >
                  <div
                    style={{
                      fontSize: 14.5,
                      fontWeight: 600,
                      color: mode === "return" ? theme.accent : theme.text,
                    }}
                  >
                    Sub Total
                  </div>
                  <div
                    style={{
                      fontSize: 15.5,
                      fontWeight: 700,
                      color: mode === "return" ? theme.accent : theme.text,
                    }}
                  >
                    ₹ {cartSubtotal.toFixed(2)}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}