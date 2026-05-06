# Access Control Passcode Flow Audit

## 1. Executive verdict
The current flow is **partially implemented but functionally racy**. Persistence and modal rendering exist, but unlock navigation can fail due to a **state timing race** between `setUnlockIdentity(...)` and `hashchange` interception. This makes the user experience look like “not working” even with correct passcode.

## 2. Reproduction assumptions
- Legacy root app running via HashRouter (`#/...`).
- Admin passcode configured and at least one page in `protectedPages`.
- Navigate from an allowed page to a protected page.
- Enter correct passcode in modal.

## 3. Persistence audit
- Access Control save button exists and calls `handleSaveAccessControl`. (`pages/Settings.tsx`)
- Handler validates and calls `await updateAccessControlSettings(accessControl)`. (`pages/Settings.tsx`)
- `updateAccessControlSettings` sanitizes and writes `accessControlSettings` via `saveData(..., throwOnError: true)`. (`services/storage.ts`)
- Save triggers `window.location.reload()` after success. (`pages/Settings.tsx`)
- Hydration sanitizes `accessControlSettings` on load. (`services/storage.ts`)

**Verdict:** Persistence pipeline is present and generally correct.

## 4. Settings UI state audit
- Admin passcode updates local state with numeric-only sanitize.
- Protected pages checkboxes update local state.
- Roles update local state; role passcodes numeric-only sanitize.
- Save Access Control uses current state directly.
- Save Profile no longer writes access control directly.

**Observation:** `APP_PAGES` includes duplicate key `admin` for both “Inventory” and “Admin”, which is confusing and can produce ambiguous behavior in UI expectations.

## 5. Route/page key mapping audit
- App guard keys (`PAGE_KEYS`) map routes to values like `settings`, `finance`, `sales`, etc. (`App.tsx`)
- Settings page uses matching keys in checkboxes for most routes.
- Duplicate `admin` key in Settings means “Inventory” and “Admin” are the same protection bucket (route `/`).

**Verdict:** Main keys mostly match; duplicate `admin` key is a design ambiguity but not the primary break.

## 6. Navigation guard audit
- `hashchange` listener is registered and runs on mount + route changes.
- If blocked, it stores `accessPrompt` and redirects to fallback (`lastAllowedPath` or `/dashboard`).
- Direct protected-route load also enters guard.

### Critical race condition
In auto-unlock effect (`passcodeInput`/`accessPrompt`):
1. `setUnlockIdentity(...)` is called.
2. Immediately after, `window.location.hash = accessPrompt.path` is set.
3. `hashchange` handler fires **before** React state update to `unlockIdentity` is guaranteed visible.
4. Guard still sees old `unlockIdentity` (null/previous), blocks again, and redirects away.

This is the primary reason users can report “correct passcode but page does not open”.

## 7. Modal/render audit
- Modal is in-app (`Card` overlay), not browser prompt.
- Input is numeric-only and wired to state.
- Error text renders inline.
- Modal appears when `accessPrompt` is non-null.

**Verdict:** Modal rendering exists and is not browser-native.

## 8. Auto-unlock audit
- Admin passcode comparison exists.
- Role passcode comparison exists.
- Not-allowed role message exists.
- Invalid passcode message is length-gated.

**Break point:** Post-match navigation relies on immediate hash write while auth state (`unlockIdentity`) may still be stale in guard.

## 9. Protected Settings edge-case audit
- If `settings` is protected and app loads there, guard should set prompt and redirect to fallback page while modal is shown.
- With race present, successful passcode can bounce user back again instead of reliably opening Settings.
- Blank admin passcode bypass is present, so lockout prevention is implemented.

## 10. Root cause(s)
1. **Primary root cause:** unlock/navigation race between `setUnlockIdentity` and `hashchange` guard check in `App.tsx`.
2. Secondary ambiguity: duplicate `admin` key in Settings page list (`Inventory` + `Admin`) can confuse expected protection targeting.
3. UX side effect: redirecting to fallback before/while modal can feel like prompt failed even when modal is open.

## 11. Minimal fix plan
1. In `App.tsx`, add a short-lived **bypass/pending unlock target ref/state** used by guard:
   - when passcode matches, set bypass target first,
   - then navigate hash,
   - guard should allow target if bypass matches, regardless of current `unlockIdentity` state for that transition.
2. Alternatively defer navigation until unlockIdentity commit is observed (effect on `unlockIdentity` + pending target).
3. Keep modal in-app (no browser prompt).
4. De-duplicate `APP_PAGES` key entries (`admin`) for clarity.

## 12. Risk areas
- HashRouter timing (synchronous hashchange vs async React state updates).
- Multiple `onHashChange` runs due to dependency on `lastAllowedPath`.
- Redirect loops when blocked page equals fallback path.
- Cloud/local hydration timing if `loadData()` not yet ready (less likely here).

## 13. Manual test plan
1. Set admin passcode `1234`, protect Finance.
2. Click Finance from Dashboard.
3. Enter `1234`; verify Finance opens first try.
4. Protect Settings; reload at `#/settings`.
5. Enter `1234`; verify Settings opens and no bounce loop.
6. Create role `sales/1111` allowed only `sales`.
7. Lock Access; open Sales with `1111` (should open).
8. Try Finance with `1111` (should show not-allowed), then `1234` (should open).
9. Verify no browser prompt appears.
10. Verify blank admin passcode + protected pages does not enforce lockout.
