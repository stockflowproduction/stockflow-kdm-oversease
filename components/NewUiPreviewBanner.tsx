import React, { useEffect, useState } from 'react';
import { X } from 'lucide-react';

const DISMISS_KEY = 'stockflow_new_ui_preview_banner_dismissed_v1';
const PREVIEW_URL = 'https://stockflow-production-git-main-rajgolakiya0-2091s-projects.vercel.app/inventory';

export const NewUiPreviewBanner: React.FC = () => {
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    setDismissed(localStorage.getItem(DISMISS_KEY) === '1');
  }, []);

  if (dismissed) return null;

  return (
    <div className="mb-4 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 flex items-center justify-between gap-3">
      <p className="text-sm text-blue-800">
        New UI preview is available — check the preview
      </p>
      <div className="flex items-center gap-2 shrink-0">
        <a
          href={PREVIEW_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex h-8 items-center justify-center rounded-md bg-blue-600 px-3 text-sm font-medium text-white hover:bg-blue-700"
        >
          Show Preview
        </a>
        <button
          type="button"
          className="text-blue-700 hover:text-blue-900"
          aria-label="Dismiss new UI preview banner"
          onClick={() => {
            localStorage.setItem(DISMISS_KEY, '1');
            setDismissed(true);
          }}
        >
          <X className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
};
