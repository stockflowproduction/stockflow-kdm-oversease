/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_ENABLE_DEV_ACCESS_BYPASS?: string;
  readonly VITE_CASHBOOK_RECONCILE_DEBUG?: string;
  readonly VITE_WHATSAPP_SERVER_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
