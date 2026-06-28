/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_ENABLE_DEV_ACCESS_BYPASS?: string;
  readonly VITE_CASHBOOK_RECONCILE_DEBUG?: string;
  readonly VITE_WHATSAPP_SERVER_URL?: string;
  readonly VITE_META_WHATSAPP_SERVER_URL?: string;
  readonly VITE_META_WHATSAPP_BACKEND_PUBLIC_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
